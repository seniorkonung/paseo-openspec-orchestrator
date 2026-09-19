import { z } from "zod";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { reviewFindingIdSchema } from "./change-review-report.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  changeBranchFor,
  implementationBranchFor,
  implementationBranchSchema,
  planningBranchFor,
  planningBranchSchema,
} from "./change-branch.ts";
import { implementationPullRequestTitle } from "./implementation-publication.ts";
import {
  listReviewPullRequests,
  readRemoteReviewBranchCommit,
  readReviewPullRequest,
  resolveReviewRepository,
  updateReviewPullRequestBody,
} from "./review-publication-gateway.ts";
import {
  ChangeReviewPublicationError,
  MAX_REVIEW_PR_BODY_LENGTH,
  assertPullRequestRepository,
  repositoryArgument,
  reviewPullRequestTitle,
  type ResolvedReviewRepository,
  type ReviewPullRequest,
} from "./review-publication-model.ts";

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

interface InspectedActiveReviewPullRequest {
  readonly repository: ResolvedReviewRepository;
  readonly remoteHead: string;
  readonly pullRequest: ReviewPullRequest;
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

export function parseFindingCompletionInput(input: unknown): FindingCompletionInput {
  return findingCompletionInputSchema.parse(input);
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
  const entry = readPublishedFindingEntry(inspected.pullRequest.body, request);
  if (
    entry &&
    request.expectedOutcome !== undefined &&
    entry.outcome !== request.expectedOutcome
  ) {
    throw new ChangeReviewPublicationError(
      "Статус результата finding в pull request не соответствует review-отчёту",
    );
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
  await updateReviewPullRequestBody(
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
    branch: z.union([planningBranchSchema, implementationBranchSchema]).parse(request.branch),
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
  const repository = await resolveReviewRepository(
    command,
    request.workspaceDirectory,
    request.signal,
  );
  const remoteHead = await readRemoteReviewBranchCommit(
    command,
    request.workspaceDirectory,
    request.branch,
    request.signal,
  );
  const openPullRequests = await listReviewPullRequests(
    command,
    request.workspaceDirectory,
    repositoryArgument(repository),
    request.branch,
    "open",
    request.signal,
  );
  if (openPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${request.branch}» должен существовать ровно один открытый pull request`,
    );
  }
  const pullRequest = await readReviewPullRequest(
    command,
    request.workspaceDirectory,
    repositoryArgument(repository),
    openPullRequests[0]!.number,
    request.signal,
  );
  assertPullRequestRepository(pullRequest, repository.url);
  const planningTarget = request.branch === planningBranchFor(request.changeId);
  const implementationTarget =
    request.branch === implementationBranchFor(request.changeId);
  const expectedTitle = planningTarget
    ? reviewPullRequestTitle(request.changeId)
    : implementationPullRequestTitle(request.changeId);
  if (
    pullRequest.state !== "OPEN" ||
    (planningTarget ? pullRequest.isDraft : !pullRequest.isDraft) ||
    pullRequest.isCrossRepository ||
    pullRequest.headRefName !== request.branch ||
    (!planningTarget && !implementationTarget) ||
    pullRequest.baseRefName !== changeBranchFor(request.changeId) ||
    pullRequest.headRefOid !== remoteHead ||
    pullRequest.title !== expectedTitle
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
  if (updated.length > MAX_REVIEW_PR_BODY_LENGTH) {
    throw new ChangeReviewPublicationError(
      `Описание review pull request превышает предел ${MAX_REVIEW_PR_BODY_LENGTH} символов`,
    );
  }
  return updated;
}

function findingSourceLabel(kind: ReviewFindingPublicationKind): string {
  return kind === "review" ? "OpenSpec review" : "OpenSpec implementation review";
}

function findingMarker(request: ReviewFindingPublicationRequest): string {
  return `${FINDING_MARKER_PREFIX}${request.kind}:${request.findingId}:${request.baselineCommit} -->`;
}
