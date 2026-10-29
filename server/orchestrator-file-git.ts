import { lstat, rm, writeFile } from "node:fs/promises";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;

/**
 * Файл в каталоге change, которым владеет оркестратор: он сам генерирует его
 * из проверенных данных и коммитит отдельным коммитом. Ошибки создаются
 * фабрикой владельца, чтобы вызывающий этап получал свой тип ошибки.
 */
export interface OrchestratorFile {
  /** Имя файла для сообщений пользователю. */
  readonly fileName: string;
  /** Путь относительно корня Git. */
  readonly repositoryPath: string;
  readonly maxBytes: number;
  readonly createError: (message: string) => Error;
}

/**
 * Читает файл из зафиксированного коммита, а не из рабочего дерева: так этап
 * опирается ровно на то содержимое, от которого он начат. `null` — файла нет.
 */
export async function readOrchestratorFileAt(
  command: BoundedCommandRunner,
  gitRoot: string,
  commit: string,
  file: OrchestratorFile,
  signal?: AbortSignal,
): Promise<string | null> {
  const { fileName, repositoryPath, createError } = file;
  let listing: string;
  try {
    ({ stdout: listing } = await command(
      "git",
      ["ls-tree", "-z", "--full-name", commit, "--", repositoryPath],
      { cwd: gitRoot, signal },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createError(`Не удалось найти ${fileName} в коммите ${commit}`);
  }
  if (listing === "") return null;

  const entry = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)\0$/u.exec(listing);
  if (
    !entry ||
    entry[4] !== repositoryPath ||
    entry[2] !== "blob" ||
    (entry[1] !== "100644" && entry[1] !== "100755") ||
    !GIT_OBJECT_ID.test(entry[3] ?? "")
  ) {
    throw createError(`${fileName} должен быть обычным файлом`);
  }

  let source: string;
  try {
    ({ stdout: source } = await command("git", ["cat-file", "blob", entry[3]!], {
      cwd: gitRoot,
      signal,
      maxBuffer: file.maxBytes * 2,
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createError(`Не удалось прочитать ${fileName}`);
  }
  if (Buffer.byteLength(source, "utf8") > file.maxBytes) {
    throw createError(`${fileName} превышает предел ${file.maxBytes} байт`);
  }
  if (source.includes("\uFFFD")) {
    throw createError(`${fileName} должен содержать корректный UTF-8`);
  }
  return source;
}

export interface OrchestratorFileCommitRequest {
  readonly command: BoundedCommandRunner;
  readonly gitRoot: string;
  /** Абсолютный путь файла в рабочем дереве. */
  readonly filePath: string;
  readonly file: OrchestratorFile;
  readonly content: string;
  readonly subject: string;
  readonly signal?: AbortSignal;
  readonly inspectPath?: typeof lstat;
}

/**
 * Записывает файл и коммитит только его через Git hooks репозитория.
 * Отклонённый коммит откатывается, а вывод hook попадает в сообщение ошибки.
 * Вызывающий отвечает за чистое рабочее дерево и проверку получившегося
 * диапазона коммитов.
 */
export async function commitOrchestratorFile(
  request: OrchestratorFileCommitRequest,
): Promise<string> {
  const { command, gitRoot, filePath, file, signal } = request;
  const { fileName, repositoryPath } = file;
  const inspectPath = request.inspectPath ?? lstat;
  // Ошибки, которые уже описывают проблему: их не нужно обобщать.
  const described = new WeakSet<Error>();
  const fail = (message: string): Error => {
    const error = file.createError(message);
    described.add(error);
    return error;
  };
  if (Buffer.byteLength(request.content, "utf8") > file.maxBytes) {
    throw fail(`${fileName} превышает предел ${file.maxBytes} байт`);
  }

  let existed: boolean;
  try {
    const existing = await inspectPath(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw fail(`${fileName} должен быть обычным файлом`);
    }
    existed = true;
  } catch (error) {
    if (error instanceof Error && described.has(error)) throw error;
    if (!isMissingFile(error)) throw fail(`Не удалось проверить ${fileName}`);
    existed = false;
  }

  const git = (arguments_: readonly string[]) =>
    command("git", arguments_, { cwd: gitRoot, signal });
  try {
    await writeFile(filePath, request.content, { encoding: "utf8", signal });
    await git(["add", "--", repositoryPath]);
    const { stdout: staged } = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
    const stagedPaths = staged.split("\0").filter(Boolean);
    if (stagedPaths.length !== 1 || stagedPaths[0] !== repositoryPath) {
      throw fail(`В коммит ${fileName} попали другие файлы`);
    }
    await git(["commit", "-m", request.subject]);
  } catch (error) {
    // Неудавшийся коммит не должен оставлять файл в рабочем дереве и индексе:
    // иначе следующая попытка упрётся в грязное дерево.
    await restoreFile(git, filePath, repositoryPath, existed);
    if ((error instanceof Error && described.has(error)) || signal?.aborted) throw error;
    throw fail(`Не удалось закоммитить ${fileName}${commandFailureDetail(error)}`);
  }
  try {
    const { stdout: head } = await git(["rev-parse", "HEAD"]);
    return commitHashSchema.parse(head.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fail(`Не удалось прочитать коммит ${fileName}`);
  }
}

async function restoreFile(
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
