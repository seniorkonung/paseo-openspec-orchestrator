import type { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  commitOrchestratorFile,
  readOrchestratorFileAt,
  type OrchestratorFile,
} from "./orchestrator-file-git.ts";
import {
  FindingDecisionsError,
  MAX_FINDING_DECISIONS_BYTES,
  findingDecisionsFileName,
  parseFindingDecisions,
  renderFindingDecisions,
  type FindingDecisionRecord,
} from "./review-finding-decision-model.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";
import type { ReviewFindingPublicationKind } from "./review-finding-publication.ts";

/** Путь файла решений относительно корня Git. */
export function findingDecisionsRepositoryPath(
  changeRepositoryPath: string,
  kind: ReviewFindingPublicationKind,
): string {
  return `${changeRepositoryPath}/${findingDecisionsFileName(kind)}`;
}

function decisionsFile(repositoryPath: string, kind: ReviewFindingPublicationKind): OrchestratorFile {
  return {
    fileName: findingDecisionsFileName(kind),
    repositoryPath,
    maxBytes: MAX_FINDING_DECISIONS_BYTES,
    createError: (message) => new FindingDecisionsError(message),
  };
}

/**
 * Читает решения из зафиксированного коммита, а не из рабочего дерева: так
 * сессия опирается ровно на те решения, от которых она начата. Отсутствующий
 * файл означает, что решений нет.
 */
export async function readFindingDecisionsAt(
  command: BoundedCommandRunner,
  gitRoot: string,
  commit: string,
  repositoryPath: string,
  kind: ReviewFindingPublicationKind,
  signal?: AbortSignal,
): Promise<readonly FindingDecisionRecord[]> {
  const source = await readOrchestratorFileAt(
    command,
    gitRoot,
    commit,
    decisionsFile(repositoryPath, kind),
    signal,
  );
  return source === null ? Object.freeze([]) : parseFindingDecisions(kind, source);
}

export interface FindingDecisionsCommitRequest {
  readonly command: BoundedCommandRunner;
  readonly paths: RepoLocalChangePaths;
  readonly kind: ReviewFindingPublicationKind;
  readonly records: readonly FindingDecisionRecord[];
  readonly subject: string;
  readonly signal?: AbortSignal;
  readonly inspectPath?: typeof lstat;
}

/**
 * Записывает файл решений и коммитит только его. Вызывающий отвечает за
 * чистое рабочее дерево и проверку получившегося диапазона коммитов.
 */
export function commitFindingDecisions(
  request: FindingDecisionsCommitRequest,
): Promise<string> {
  const { paths, kind } = request;
  return commitOrchestratorFile({
    command: request.command,
    gitRoot: paths.gitRoot,
    filePath: resolve(paths.changeRoot, findingDecisionsFileName(kind)),
    file: decisionsFile(findingDecisionsRepositoryPath(paths.changeRepositoryPath, kind), kind),
    content: renderFindingDecisions(kind, request.records),
    subject: request.subject,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.inspectPath === undefined ? {} : { inspectPath: request.inspectPath }),
  });
}
