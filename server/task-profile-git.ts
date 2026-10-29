import type { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  commitOrchestratorFile,
  readOrchestratorFileAt,
  type OrchestratorFile,
} from "./orchestrator-file-git.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";
import {
  MAX_TASK_PROFILES_BYTES,
  TASK_PROFILES_FILE_NAME,
  TaskProfilesError,
  parseTaskProfiles,
  renderTaskProfiles,
  type TaskProfileRecord,
} from "./task-profile-model.ts";

/** Путь файла профилей относительно корня Git. */
export function taskProfilesRepositoryPath(changeRepositoryPath: string): string {
  return `${changeRepositoryPath}/${TASK_PROFILES_FILE_NAME}`;
}

function profilesFile(changeRepositoryPath: string): OrchestratorFile {
  return {
    fileName: TASK_PROFILES_FILE_NAME,
    repositoryPath: taskProfilesRepositoryPath(changeRepositoryPath),
    maxBytes: MAX_TASK_PROFILES_BYTES,
    createError: (message) => new TaskProfilesError(message),
  };
}

/**
 * Читает профили из зафиксированного коммита. Отсутствующий файл означает,
 * что ни одна задача ещё не оценена.
 */
export async function readTaskProfilesAt(
  command: BoundedCommandRunner,
  paths: Pick<RepoLocalChangePaths, "gitRoot" | "changeRepositoryPath">,
  commit: string,
  signal?: AbortSignal,
): Promise<readonly TaskProfileRecord[]> {
  const source = await readOrchestratorFileAt(
    command,
    paths.gitRoot,
    commit,
    profilesFile(paths.changeRepositoryPath),
    signal,
  );
  return source === null ? Object.freeze([]) : parseTaskProfiles(source);
}

export interface TaskProfilesCommitRequest {
  readonly command: BoundedCommandRunner;
  readonly paths: RepoLocalChangePaths;
  readonly records: readonly TaskProfileRecord[];
  readonly subject: string;
  readonly signal?: AbortSignal;
  readonly inspectPath?: typeof lstat;
}

/**
 * Записывает файл профилей и коммитит только его. Вызывающий отвечает за
 * чистое рабочее дерево и проверку получившегося диапазона коммитов.
 */
export async function commitTaskProfiles(request: TaskProfilesCommitRequest): Promise<string> {
  const { paths } = request;
  const file = profilesFile(paths.changeRepositoryPath);
  const content = renderTaskProfiles(request.records);
  const commit = await commitOrchestratorFile({
    command: request.command,
    gitRoot: paths.gitRoot,
    filePath: resolve(paths.changeRoot, TASK_PROFILES_FILE_NAME),
    file,
    content,
    subject: request.subject,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.inspectPath === undefined ? {} : { inspectPath: request.inspectPath }),
  });
  // Hook форматирования мог переписать файл при коммите: тогда записанные
  // профили не совпадают с переданными, и это нужно назвать прямо.
  const committed = await readOrchestratorFileAt(
    request.command,
    paths.gitRoot,
    commit,
    file,
    request.signal,
  );
  if (committed !== content) {
    throw new TaskProfilesError(
      `Git hook изменил ${TASK_PROFILES_FILE_NAME} при коммите ${commit}; исключите файл из форматирования: его формат ведёт оркестратор`,
    );
  }
  return commit;
}
