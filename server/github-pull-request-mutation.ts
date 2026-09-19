import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";

const MAX_PULL_REQUEST_TITLE_LENGTH = 256;
const MAX_PULL_REQUEST_BODY_LENGTH = 65_536;
const MAX_BRANCH_LENGTH = 512;

const pullRequestNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const pullRequestBaseSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Имя base-ветки содержит небезопасные символы",
  )
  .refine(
    (value) =>
      value !== "@" &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Имя base-ветки не соответствует безопасному формату Git ref",
  );

const pullRequestUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_PULL_REQUEST_TITLE_LENGTH).optional(),
    body: z.string().max(MAX_PULL_REQUEST_BODY_LENGTH).optional(),
    base: pullRequestBaseSchema.optional(),
  })
  .strict()
  .refine(
    (update) =>
      update.title !== undefined ||
      update.body !== undefined ||
      update.base !== undefined,
    "Обновление pull request не может быть пустым",
  );

export type GitHubPullRequestUpdate = z.output<typeof pullRequestUpdateSchema>;

export class GitHubPullRequestMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPullRequestMutationError";
  }
}

/**
 * Единственная точка изменения полей GitHub pull request.
 *
 * `gh pr edit` намеренно не используется: старые версии GitHub CLI запрашивают
 * удалённые Projects Classic поля даже для несвязанных изменений PR.
 */
export async function updateGitHubPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repositoryInput: GitHubRemoteIdentity,
  pullRequestNumberInput: number,
  updateInput: GitHubPullRequestUpdate,
  signal?: AbortSignal,
): Promise<void> {
  let temporaryDirectory: string | null = null;
  try {
    const repository = {
      host: githubHostSchema.parse(repositoryInput.host),
      nameWithOwner: repositoryNameWithOwnerSchema.parse(
        repositoryInput.nameWithOwner,
      ),
    };
    const pullRequestNumber = pullRequestNumberSchema.parse(
      pullRequestNumberInput,
    );
    const update = pullRequestUpdateSchema.parse(updateInput);
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
      throw new GitHubPullRequestMutationError(
        "Системный каталог временных файлов находится внутри Git workspace",
      );
    }

    temporaryDirectory = await mkdtemp(
      join(temporaryRootRealPath, "paseo-openspec-pr-update-"),
    );
    const requestPath = join(temporaryDirectory, "request.json");
    await writeFile(requestPath, JSON.stringify(update), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await command(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        "--hostname",
        repository.host,
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${repository.nameWithOwner}/pulls/${pullRequestNumber}`,
        "--input",
        requestPath,
        "--silent",
      ],
      { cwd: workspaceDirectory, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof GitHubPullRequestMutationError) throw error;
    throw new GitHubPullRequestMutationError(
      `Не удалось обновить pull request #${pullRequestNumberInput}`,
    );
  } finally {
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new GitHubPullRequestMutationError(
          "Не удалось очистить временный файл обновления pull request",
        );
      }
    }
  }
}
