import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import type { ImplementationRun } from "./implementation-run-model.ts";
import {
  listReviewPullRequests,
  readReviewPullRequest,
  updateReviewPullRequestBody,
} from "./review-publication-gateway.ts";
import {
  ChangeReviewPublicationError,
  MAX_REVIEW_PR_BODY_LENGTH,
  assertPullRequestRepository,
  repositoryArgument,
  type ReviewPullRequest,
} from "./review-publication-model.ts";

export const IMPLEMENTATION_SUMMARY_START =
  "<!-- paseo-openspec-orchestrator:implementation-summary:start -->";
export const IMPLEMENTATION_SUMMARY_END =
  "<!-- paseo-openspec-orchestrator:implementation-summary:end -->";
const IMPLEMENTATION_SUMMARY_MARKER_PREFIX =
  "<!-- paseo-openspec-orchestrator:implementation-summary:";
const FINDINGS_START = "<!-- paseo-openspec-orchestrator:findings:start -->";
const FINDINGS_END = "<!-- paseo-openspec-orchestrator:findings:end -->";

const FALLBACK_TITLE = "Реализация OpenSpec change";

export function implementationPullRequestTitle(changeId: string): string {
  const detailed = `Реализация OpenSpec change «${changeId}»`;
  return detailed.length <= 256 ? detailed : FALLBACK_TITLE;
}

export function renderImplementationSummary(run: ImplementationRun): string {
  const tasks = run.batch.kind === "empty" ? [] : run.batch.tasks;
  const lines = tasks.map(
    ({ taskNumber, commit }) => `- Задача \`${taskNumber}\` — \`${commit}\``,
  );
  const deliveryHead = run.lastDeliveryHead ?? "не установлен";
  return `${IMPLEMENTATION_SUMMARY_START}
## Сводка реализации

OpenSpec change \`${run.changeId}\` реализуется в едином pull request.

### Последний проверенный пакет

${lines.length > 0 ? lines.join("\n") : "- Новые task-коммиты отсутствуют."}

- Root baseline: \`${run.rootBaselineCommit}\`
- Последний проверенный delivery head: \`${deliveryHead}\`
- Полный проверенный диапазон: \`${run.rootBaselineCommit}..${deliveryHead}\`
${IMPLEMENTATION_SUMMARY_END}`;
}

export function replaceImplementationSummary(body: string, summary: string): string {
  assertManagedMarkers(body);
  const start = body.indexOf(IMPLEMENTATION_SUMMARY_START);
  const end = body.indexOf(IMPLEMENTATION_SUMMARY_END);
  let updated: string;
  if (start === -1 && end === -1) {
    const separator = body.length === 0 ? "" : body.endsWith("\n\n") ? "" : "\n\n";
    updated = `${summary}${separator}${body}`;
  } else {
    if (
      start === -1 ||
      end === -1 ||
      start !== body.lastIndexOf(IMPLEMENTATION_SUMMARY_START) ||
      end !== body.lastIndexOf(IMPLEMENTATION_SUMMARY_END) ||
      start >= end
    ) {
      throw new ChangeReviewPublicationError(
        "Описание implementation PR содержит повреждённый служебный блок сводки",
      );
    }
    const endOffset = end + IMPLEMENTATION_SUMMARY_END.length;
    updated = `${body.slice(0, start)}${summary}${body.slice(endOffset)}`;
  }
  if (updated.length > MAX_REVIEW_PR_BODY_LENGTH) {
    throw new ChangeReviewPublicationError(
      `Описание implementation PR превышает предел ${MAX_REVIEW_PR_BODY_LENGTH} символов`,
    );
  }
  return updated;
}

function assertManagedMarkers(body: string): void {
  let summaryMarkers = 0;
  let marker = body.indexOf(IMPLEMENTATION_SUMMARY_MARKER_PREFIX);
  while (marker !== -1) {
    const end = body.indexOf(" -->", marker);
    const source = end === -1 ? "" : body.slice(marker, end + " -->".length);
    if (source !== IMPLEMENTATION_SUMMARY_START && source !== IMPLEMENTATION_SUMMARY_END) {
      throw new ChangeReviewPublicationError(
        "Описание implementation PR содержит неизвестный marker сводки",
      );
    }
    summaryMarkers += 1;
    marker = body.indexOf(IMPLEMENTATION_SUMMARY_MARKER_PREFIX, marker + 1);
  }
  if (summaryMarkers !== 0 && summaryMarkers !== 2) {
    throw new ChangeReviewPublicationError(
      "Описание implementation PR содержит повреждённые markers сводки",
    );
  }
  const findingsStart = body.indexOf(FINDINGS_START);
  const findingsEnd = body.indexOf(FINDINGS_END);
  if (
    (findingsStart === -1) !== (findingsEnd === -1) ||
    (findingsStart !== -1 &&
      (findingsStart !== body.lastIndexOf(FINDINGS_START) ||
        findingsEnd !== body.lastIndexOf(FINDINGS_END) ||
        findingsStart >= findingsEnd))
  ) {
    throw new ChangeReviewPublicationError(
      "Описание implementation PR содержит повреждённые markers findings",
    );
  }
}

export async function reconcileDraftImplementationPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  run: ImplementationRun,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<ReviewPullRequest> {
  const repository = repositoryArgument(run.repository);
  let open = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repository,
    run.implementationBranch,
    "open",
    signal,
  );
  if (open.length === 0) {
    if (run.publication.kind !== "unpublished") {
      throw new ChangeReviewPublicationError(
        "Сохранённый implementation pull request больше не открыт",
      );
    }
    const historical = await listReviewPullRequests(
      command,
      workspaceDirectory,
      repository,
      run.implementationBranch,
      "all",
      signal,
    );
    if (historical.length > 0) {
      throw new ChangeReviewPublicationError(
        "Для implementation-ветки уже существует исторический pull request",
      );
    }
    await createDraftPullRequest(command, workspaceDirectory, run, signal);
    open = await listReviewPullRequests(
      command,
      workspaceDirectory,
      repository,
      run.implementationBranch,
      "open",
      signal,
    );
  }
  if (open.length !== 1) {
    throw new ChangeReviewPublicationError(
      "Для implementation-ветки должен существовать ровно один открытый pull request",
    );
  }
  let pullRequest = await readReviewPullRequest(
    command,
    workspaceDirectory,
    repository,
    open[0]!.number,
    signal,
  );
  assertImplementationPullRequest(pullRequest, run, expectedHead, true);
  if (
    run.publication.kind !== "unpublished" &&
    pullRequest.number !== run.publication.number
  ) {
    throw new ChangeReviewPublicationError(
      "Открытый implementation pull request не совпадает с сохранённым",
    );
  }
  const expectedBody = replaceImplementationSummary(
    pullRequest.body,
    renderImplementationSummary({ ...run, lastDeliveryHead: expectedHead }),
  );
  if (expectedBody !== pullRequest.body) {
    await updateReviewPullRequestBody(
      command,
      workspaceDirectory,
      run.repository,
      pullRequest.number,
      expectedBody,
      signal,
    );
    pullRequest = await readReviewPullRequest(
      command,
      workspaceDirectory,
      repository,
      pullRequest.number,
      signal,
    );
    assertImplementationPullRequest(pullRequest, run, expectedHead, true);
    if (pullRequest.body !== expectedBody) {
      throw new ChangeReviewPublicationError(
        "Служебная сводка implementation pull request не сохранилась",
      );
    }
  }
  return pullRequest;
}

export function assertImplementationPullRequest(
  pullRequest: ReviewPullRequest,
  run: ImplementationRun,
  expectedHead: string,
  mustBeDraft: boolean,
): void {
  assertPullRequestRepository(pullRequest, run.repository.url);
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isCrossRepository ||
    pullRequest.baseRefName !== run.changeBranch ||
    pullRequest.headRefName !== run.implementationBranch ||
    pullRequest.headRefOid !== expectedHead ||
    pullRequest.title !== implementationPullRequestTitle(run.changeId) ||
    (mustBeDraft && !pullRequest.isDraft)
  ) {
    throw new ChangeReviewPublicationError(
      `Implementation PR должен быть ${mustBeDraft ? "Draft " : ""}из «${run.implementationBranch}» в «${run.changeBranch}» и содержать точный remote HEAD`,
    );
  }
}

async function createDraftPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  run: ImplementationRun,
  signal?: AbortSignal,
): Promise<void> {
  let temporaryDirectory: string | null = null;
  try {
    const [workspaceRealPath, temporaryRootRealPath] = await Promise.all([
      realpath(workspaceDirectory),
      realpath(tmpdir()),
    ]);
    const relativeTemporaryRoot = relative(workspaceRealPath, temporaryRootRealPath);
    if (
      relativeTemporaryRoot === "" ||
      (relativeTemporaryRoot !== ".." &&
        !relativeTemporaryRoot.startsWith(`..${sep}`) &&
        !isAbsolute(relativeTemporaryRoot))
    ) {
      throw new ChangeReviewPublicationError(
        "Системный каталог временных файлов находится внутри Git workspace",
      );
    }
    temporaryDirectory = await mkdtemp(join(temporaryRootRealPath, "paseo-implementation-pr-"));
    const bodyPath = join(temporaryDirectory, "body.md");
    await writeFile(bodyPath, renderImplementationSummary(run), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await command(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repositoryArgument(run.repository),
        "--base",
        run.changeBranch,
        "--head",
        run.implementationBranch,
        "--title",
        implementationPullRequestTitle(run.changeId),
        "--body-file",
        bodyPath,
        "--draft",
      ],
      { cwd: workspaceDirectory, signal },
    );
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Не удалось создать Draft implementation pull request",
    );
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
