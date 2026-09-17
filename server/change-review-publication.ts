import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { reviewFindingIdSchema } from "./change-review-report.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const REVIEW_REMOTE = "origin";
const PARENT_BASE_BRANCH = "main";
const REVIEW_BRANCH_SUFFIX = "-review";
const MAX_BRANCH_LENGTH = 512;
const MAX_PR_TITLE_LENGTH = 256;
const MAX_PR_BODY_LENGTH = 65_536;
const MAX_URL_LENGTH = 2_048;
const MAX_OPEN_PULL_REQUESTS = 100;
const FALLBACK_REVIEW_PR_TITLE = "Первичное ревью OpenSpec change";
const MAX_FINDING_SUMMARY_LENGTH = 500;
const FINDINGS_SECTION_START =
  "<!-- paseo-openspec-orchestrator:findings:start -->";
const FINDINGS_SECTION_END =
  "<!-- paseo-openspec-orchestrator:findings:end -->";
const FINDINGS_SECTION_HEADING = "## Результаты устранения замечаний";
const FINDING_MARKER_PREFIX = "<!-- paseo-openspec-orchestrator:finding:";
const FINDING_SUMMARY_CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const FINDING_SUMMARY_RUSSIAN_CHARACTER = /[А-Яа-яЁё]/u;
const RESERVED_FINDING_MARKER = "paseo-openspec-orchestrator:";

export const reviewBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Имя Git-ветки содержит небезопасные символы",
  )
  .refine(
    (value) =>
      value !== "@" &&
      value !== PARENT_BASE_BRANCH &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для review требуется безопасное имя non-main Git-ветки",
  );

const githubHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u,
    "Ожидалось безопасное доменное имя GitHub host",
  );

const repositoryNameWithOwnerSchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "Ожидалось имя GitHub-репозитория в формате owner/name",
  );

const httpsUrlSchema = z
  .string()
  .url()
  .max(MAX_URL_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", "Ожидался HTTPS URL");

const pullRequestNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const repositorySchema = z
  .object({
    nameWithOwner: repositoryNameWithOwnerSchema,
    url: httpsUrlSchema,
  })
  .strict();

const pullRequestSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    baseRefName: reviewBranchSchema.or(z.literal(PARENT_BASE_BRANCH)),
    headRefName: reviewBranchSchema,
    headRefOid: commitHashSchema,
    title: z.string().max(MAX_PR_TITLE_LENGTH),
    body: z.string().max(MAX_PR_BODY_LENGTH),
  })
  .strict();

const pullRequestListSchema = z.array(pullRequestSchema).max(MAX_OPEN_PULL_REQUESTS);

export const reviewFindingPublicationKindSchema = z.enum([
  "review",
  "implementation-review",
]);

export const reviewFindingOutcomeSchema = z.enum(["resolved", "accepted-risk"]);

export const findingCompletionSummarySchema = z
  .string()
  .max(MAX_FINDING_SUMMARY_LENGTH)
  .refine(
    (value) => !FINDING_SUMMARY_CONTROL_CHARACTER.test(value),
    "Краткое описание finding должно занимать одну строку без управляющих символов",
  )
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_FINDING_SUMMARY_LENGTH))
  .refine(
    (value) => FINDING_SUMMARY_RUSSIAN_CHARACTER.test(value),
    "Краткое описание finding должно быть на русском языке",
  )
  .refine(
    (value) =>
      !value.includes(RESERVED_FINDING_MARKER) &&
      !value.includes("<!--") &&
      !value.includes("-->"),
    "Краткое описание finding содержит служебный marker",
  );

export const findingCompletionInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("publish"),
      problem: findingCompletionSummarySchema,
      resolution: findingCompletionSummarySchema,
    })
    .strict(),
  z.object({ mode: z.literal("acknowledge-existing") }).strict(),
]);

export type ReviewFindingPublicationKind = z.infer<
  typeof reviewFindingPublicationKindSchema
>;
export type ReviewFindingOutcome = z.infer<typeof reviewFindingOutcomeSchema>;
export type FindingCompletionInput = z.infer<typeof findingCompletionInputSchema>;

export function parseFindingCompletionInput(input: unknown): FindingCompletionInput {
  return findingCompletionInputSchema.parse(input);
}

export const reviewPublicationTargetSchema = z
  .object({
    parentBranch: reviewBranchSchema,
    reviewBranch: reviewBranchSchema,
    baselineCommit: commitHashSchema,
    repositoryHost: githubHostSchema,
    repositoryNameWithOwner: repositoryNameWithOwnerSchema,
    repositoryUrl: httpsUrlSchema,
    parentPullRequestNumber: pullRequestNumberSchema,
  })
  .strict()
  .superRefine((target, context) => {
    if (target.reviewBranch !== `${target.parentBranch}${REVIEW_BRANCH_SUFFIX}`) {
      context.addIssue({
        code: "custom",
        path: ["reviewBranch"],
        message: "Review-ветка не соответствует сохранённой parent-ветке",
      });
    }
  });

export type ReviewPublicationTarget = z.infer<typeof reviewPublicationTargetSchema>;

export interface CompletedReviewPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export interface CompletedFindingPullRequest {
  readonly number: number;
  readonly url: string;
}

interface ActiveReviewPullRequestRequest {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly branch: string;
  readonly signal?: AbortSignal;
}

export interface ReviewFindingPublicationRequest
  extends ActiveReviewPullRequestRequest {
  readonly findingId: string;
  readonly baselineCommit: string;
  readonly kind: ReviewFindingPublicationKind;
  readonly expectedHead?: string;
  readonly expectedOutcome?: ReviewFindingOutcome;
}

export interface PublishReviewFindingRequest
  extends ReviewFindingPublicationRequest {
  readonly expectedHead: string;
  readonly outcome: ReviewFindingOutcome;
  readonly input: FindingCompletionInput;
}

export interface ReviewFindingPublicationState {
  readonly pullRequest: CompletedFindingPullRequest;
  readonly entryExists: boolean;
}

interface GitHubRemoteIdentity {
  readonly host: string;
  readonly nameWithOwner: string;
}

interface ResolvedRepository extends GitHubRemoteIdentity {
  readonly url: string;
}

export class ChangeReviewPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewPublicationError";
  }
}

export async function prepareReviewPublication(
  workspaceDirectory: string,
  parentBranch: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<ReviewPublicationTarget> {
  const parsedParent = parseBranch(parentBranch);
  await assertCleanWorktree(command, workspaceDirectory, signal);
  const [currentBranch, baselineCommit, repository] = await Promise.all([
    readCurrentBranch(command, workspaceDirectory, signal),
    readHeadCommit(command, workspaceDirectory, signal),
    resolveRepository(command, workspaceDirectory, signal),
  ]);
  if (currentBranch !== parsedParent) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка изменилась с «${parsedParent}» на «${currentBranch}»`,
    );
  }

  const remoteParent = await readRemoteCommit(
    command,
    workspaceDirectory,
    parsedParent,
    signal,
  );
  if (remoteParent !== baselineCommit) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит текущий HEAD ветки «${parsedParent}»`,
    );
  }

  const parentPullRequests = await listPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    parsedParent,
    "open",
    signal,
  );
  if (parentPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для предыдущей ветки «${parsedParent}» должен существовать ровно один открытый pull request`,
    );
  }
  const parentPullRequest = parentPullRequests[0]!;
  assertPullRequestRepository(parentPullRequest, repository.url);
  assertParentPullRequest(parentPullRequest, parsedParent, baselineCommit);

  const reviewBranch = deriveReviewBranch(parsedParent);
  if ((await readLocalBranchCommit(command, workspaceDirectory, reviewBranch, signal)) !== null) {
    throw new ChangeReviewPublicationError(
      `Локальная review-ветка «${reviewBranch}» уже существует`,
    );
  }
  if ((await readOptionalRemoteCommit(command, workspaceDirectory, reviewBranch, signal)) !== null) {
    throw new ChangeReviewPublicationError(
      `Review-ветка «${reviewBranch}» уже существует в Git remote origin`,
    );
  }
  const previousReviewPullRequests = await listPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    reviewBranch,
    "all",
    signal,
  );
  if (previousReviewPullRequests.length > 0) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${reviewBranch}» уже существует pull request`,
    );
  }

  return reviewPublicationTargetSchema.parse({
    parentBranch: parsedParent,
    reviewBranch,
    baselineCommit,
    repositoryHost: repository.host,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryUrl: repository.url,
    parentPullRequestNumber: parentPullRequest.number,
  });
}

export async function assertReviewPublicationRecovery(
  workspaceDirectory: string,
  targetInput: ReviewPublicationTarget,
  changeIdInput: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<void> {
  const target = reviewPublicationTargetSchema.parse(targetInput);
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  await assertCleanWorktree(command, workspaceDirectory, signal);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentBranch(command, workspaceDirectory, signal);
  if (currentBranch !== target.parentBranch && currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Для восстановления review требуется ветка «${target.parentBranch}» или «${target.reviewBranch}», активна «${currentBranch}»`,
    );
  }

  const localReviewHead = await readLocalBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (currentBranch === target.reviewBranch && localReviewHead === null) {
    throw new ChangeReviewPublicationError("Активная review-ветка отсутствует среди локальных refs");
  }
  if (localReviewHead !== null) {
    await assertDescendsFrom(
      command,
      workspaceDirectory,
      target.baselineCommit,
      localReviewHead,
      "Review-ветка больше не продолжает baseline предыдущей ветки",
      signal,
    );
  }

  const remoteReviewHead = await readOptionalRemoteCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (
    currentBranch === target.parentBranch &&
    (localReviewHead !== null || remoteReviewHead !== null)
  ) {
    throw new ChangeReviewPublicationError(
      "Сохранённая review-ветка существует, но не является текущей; автоматическое переключение запрещено",
    );
  }
  if (
    remoteReviewHead !== null &&
    remoteReviewHead !== target.baselineCommit &&
    remoteReviewHead !== localReviewHead
  ) {
    throw new ChangeReviewPublicationError(
      `Git remote origin содержит неожиданное состояние review-ветки «${target.reviewBranch}»`,
    );
  }

  const openReviewPullRequests = await listPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.reviewBranch,
    "open",
    signal,
  );
  if (openReviewPullRequests.length > 1) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${target.reviewBranch}» найдено несколько открытых pull request`,
    );
  }
  const existing = openReviewPullRequests[0];
  if (existing) {
    const pullRequest = await readPullRequest(
      command,
      workspaceDirectory,
      targetRepositoryArgument(target),
      existing.number,
      signal,
    );
    assertPullRequestRepository(pullRequest, target.repositoryUrl);
    if (
      pullRequest.state !== "OPEN" ||
      pullRequest.isDraft ||
      pullRequest.isCrossRepository ||
      pullRequest.headRefName !== target.reviewBranch ||
      pullRequest.baseRefName !== target.parentBranch ||
      pullRequest.headRefOid !== remoteReviewHead ||
      pullRequest.title !== reviewPullRequestTitle(changeId) ||
      pullRequest.body !== reviewPullRequestBody(changeId)
    ) {
      throw new ChangeReviewPublicationError(
        "Существующий review pull request не соответствует сохранённой Ready-публикации",
      );
    }
  } else {
    const previousPullRequests = await listPullRequests(
      command,
      workspaceDirectory,
      targetRepositoryArgument(target),
      target.reviewBranch,
      "all",
      signal,
    );
    if (previousPullRequests.length > 0) {
      throw new ChangeReviewPublicationError(
        "Созданный review pull request больше не открыт; автоматическое создание замены запрещено",
      );
    }
  }
}

export async function verifyReviewPullRequest(
  workspaceDirectory: string,
  targetInput: ReviewPublicationTarget,
  changeIdInput: string,
  expectedHead: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<CompletedReviewPullRequest> {
  const target = reviewPublicationTargetSchema.parse(targetInput);
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const head = commitHashSchema.parse(expectedHead);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentBranch(command, workspaceDirectory, signal);
  if (currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка должна быть review-веткой «${target.reviewBranch}»`,
    );
  }
  const remoteHead = await readRemoteCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (remoteHead !== head) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит текущий HEAD review-ветки «${target.reviewBranch}»`,
    );
  }

  const openPullRequests = await listPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.reviewBranch,
    "open",
    signal,
  );
  if (openPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${target.reviewBranch}» должен существовать ровно один открытый pull request`,
    );
  }
  const pullRequest = await readPullRequest(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    openPullRequests[0]!.number,
    signal,
  );
  assertPullRequestRepository(pullRequest, target.repositoryUrl);
  if (pullRequest.state !== "OPEN") {
    throw new ChangeReviewPublicationError("Review pull request должен быть открыт");
  }
  if (pullRequest.isDraft) {
    throw new ChangeReviewPublicationError("Review pull request должен быть Ready");
  }
  if (pullRequest.isCrossRepository) {
    throw new ChangeReviewPublicationError(
      "Review pull request должен использовать ветку из origin",
    );
  }
  if (
    pullRequest.baseRefName !== target.parentBranch ||
    pullRequest.headRefName !== target.reviewBranch ||
    pullRequest.headRefOid !== head
  ) {
    throw new ChangeReviewPublicationError(
      "Review pull request не соответствует сохранённым base/head refs",
    );
  }
  const expectedTitle = reviewPullRequestTitle(changeId);
  const expectedBody = reviewPullRequestBody(changeId);
  if (pullRequest.title !== expectedTitle || pullRequest.body !== expectedBody) {
    throw new ChangeReviewPublicationError(
      "Название или описание review pull request не совпадает с ожидаемым содержимым",
    );
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
  };
}

export async function inspectReviewFindingPublication(
  requestInput: ReviewFindingPublicationRequest,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<ReviewFindingPublicationState> {
  const request = parseReviewFindingPublicationRequest(requestInput);
  const inspected = await inspectActiveReviewPullRequest(request, command);
  if (
    request.expectedHead !== undefined &&
    inspected.remoteHead !== request.expectedHead
  ) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит commit устранения finding в ветке «${request.branch}»`,
    );
  }
  const entry = readPublishedFindingEntry(
    inspected.pullRequest.body,
    request,
  );
  if (entry && request.expectedOutcome !== undefined) {
    if (entry.outcome !== request.expectedOutcome) {
      throw new ChangeReviewPublicationError(
        "Статус результата finding в pull request не соответствует review-отчёту",
      );
    }
  }
  return {
    pullRequest: {
      number: inspected.pullRequest.number,
      url: inspected.pullRequest.url,
    },
    entryExists: entry !== null,
  };
}

export async function assertActiveReviewPullRequest(
  workspaceDirectory: string,
  changeId: string,
  branch: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<void> {
  const request = parseActiveReviewPullRequest({
    workspaceDirectory,
    changeId,
    branch,
    signal,
  });
  await inspectActiveReviewPullRequest(request, command);
}

export async function publishReviewFindingOutcome(
  requestInput: PublishReviewFindingRequest,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<CompletedFindingPullRequest> {
  const request = parsePublishReviewFindingRequest(requestInput);
  let inspected = await inspectActiveReviewPullRequest(request, command);
  if (inspected.remoteHead !== request.expectedHead) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит commit устранения finding в ветке «${request.branch}»`,
    );
  }

  const existingEntry = readPublishedFindingEntry(
    inspected.pullRequest.body,
    request,
  );
  if (existingEntry) {
    assertPublishedFindingOutcome(existingEntry, request);
    if (request.input.mode === "publish") {
      const expectedEntry = renderFindingEntry(request);
      if (existingEntry.source !== expectedEntry) {
        throw new ChangeReviewPublicationError(
          "Описание review pull request уже содержит другое резюме выбранной finding",
        );
      }
    }
    return {
      number: inspected.pullRequest.number,
      url: inspected.pullRequest.url,
    };
  }

  if (request.input.mode === "acknowledge-existing") {
    throw new ChangeReviewPublicationError(
      "Описание review pull request ещё не содержит результат выбранной finding",
    );
  }

  const entry = renderFindingEntry(request);
  const expectedBody = appendFindingEntry(inspected.pullRequest.body, entry);
  await editPullRequestBody(
    command,
    request.workspaceDirectory,
    inspected.repository,
    inspected.pullRequest.number,
    expectedBody,
    request.signal,
  );

  inspected = await inspectActiveReviewPullRequest(request, command);
  if (
    inspected.remoteHead !== request.expectedHead ||
    inspected.pullRequest.body !== expectedBody
  ) {
    throw new ChangeReviewPublicationError(
      "Описание review pull request изменилось или не сохранилось после публикации finding",
    );
  }
  const publishedEntry = readPublishedFindingEntry(
    inspected.pullRequest.body,
    request,
  );
  if (!publishedEntry || publishedEntry.source !== entry) {
    throw new ChangeReviewPublicationError(
      "Review pull request не содержит опубликованный результат выбранной finding",
    );
  }
  assertPublishedFindingOutcome(publishedEntry, request);
  return {
    number: inspected.pullRequest.number,
    url: inspected.pullRequest.url,
  };
}

export function reviewPullRequestTitle(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const detailed = `Первичное ревью OpenSpec change «${changeId}»`;
  return detailed.length <= MAX_PR_TITLE_LENGTH ? detailed : FALLBACK_REVIEW_PR_TITLE;
}

export function reviewPullRequestBody(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  return `Первичное ревью артефактов OpenSpec change \`${changeId}\`.`;
}

interface InspectedActiveReviewPullRequest {
  readonly repository: ResolvedRepository;
  readonly remoteHead: string;
  readonly pullRequest: z.output<typeof pullRequestSchema>;
}

interface FindingsSection {
  readonly start: number;
  readonly end: number;
}

interface PublishedFindingEntry {
  readonly outcome: ReviewFindingOutcome;
  readonly problem: string;
  readonly resolution: string;
  readonly source: string;
}

function parseReviewFindingPublicationRequest(
  request: ReviewFindingPublicationRequest,
): ReviewFindingPublicationRequest {
  return {
    ...parseActiveReviewPullRequest(request),
    findingId: reviewFindingIdSchema.parse(request.findingId),
    baselineCommit: commitHashSchema.parse(request.baselineCommit),
    kind: reviewFindingPublicationKindSchema.parse(request.kind),
    expectedHead: request.expectedHead === undefined
      ? undefined
      : commitHashSchema.parse(request.expectedHead),
    expectedOutcome: request.expectedOutcome === undefined
      ? undefined
      : reviewFindingOutcomeSchema.parse(request.expectedOutcome),
  };
}

function parseActiveReviewPullRequest(
  request: ActiveReviewPullRequestRequest,
): ActiveReviewPullRequestRequest {
  return {
    workspaceDirectory: z.string().trim().min(1).max(8_192).parse(
      request.workspaceDirectory,
    ),
    changeId: openSpecChangeIdSchema.parse(request.changeId),
    branch: reviewBranchSchema.parse(request.branch),
    signal: request.signal,
  };
}

function parsePublishReviewFindingRequest(
  request: PublishReviewFindingRequest,
): PublishReviewFindingRequest {
  return {
    ...parseReviewFindingPublicationRequest(request),
    expectedHead: commitHashSchema.parse(request.expectedHead),
    outcome: reviewFindingOutcomeSchema.parse(request.outcome),
    input: parseFindingCompletionInput(request.input),
  };
}

async function inspectActiveReviewPullRequest(
  request: ActiveReviewPullRequestRequest,
  command: BoundedCommandRunner,
): Promise<InspectedActiveReviewPullRequest> {
  const repository = await resolveRepository(
    command,
    request.workspaceDirectory,
    request.signal,
  );
  const remoteHead = await readRemoteCommit(
    command,
    request.workspaceDirectory,
    request.branch,
    request.signal,
  );
  const repositoryName = repositoryArgument(repository);
  const openPullRequests = await listPullRequests(
    command,
    request.workspaceDirectory,
    repositoryName,
    request.branch,
    "open",
    request.signal,
  );
  if (openPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${request.branch}» должен существовать ровно один открытый pull request`,
    );
  }
  const pullRequest = await readPullRequest(
    command,
    request.workspaceDirectory,
    repositoryName,
    openPullRequests[0]!.number,
    request.signal,
  );
  assertPullRequestRepository(pullRequest, repository.url);
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isDraft ||
    pullRequest.isCrossRepository ||
    pullRequest.headRefName !== request.branch ||
    pullRequest.baseRefName === PARENT_BASE_BRANCH ||
    request.branch !== `${pullRequest.baseRefName}${REVIEW_BRANCH_SUFFIX}` ||
    pullRequest.headRefOid !== remoteHead ||
    pullRequest.title !== reviewPullRequestTitle(request.changeId)
  ) {
    throw new ChangeReviewPublicationError(
      "Review pull request выбранной ветки не соответствует опубликованной цепочке PR",
    );
  }
  readFindingsSection(pullRequest.body);
  return { repository, remoteHead, pullRequest };
}

function readFindingsSection(body: string): FindingsSection | null {
  const start = body.indexOf(FINDINGS_SECTION_START);
  const end = body.indexOf(FINDINGS_SECTION_END);
  if (start === -1 && end === -1) {
    if (body.includes(FINDING_MARKER_PREFIX)) {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит finding marker вне управляемой секции",
      );
    }
    return null;
  }
  if (
    start === -1 ||
    end === -1 ||
    start !== body.lastIndexOf(FINDINGS_SECTION_START) ||
    end !== body.lastIndexOf(FINDINGS_SECTION_END) ||
    start >= end
  ) {
    throw new ChangeReviewPublicationError(
      "Описание review pull request содержит повреждённую секцию результатов findings",
    );
  }
  const expectedPrefix = `${FINDINGS_SECTION_START}\n${FINDINGS_SECTION_HEADING}\n\n`;
  if (!body.startsWith(expectedPrefix, start) || body[end - 1] !== "\n") {
    throw new ChangeReviewPublicationError(
      "Описание review pull request содержит неизвестный формат секции findings",
    );
  }
  validateManagedFindingEntries(
    body.slice(start + expectedPrefix.length, end - 1),
  );
  let marker = body.indexOf(FINDING_MARKER_PREFIX);
  while (marker !== -1) {
    if (marker < start || marker >= end) {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит finding marker вне управляемой секции",
      );
    }
    marker = body.indexOf(FINDING_MARKER_PREFIX, marker + FINDING_MARKER_PREFIX.length);
  }
  return { start, end };
}

function validateManagedFindingEntries(source: string): void {
  const entries = source.split("\n\n");
  const markers = new Set<string>();
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new ChangeReviewPublicationError(
      "Описание review pull request содержит пустую запись finding",
    );
  }
  for (const entry of entries) {
    const lines = entry.split("\n");
    const header = /^- \*\*(OpenSpec review|OpenSpec implementation review) `(F[1-9][0-9]*)` — (исправлено|риск принят)\*\*$/u.exec(
      lines[0] ?? "",
    );
    const marker = /^  <!-- paseo-openspec-orchestrator:finding:(review|implementation-review):(F[1-9][0-9]*):([0-9a-f]{40,64}) -->$/u.exec(
      lines[3] ?? "",
    );
    if (
      lines.length !== 4 ||
      !header?.[1] ||
      !header[2] ||
      !header[3] ||
      !marker?.[1] ||
      !marker[2] ||
      !marker[3]
    ) {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит повреждённую запись finding",
      );
    }
    const expectedLabel = marker[1] === "review"
      ? "OpenSpec review"
      : "OpenSpec implementation review";
    const outcomePrefix = header[3] === "исправлено"
      ? "  - **Итог:** Исправлено: "
      : "  - **Итог:** Риск принят: ";
    if (
      header[1] !== expectedLabel ||
      header[2] !== marker[2] ||
      !lines[1]?.startsWith("  - **Проблема:** ") ||
      !lines[2]?.startsWith(outcomePrefix)
    ) {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит несогласованную запись finding",
      );
    }
    try {
      reviewFindingIdSchema.parse(header[2]);
      commitHashSchema.parse(marker[3]);
      findingCompletionSummarySchema.parse(
        lines[1].slice("  - **Проблема:** ".length),
      );
      findingCompletionSummarySchema.parse(lines[2].slice(outcomePrefix.length));
    } catch {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит некорректную запись finding",
      );
    }
    const markerSource = lines[3];
    if (markers.has(markerSource)) {
      throw new ChangeReviewPublicationError(
        "Описание review pull request содержит дублированный результат finding",
      );
    }
    markers.add(markerSource);
  }
}

function readPublishedFindingEntry(
  body: string,
  request: ReviewFindingPublicationRequest,
): PublishedFindingEntry | null {
  const marker = findingMarker(request);
  const markerLine = `  ${marker}`;
  const markerIndex = body.indexOf(markerLine);
  if (markerIndex === -1) return null;
  if (markerIndex !== body.lastIndexOf(markerLine)) {
    throw new ChangeReviewPublicationError(
      "Описание review pull request содержит дублированный результат finding",
    );
  }
  const section = readFindingsSection(body);
  if (!section || markerIndex < section.start || markerIndex >= section.end) {
    throw new ChangeReviewPublicationError(
      "Результат finding находится вне управляемой секции pull request",
    );
  }

  const lines = body.split("\n");
  const markerLineIndex = lines.findIndex((line) => line === markerLine);
  if (markerLineIndex < 3) {
    throw new ChangeReviewPublicationError(
      "Описание результата finding в pull request повреждено",
    );
  }
  const sourceLabel = findingSourceLabel(request.kind);
  const header = lines[markerLineIndex - 3];
  const resolvedHeader = `- **${sourceLabel} \`${request.findingId}\` — исправлено**`;
  const acceptedRiskHeader =
    `- **${sourceLabel} \`${request.findingId}\` — риск принят**`;
  const outcome: ReviewFindingOutcome = header === resolvedHeader
    ? "resolved"
    : header === acceptedRiskHeader
      ? "accepted-risk"
      : (() => {
          throw new ChangeReviewPublicationError(
            "Описание результата finding содержит неверный источник или статус",
          );
        })();
  const problemPrefix = "  - **Проблема:** ";
  const outcomePrefix = outcome === "resolved"
    ? "  - **Итог:** Исправлено: "
    : "  - **Итог:** Риск принят: ";
  const problemLine = lines[markerLineIndex - 2] ?? "";
  const resolutionLine = lines[markerLineIndex - 1] ?? "";
  if (
    !problemLine.startsWith(problemPrefix) ||
    !resolutionLine.startsWith(outcomePrefix)
  ) {
    throw new ChangeReviewPublicationError(
      "Описание результата finding не содержит проблему и итог ожидаемого формата",
    );
  }
  let problem: string;
  let resolution: string;
  try {
    problem = findingCompletionSummarySchema.parse(problemLine.slice(problemPrefix.length));
    resolution = findingCompletionSummarySchema.parse(
      resolutionLine.slice(outcomePrefix.length),
    );
  } catch {
    throw new ChangeReviewPublicationError(
      "Краткое описание проблемы или итога finding некорректно",
    );
  }
  return {
    outcome,
    problem,
    resolution,
    source: lines.slice(markerLineIndex - 3, markerLineIndex + 1).join("\n"),
  };
}

function assertPublishedFindingOutcome(
  entry: PublishedFindingEntry,
  request: PublishReviewFindingRequest,
): void {
  if (entry.outcome !== request.outcome) {
    throw new ChangeReviewPublicationError(
      "Статус результата finding в pull request не соответствует review-отчёту",
    );
  }
}

function renderFindingEntry(request: PublishReviewFindingRequest): string {
  if (request.input.mode !== "publish") {
    throw new ChangeReviewPublicationError(
      "Для новой записи finding требуются краткие проблема и итог",
    );
  }
  const sourceLabel = findingSourceLabel(request.kind);
  const status = request.outcome === "resolved" ? "исправлено" : "риск принят";
  const outcomePrefix = request.outcome === "resolved" ? "Исправлено" : "Риск принят";
  return `- **${sourceLabel} \`${request.findingId}\` — ${status}**
  - **Проблема:** ${request.input.problem}
  - **Итог:** ${outcomePrefix}: ${request.input.resolution}
  ${findingMarker(request)}`;
}

function appendFindingEntry(body: string, entry: string): string {
  const section = readFindingsSection(body);
  let updated: string;
  if (!section) {
    const separator = body.length === 0
      ? ""
      : body.endsWith("\n\n")
        ? ""
        : body.endsWith("\n")
          ? "\n"
          : "\n\n";
    updated = `${body}${separator}${FINDINGS_SECTION_START}\n${FINDINGS_SECTION_HEADING}\n\n${entry}\n${FINDINGS_SECTION_END}`;
  } else {
    const beforeEnd = body.slice(0, section.end);
    const separator = beforeEnd.endsWith("\n\n")
      ? ""
      : beforeEnd.endsWith("\n")
        ? "\n"
        : "\n\n";
    updated = `${beforeEnd}${separator}${entry}\n${body.slice(section.end)}`;
  }
  if (updated.length > MAX_PR_BODY_LENGTH) {
    throw new ChangeReviewPublicationError(
      `Описание review pull request превышает предел ${MAX_PR_BODY_LENGTH} символов`,
    );
  }
  return updated;
}

async function editPullRequestBody(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: ResolvedRepository,
  pullRequestNumber: number,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  let temporaryDirectory: string | null = null;
  try {
    const [workspaceRealPath, temporaryRootRealPath] = await Promise.all([
      realpath(workspaceDirectory),
      realpath(tmpdir()),
    ]);
    const temporaryRootFromWorkspace = relative(
      workspaceRealPath,
      temporaryRootRealPath,
    );
    if (
      temporaryRootFromWorkspace === "" ||
      (temporaryRootFromWorkspace !== ".." &&
        !temporaryRootFromWorkspace.startsWith(`..${sep}`) &&
        !isAbsolute(temporaryRootFromWorkspace))
    ) {
      throw new ChangeReviewPublicationError(
        "Системный каталог временных файлов находится внутри Git workspace",
      );
    }
    temporaryDirectory = await mkdtemp(
      join(temporaryRootRealPath, "paseo-openspec-pr-body-"),
    );
    const bodyPath = join(temporaryDirectory, "body.md");
    await writeFile(bodyPath, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // Официальный gh CLI читает новое описание через --body-file:
    // https://cli.github.com/manual/gh_pr_edit
    await command(
      "gh",
      [
        "pr",
        "edit",
        String(pullRequestNumber),
        "--repo",
        repositoryArgument(repository),
        "--body-file",
        bodyPath,
      ],
      { cwd: workspaceDirectory, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось обновить описание review pull request #${pullRequestNumber}`,
    );
  } finally {
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ChangeReviewPublicationError(
          "Не удалось очистить временный файл описания review pull request",
        );
      }
    }
  }
}

function findingSourceLabel(kind: ReviewFindingPublicationKind): string {
  return kind === "review" ? "OpenSpec review" : "OpenSpec implementation review";
}

function findingMarker(request: ReviewFindingPublicationRequest): string {
  return `${FINDING_MARKER_PREFIX}${request.kind}:${request.findingId}:${request.baselineCommit} -->`;
}

function deriveReviewBranch(parentBranch: string): string {
  const parsedParent = parseBranch(parentBranch);
  const parsedReview = reviewBranchSchema.safeParse(
    `${parsedParent}${REVIEW_BRANCH_SUFFIX}`,
  );
  if (!parsedReview.success) {
    throw new ChangeReviewPublicationError(
      `Не удалось получить безопасное имя review-ветки из «${parsedParent}»`,
    );
  }
  return parsedReview.data;
}

async function assertParentPublication(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  target: ReviewPublicationTarget,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveRepository(command, workspaceDirectory, signal);
  if (
    repository.host !== target.repositoryHost ||
    repository.nameWithOwner.toLowerCase() !==
      target.repositoryNameWithOwner.toLowerCase() ||
    repository.url !== target.repositoryUrl
  ) {
    throw new ChangeReviewPublicationError(
      "Git remote origin больше не соответствует сохранённому GitHub-репозиторию",
    );
  }

  const [localParent, remoteParent] = await Promise.all([
    readLocalBranchCommit(command, workspaceDirectory, target.parentBranch, signal),
    readRemoteCommit(command, workspaceDirectory, target.parentBranch, signal),
  ]);
  if (
    localParent !== target.baselineCommit ||
    remoteParent !== target.baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Предыдущая ветка «${target.parentBranch}» изменилась после начала review`,
    );
  }

  const openParentPullRequests = await listPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.parentBranch,
    "open",
    signal,
  );
  if (
    openParentPullRequests.length !== 1 ||
    openParentPullRequests[0]!.number !== target.parentPullRequestNumber
  ) {
    throw new ChangeReviewPublicationError(
      "Открытый pull request предыдущей ветки изменился после начала review",
    );
  }
  const parentPullRequest = await readPullRequest(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.parentPullRequestNumber,
    signal,
  );
  assertPullRequestRepository(parentPullRequest, target.repositoryUrl);
  assertParentPullRequest(
    parentPullRequest,
    target.parentBranch,
    target.baselineCommit,
  );
}

function assertParentPullRequest(
  pullRequest: z.output<typeof pullRequestSchema>,
  parentBranch: string,
  baselineCommit: string,
): void {
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isCrossRepository ||
    pullRequest.baseRefName !== PARENT_BASE_BRANCH ||
    pullRequest.headRefName !== parentBranch ||
    pullRequest.headRefOid !== baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Pull request предыдущей ветки должен быть открыт из «${parentBranch}» в «${PARENT_BASE_BRANCH}» и содержать её текущий HEAD`,
    );
  }
}

async function resolveRepository(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<ResolvedRepository> {
  let originUrl: string;
  try {
    const result = await command("git", ["remote", "get-url", REVIEW_REMOTE], {
      cwd: workspaceDirectory,
      signal,
    });
    originUrl = result.stdout.trim();
    if (!originUrl) throw new Error("Пустой URL origin");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin отсутствует или недоступен",
    );
  }

  const remote = parseGitHubRemote(originUrl);
  try {
    await command("gh", ["auth", "status", "--hostname", remote.host], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `GitHub CLI недоступен или не авторизован для origin host «${remote.host}»`,
    );
  }

  const argument = repositoryArgument(remote);
  let repository: z.output<typeof repositorySchema>;
  try {
    const result = await command(
      "gh",
      ["repo", "view", argument, "--json", "nameWithOwner,url"],
      { cwd: workspaceDirectory, signal },
    );
    repository = repositorySchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin не разрешается в доступный GitHub-репозиторий",
    );
  }
  if (
    new URL(repository.url).hostname.toLowerCase() !== remote.host ||
    repository.nameWithOwner.toLowerCase() !== remote.nameWithOwner.toLowerCase()
  ) {
    throw new ChangeReviewPublicationError(
      "GitHub CLI разрешил другой репозиторий вместо Git remote origin",
    );
  }
  return { ...remote, url: repository.url };
}

async function listPullRequests(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  branch: string,
  state: "open" | "all",
  signal?: AbortSignal,
): Promise<readonly z.output<typeof pullRequestSchema>[]> {
  try {
    // Официальный gh CLI поддерживает фильтр --head и ограниченный --json output:
    // https://cli.github.com/manual/gh_pr_list
    const result = await command(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        state,
        "--limit",
        String(MAX_OPEN_PULL_REQUESTS),
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestListSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось получить pull request ветки «${branch}»`,
    );
  }
}

async function readPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<z.output<typeof pullRequestSchema>> {
  try {
    // Повторное чтение PR выполняется документированной командой gh:
    // https://cli.github.com/manual/gh_pr_view
    const result = await command(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать pull request #${number}`,
    );
  }
}

async function assertCleanWorktree(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length > 0) {
      throw new ChangeReviewPublicationError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

async function readCurrentBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: workspaceDirectory,
      signal,
    });
    return reviewBranchSchema.parse(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось подтвердить текущую Git-ветку");
  }
}

async function readHeadCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось определить текущий Git HEAD");
  }
}

async function readLocalBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = `refs/heads/${parseBranch(branch)}`;
  try {
    const result = await command(
      "git",
      ["for-each-ref", "--format=%(objectname)%00%(refname)", ref],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length === 0) return null;
    const [hash, reportedRef, extra] = result.stdout.trimEnd().split("\0");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный local ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать локальную ветку «${branch}»`,
    );
  }
}

async function readRemoteCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await readOptionalRemoteCommit(
    command,
    workspaceDirectory,
    branch,
    signal,
  );
  if (commit === null) {
    throw new ChangeReviewPublicationError(
      `Ветка «${branch}» отсутствует в Git remote origin`,
    );
  }
  return commit;
}

async function readOptionalRemoteCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsedBranch = parseBranch(branch);
  const ref = `refs/heads/${parsedBranch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--heads", REVIEW_REMOTE, ref],
      { cwd: workspaceDirectory, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]!.split("\t");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный remote ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать ветку «${parsedBranch}» в Git remote origin`,
    );
  }
}

async function assertDescendsFrom(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  ancestor: string,
  descendant: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(message);
  }
}

function assertPullRequestRepository(
  pullRequest: { readonly number: number; readonly url: string },
  repositoryUrl: string,
): void {
  const expectedUrl = `${repositoryUrl.replace(/\/$/u, "")}/pull/${pullRequest.number}`;
  if (pullRequest.url !== expectedUrl) {
    throw new ChangeReviewPublicationError(
      `Pull request #${pullRequest.number} принадлежит другому GitHub-репозиторию`,
    );
  }
}

function parseGitHubRemote(remoteUrl: string): GitHubRemoteIdentity {
  let host: string;
  let repositoryPath: string;
  try {
    const url = new URL(remoteUrl);
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname) {
      throw new Error("Неподдерживаемый URL");
    }
    host = githubHostSchema.parse(url.hostname);
    repositoryPath = url.pathname.replace(/^\/+|\/+$/gu, "");
  } catch {
    const match = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/u.exec(remoteUrl);
    if (!match?.[1] || !match[2]) {
      throw new ChangeReviewPublicationError(
        "Git remote origin должен указывать на GitHub",
      );
    }
    const parsedHost = githubHostSchema.safeParse(match[1]);
    if (!parsedHost.success) {
      throw new ChangeReviewPublicationError(
        "Git remote origin содержит недопустимый host",
      );
    }
    host = parsedHost.data;
    repositoryPath = match[2].replace(/^\/+|\/+$/gu, "");
  }

  const nameWithOwner = repositoryNameWithOwnerSchema.safeParse(
    repositoryPath.replace(/\.git$/u, ""),
  );
  if (!nameWithOwner.success) {
    throw new ChangeReviewPublicationError(
      "Git remote origin должен указывать на GitHub-репозиторий owner/name",
    );
  }
  return { host, nameWithOwner: nameWithOwner.data };
}

function repositoryArgument(repository: GitHubRemoteIdentity): string {
  return repository.host === "github.com"
    ? repository.nameWithOwner
    : `${repository.host}/${repository.nameWithOwner}`;
}

function targetRepositoryArgument(target: ReviewPublicationTarget): string {
  return repositoryArgument({
    host: target.repositoryHost,
    nameWithOwner: target.repositoryNameWithOwner,
  });
}

function parseBranch(branch: string): string {
  const parsed = reviewBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ChangeReviewPublicationError(
      "Для review требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}
