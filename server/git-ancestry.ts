import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";

/**
 * Проверяет, что `ancestor` достижим из `descendant` или совпадает с ним.
 *
 * Git-объект, которого нет в локальном репозитории, не может быть предком:
 * такой commit либо ещё не получен из origin, либо исчез после переписывания
 * истории. В обоих случаях ответ — `false`, а не ошибка. Исключение означает,
 * что Git не ответил: по прерванной или незапущенной команде об истории судить
 * нельзя.
 */
export async function isCommitAncestor(
  command: BoundedCommandRunner,
  directory: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  try {
    await command("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: directory,
      signal,
    });
    return true;
  } catch (error) {
    if (signal?.aborted || !exitedWithStatus(error)) throw error;
    return false;
  }
}

/**
 * Возвращает ближайший к `commit` коммит текущей истории `head`: сам `commit`,
 * если он остаётся предком, иначе их общий предок. `null` означает, что общей
 * истории нет или `commit` неизвестен локальному репозиторию.
 */
export async function findNearestAncestor(
  command: BoundedCommandRunner,
  directory: string,
  commit: string,
  head: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (await isCommitAncestor(command, directory, commit, head, signal)) return commit;
  let stdout: string;
  try {
    ({ stdout } = await command("git", ["merge-base", commit, head], {
      cwd: directory,
      signal,
    }));
  } catch (error) {
    if (signal?.aborted || !exitedWithStatus(error)) throw error;
    return null;
  }
  return commitHashSchema.parse(stdout.trim());
}

/** Проверяет, что коммит есть в локальном репозитории. */
export async function isKnownCommit(
  command: BoundedCommandRunner,
  directory: string,
  commit: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await command("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: directory, signal });
    return true;
  } catch (error) {
    if (signal?.aborted || !exitedWithStatus(error)) throw error;
    return false;
  }
}

/**
 * Git завершился кодом выхода, то есть ответил на вопрос. Тайм-аут и
 * недоступный исполняемый файл кода выхода не имеют.
 */
function exitedWithStatus(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "number"
  );
}
