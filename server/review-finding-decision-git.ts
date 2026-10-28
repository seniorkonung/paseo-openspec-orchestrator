import { lstat, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
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

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;

/** Путь файла решений относительно корня Git. */
export function findingDecisionsRepositoryPath(
  changeRepositoryPath: string,
  kind: ReviewFindingPublicationKind,
): string {
  return `${changeRepositoryPath}/${findingDecisionsFileName(kind)}`;
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
  const fileName = findingDecisionsFileName(kind);
  let listing: string;
  try {
    ({ stdout: listing } = await command(
      "git",
      ["ls-tree", "-z", "--full-name", commit, "--", repositoryPath],
      { cwd: gitRoot, signal },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FindingDecisionsError(`Не удалось найти ${fileName} в коммите ${commit}`);
  }
  if (listing === "") return Object.freeze([]);

  const entry = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)\0$/u.exec(listing);
  if (
    !entry ||
    entry[4] !== repositoryPath ||
    entry[2] !== "blob" ||
    (entry[1] !== "100644" && entry[1] !== "100755") ||
    !GIT_OBJECT_ID.test(entry[3] ?? "")
  ) {
    throw new FindingDecisionsError(`${fileName} должен быть обычным файлом`);
  }

  let source: string;
  try {
    ({ stdout: source } = await command("git", ["cat-file", "blob", entry[3]!], {
      cwd: gitRoot,
      signal,
      maxBuffer: MAX_FINDING_DECISIONS_BYTES * 2,
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FindingDecisionsError(`Не удалось прочитать ${fileName}`);
  }
  if (Buffer.byteLength(source, "utf8") > MAX_FINDING_DECISIONS_BYTES) {
    throw new FindingDecisionsError(
      `${fileName} превышает предел ${MAX_FINDING_DECISIONS_BYTES} байт`,
    );
  }
  if (source.includes("\uFFFD")) {
    throw new FindingDecisionsError(`${fileName} должен содержать корректный UTF-8`);
  }
  return parseFindingDecisions(kind, source);
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
export async function commitFindingDecisions(
  request: FindingDecisionsCommitRequest,
): Promise<string> {
  const { command, paths, kind, signal } = request;
  const inspectPath = request.inspectPath ?? lstat;
  const fileName = findingDecisionsFileName(kind);
  const filePath = resolve(paths.changeRoot, fileName);
  const repositoryPath = findingDecisionsRepositoryPath(paths.changeRepositoryPath, kind);
  const content = renderFindingDecisions(kind, request.records);
  if (Buffer.byteLength(content, "utf8") > MAX_FINDING_DECISIONS_BYTES) {
    throw new FindingDecisionsError(
      `${fileName} превышает предел ${MAX_FINDING_DECISIONS_BYTES} байт`,
    );
  }

  let existed: boolean;
  try {
    const existing = await inspectPath(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new FindingDecisionsError(`${fileName} должен быть обычным файлом`);
    }
    existed = true;
  } catch (error) {
    if (error instanceof FindingDecisionsError) throw error;
    if (!isMissingFile(error)) {
      throw new FindingDecisionsError(`Не удалось проверить ${fileName}`);
    }
    existed = false;
  }

  const git = (arguments_: readonly string[]) =>
    command("git", arguments_, { cwd: paths.gitRoot, signal });
  try {
    await writeFile(filePath, content, { encoding: "utf8", signal });
    await git(["add", "--", repositoryPath]);
    const { stdout: staged } = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
    const stagedPaths = staged.split("\0").filter(Boolean);
    if (stagedPaths.length !== 1 || stagedPaths[0] !== repositoryPath) {
      throw new FindingDecisionsError(
        `В коммит решений попали файлы, кроме ${fileName}`,
      );
    }
    await git(["commit", "-m", request.subject]);
  } catch (error) {
    // Неудавшийся коммит не должен оставлять файл решений в рабочем дереве
    // и индексе: иначе следующая попытка упрётся в грязное дерево.
    await restoreDecisionsFile(git, filePath, repositoryPath, existed);
    if (error instanceof FindingDecisionsError || signal?.aborted) throw error;
    throw new FindingDecisionsError(
      `Не удалось закоммитить ${fileName}${commandFailureDetail(error)}`,
    );
  }
  try {
    const { stdout: head } = await git(["rev-parse", "HEAD"]);
    return commitHashSchema.parse(head.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FindingDecisionsError(`Не удалось прочитать коммит ${fileName}`);
  }
}

async function restoreDecisionsFile(
  git: (arguments_: readonly string[]) => Promise<unknown>,
  filePath: string,
  repositoryPath: string,
  existed: boolean,
): Promise<void> {
  try {
    if (existed) {
      await git(["restore", "--staged", "--worktree", "--source=HEAD", "--", repositoryPath]);
    } else {
      await git(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", repositoryPath]);
      await rm(filePath, { force: true });
    }
  } catch {
    // Состояние дерева проверяет следующий шаг: грязное дерево останавливает
    // его с понятным сообщением.
  }
}

/** Краткая причина отказа git или hook для агента и пользователя. */
function commandFailureDetail(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error
    ? String(Reflect.get(error, "stderr"))
    : "";
  const detail = stderr.replace(/\s+/gu, " ").trim().slice(0, 300);
  return detail === "" ? "" : `: ${detail}`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
