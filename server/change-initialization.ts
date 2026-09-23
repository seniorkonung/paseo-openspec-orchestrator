import { z } from "zod";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OrchestratorChange } from "../shared/orchestrator.ts";
import {
  changeBranchFor,
  changeBranchSchema,
  type ChangeBranch,
} from "./change-branch.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import {
  createOpenSpecChangeVerifier,
  openSpecChangeIdSchema,
} from "./openspec-change.ts";
import { resolveRepoLocalChangePaths } from "./repo-local-change.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import {
  REVIEW_PARENT_BRANCH,
  assertPullRequestRepository,
  pullRequestNumberSchema,
  repositoryArgument,
  type ReviewPullRequest,
} from "./review-publication-model.ts";
import {
  listReviewPullRequests,
  readRemoteReviewBranchCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import { updateGitHubPullRequest } from "./github-pull-request-mutation.ts";

const MAX_PATH_LENGTH = 8_192;
const FALLBACK_COMMIT_SUBJECT = "docs(openspec): add change scaffold";
const FALLBACK_PULL_REQUEST_TITLE = "Подготовить OpenSpec change";

const rootOutputSchema = z
  .object({
    path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    source: z.enum(["store", "declared", "global_default", "nearest", "implicit"]),
    store_id: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const changeListSchema = z
  .object({
    changes: z.array(
      z
        .object({
          name: openSpecChangeIdSchema,
          nested: z.array(z.string()).optional(),
        })
        .loose(),
    ),
    root: rootOutputSchema,
  })
  .loose();

const newChangeSchema = z
  .object({
    change: z
      .object({
        id: openSpecChangeIdSchema,
        path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
        metadataPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
        schema: z.string().trim().min(1).max(256),
      })
      .strict(),
    root: rootOutputSchema,
  })
  .loose();

const statusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    changeRoot: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    actionContext: z
      .object({
        mode: z.literal("repo-local"),
        sourceOfTruth: z.literal("repo"),
      })
      .loose(),
    root: rootOutputSchema,
  })
  .loose();

export const pendingChangeInitializationSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    baselineCommit: commitHashSchema,
    changeExisted: z.boolean(),
    openSpecRoot: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    existingRootPullRequest: z
      .object({
        number: pullRequestNumberSchema,
        isDraft: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.changeBranch !== changeBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая ветка не соответствует OpenSpec change",
      });
    }
  });

export type PendingChangeInitializationSession = z.infer<
  typeof pendingChangeInitializationSessionSchema
>;

export interface InitializedChange {
  readonly change: OrchestratorChange;
  readonly changeBranch: ChangeBranch;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
  };
}

export interface ChangeInitializationService {
  prepare(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    signal?: AbortSignal,
  ): Promise<PendingChangeInitializationSession>;
  initialize(
    workspaceDirectory: string,
    session: PendingChangeInitializationSession,
    signal?: AbortSignal,
  ): Promise<InitializedChange>;
}

export interface ChangeInitializationServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export class ChangeInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeInitializationError";
  }
}

export function createChangeInitializationService(
  options: ChangeInitializationServiceOptions = {},
): ChangeInitializationService {
  const command = options.command ?? runBoundedCommand;
  const verifyChange = createOpenSpecChangeVerifier({ command });

  return {
    async prepare(workspaceDirectory, changeIdInput, changeBranchInput, signal) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) {
        throw new ChangeInitializationError(
          "Корневая Git-ветка не соответствует определённому OpenSpec change",
        );
      }
      await assertCurrentBranch(command, workspaceDirectory, changeBranch, signal);
      await assertCleanWorktree(command, workspaceDirectory, signal);
      const [baselineCommit, listedChange, existingRootPullRequest] = await Promise.all([
        readHead(command, workspaceDirectory, signal),
        inspectChangeList(command, workspaceDirectory, changeId, signal),
        inspectExistingRootPullRequest(
          command,
          workspaceDirectory,
          changeBranch,
          signal,
        ),
      ]);
      if (listedChange.exists) {
        await verifyChange(workspaceDirectory, changeId, signal);
      }
      return pendingChangeInitializationSessionSchema.parse({
        changeId,
        changeBranch,
        baselineCommit,
        changeExisted: listedChange.exists,
        openSpecRoot: listedChange.openSpecRoot,
        existingRootPullRequest,
      });
    },

    async initialize(workspaceDirectory, sessionInput, signal) {
      const session = pendingChangeInitializationSessionSchema.parse(sessionInput);
      await assertCurrentBranch(
        command,
        workspaceDirectory,
        session.changeBranch,
        signal,
      );

      const listedChange = await inspectChangeList(
        command,
        workspaceDirectory,
        session.changeId,
        signal,
      );
      if (listedChange.openSpecRoot !== session.openSpecRoot) {
        throw new ChangeInitializationError(
          "OpenSpec root изменился после начала инициализации change",
        );
      }
      const exists = listedChange.exists;
      if (session.changeExisted && !exists) {
        throw new ChangeInitializationError(
          `OpenSpec change «${session.changeId}» исчез после начала инициализации`,
        );
      }
      let created: z.output<typeof newChangeSchema> | null = null;
      if (!exists) {
        await assertCleanWorktree(command, workspaceDirectory, signal);
        const head = await readHead(command, workspaceDirectory, signal);
        if (head !== session.baselineCommit) {
          throw new ChangeInitializationError(
            "Git HEAD изменился до создания OpenSpec change",
          );
        }
        created = await createChange(
          command,
          workspaceDirectory,
          session.changeId,
          signal,
        );
        if (created.root.path !== session.openSpecRoot) {
          throw new ChangeInitializationError(
            "OpenSpec создал change в другом OpenSpec root",
          );
        }
      }

      const paths = await readChangePaths(
        command,
        workspaceDirectory,
        session.changeId,
        session.openSpecRoot,
        signal,
      );
      if (created) {
        await assertCreatedPaths(
          workspaceDirectory,
          created.change,
          paths.changeRoot,
          session.openSpecRoot,
        );
      }
      const committed = await isChangeCommitted(
        command,
        paths.gitRoot,
        paths.changeRepositoryPath,
        signal,
      );
      if (!committed) {
        if (session.changeExisted) {
          throw new ChangeInitializationError(
            `Существующий change «${session.changeId}» не добавлен в Git HEAD`,
          );
        }
        await commitCreatedChange(command, paths, session, signal);
      } else if (!session.changeExisted) {
        await verifyRecoveredCreationCommit(command, paths, session, signal);
      }

      const change = await verifyChange(workspaceDirectory, session.changeId, signal);
      const head = await readHead(command, paths.gitRoot, signal);
      await pushBranch(command, paths.gitRoot, session.changeBranch, signal);
      const remoteHead = await readRemoteReviewBranchCommit(
        command,
        paths.gitRoot,
        session.changeBranch,
        signal,
      );
      if (remoteHead !== head) {
        throw new ChangeInitializationError(
          `Git remote origin не содержит текущий HEAD ветки «${session.changeBranch}»`,
        );
      }
      const pullRequest = await ensureRootPullRequest(
        command,
        paths.gitRoot,
        session,
        head,
        signal,
      );
      return {
        change,
        changeBranch: session.changeBranch,
        pullRequest: { number: pullRequest.number, url: pullRequest.url },
      };
    },
  };
}

async function inspectChangeList(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  signal?: AbortSignal,
): Promise<{ readonly exists: boolean; readonly openSpecRoot: string }> {
  try {
    const { stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["list", "--json"],
      signal,
    );
    const list = changeListSchema.parse(JSON.parse(stdout) as unknown);
    const directMatches = list.changes.filter(
      (change) => change.name === changeId && change.nested === undefined,
    );
    if (directMatches.length > 1) {
      throw new Error("OpenSpec вернул дублированный change");
    }
    return {
      exists: directMatches.length === 1,
      openSpecRoot: await resolveRepoLocalOpenSpecRoot(
        workspaceDirectory,
        list.root.path,
      ),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      "Не удалось получить список OpenSpec changes через mise",
    );
  }
}

async function createChange(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  signal?: AbortSignal,
): Promise<z.output<typeof newChangeSchema>> {
  try {
    const { stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["new", "change", changeId, "--json"],
      signal,
    );
    const created = newChangeSchema.parse(JSON.parse(stdout) as unknown);
    if (created.change.id !== changeId) {
      throw new Error("OpenSpec создал другой change");
    }
    const openSpecRoot = await resolveRepoLocalOpenSpecRoot(
      workspaceDirectory,
      created.root.path,
    );
    return { ...created, root: { ...created.root, path: openSpecRoot } };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      `Не удалось создать OpenSpec change «${changeId}» через mise`,
    );
  }
}

async function assertCreatedPaths(
  workspaceDirectory: string,
  created: z.output<typeof newChangeSchema>["change"],
  actualChangeRoot: string,
  expectedOpenSpecRoot: string,
): Promise<void> {
  try {
    const workspaceRoot = await realpath(workspaceDirectory);
    const createdRoot = await realpath(
      isAbsolute(created.path)
        ? created.path
        : resolve(workspaceRoot, created.path),
    );
    const metadataPath = await realpath(
      isAbsolute(created.metadataPath)
        ? created.metadataPath
        : resolve(workspaceRoot, created.metadataPath),
    );
    const metadataRelative = relative(actualChangeRoot, metadataPath);
    const changeRelativeToOpenSpecRoot = relative(expectedOpenSpecRoot, createdRoot);
    if (
      createdRoot !== actualChangeRoot ||
      changeRelativeToOpenSpecRoot.length === 0 ||
      isOutside(changeRelativeToOpenSpecRoot) ||
      metadataRelative.length === 0 ||
      isOutside(metadataRelative)
    ) {
      throw new Error("OpenSpec сообщил несогласованные пути");
    }
  } catch {
    throw new ChangeInitializationError(
      "OpenSpec сообщил пути нового change за пределами фактического change root",
    );
  }
}

async function readChangePaths(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  expectedOpenSpecRoot: string,
  signal?: AbortSignal,
) {
  try {
    const { stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["status", "--change", changeId, "--json"],
      signal,
    );
    const status = statusSchema.parse(JSON.parse(stdout) as unknown);
    if (status.changeName !== changeId) throw new Error("Другой change");
    const openSpecRoot = await resolveRepoLocalOpenSpecRoot(
      workspaceDirectory,
      status.root.path,
    );
    if (openSpecRoot !== expectedOpenSpecRoot) {
      throw new Error("Другой OpenSpec root");
    }
    return await resolveRepoLocalChangePaths({
      command,
      workspaceDirectory,
      reportedChangeRoot: status.changeRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      `Не удалось безопасно определить каталог change «${changeId}»`,
    );
  }
}

async function resolveRepoLocalOpenSpecRoot(
  workspaceDirectory: string,
  reportedPath: string,
): Promise<string> {
  if (!isAbsolute(reportedPath)) {
    throw new Error("OpenSpec root должен быть абсолютным путём");
  }
  const [workspaceRoot, openSpecRoot] = await Promise.all([
    realpath(workspaceDirectory),
    realpath(reportedPath),
  ]);
  const relativeRoot = relative(workspaceRoot, openSpecRoot);
  if (relativeRoot.length > 0 && isOutside(relativeRoot)) {
    throw new Error("OpenSpec root находится вне workspace");
  }
  return openSpecRoot;
}

function isOutside(relativePath: string): boolean {
  return (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  );
}

async function commitCreatedChange(
  command: BoundedCommandRunner,
  paths: Awaited<ReturnType<typeof readChangePaths>>,
  session: PendingChangeInitializationSession,
  signal?: AbortSignal,
): Promise<void> {
  const head = await readHead(command, paths.gitRoot, signal);
  if (head !== session.baselineCommit) {
    throw new ChangeInitializationError(
      "Git HEAD изменился до фиксации scaffold нового change",
    );
  }
  const changedPaths = await readChangedPaths(command, paths.gitRoot, signal);
  if (
    changedPaths.length === 0 ||
    changedPaths.some((path) => !isInsideRepositoryPath(path, paths.changeRepositoryPath))
  ) {
    throw new ChangeInitializationError(
      "OpenSpec изменил файлы за пределами созданного change",
    );
  }
  try {
    await command("git", ["add", "--", paths.changeRepositoryPath], {
      cwd: paths.gitRoot,
      signal,
    });
    const stagedPaths = await readNullSeparatedCommand(
      command,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      paths.gitRoot,
      signal,
    );
    if (
      stagedPaths.length === 0 ||
      stagedPaths.some(
        (path) => !isInsideRepositoryPath(path, paths.changeRepositoryPath),
      )
    ) {
      throw new ChangeInitializationError(
        "В scaffold-коммит попали файлы за пределами созданного change",
      );
    }
    await command("git", ["commit", "-m", changeCommitSubject(session.changeId)], {
      cwd: paths.gitRoot,
      signal,
    });
  } catch (error) {
    if (error instanceof ChangeInitializationError || signal?.aborted) throw error;
    throw new ChangeInitializationError("Не удалось создать scaffold-коммит OpenSpec change");
  }
  await assertCleanWorktree(command, paths.gitRoot, signal);
  await verifyRecoveredCreationCommit(command, paths, session, signal);
}

async function verifyRecoveredCreationCommit(
  command: BoundedCommandRunner,
  paths: Awaited<ReturnType<typeof readChangePaths>>,
  session: PendingChangeInitializationSession,
  signal?: AbortSignal,
): Promise<void> {
  const head = await readHead(command, paths.gitRoot, signal);
  try {
    await command(
      "git",
      ["merge-base", "--is-ancestor", session.baselineCommit, head],
      { cwd: paths.gitRoot, signal },
    );
    const count = await command(
      "git",
      ["rev-list", "--count", `${session.baselineCommit}..${head}`],
      { cwd: paths.gitRoot, signal },
    );
    if (z.coerce.number().int().parse(count.stdout.trim()) !== 1) {
      throw new Error("Неверное число коммитов");
    }
    const subject = await command("git", ["show", "-s", "--format=%s", head], {
      cwd: paths.gitRoot,
      signal,
    });
    if (subject.stdout.trimEnd() !== changeCommitSubject(session.changeId)) {
      throw new Error("Неверный subject");
    }
    const committedPaths = await readNullSeparatedCommand(
      command,
      "git",
      ["diff", "--name-only", "-z", session.baselineCommit, head],
      paths.gitRoot,
      signal,
    );
    if (
      committedPaths.length === 0 ||
      committedPaths.some(
        (path) => !isInsideRepositoryPath(path, paths.changeRepositoryPath),
      )
    ) {
      throw new Error("Неверные пути scaffold-коммита");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      "Не удалось подтвердить отдельный scaffold-коммит нового change",
    );
  }
  await assertCleanWorktree(command, paths.gitRoot, signal);
}

async function ensureRootPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  session: PendingChangeInitializationSession,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<ReviewPullRequest> {
  const repository = await resolveReviewRepository(command, workspaceDirectory, signal);
  await readBaseBranchCommit(
    command,
    workspaceDirectory,
    REVIEW_PARENT_BRANCH,
    signal,
  );
  let requests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    session.changeBranch,
    "all",
    signal,
  );
  if (requests.length > 1) {
    throw new ChangeInitializationError(
      `Для ветки «${session.changeBranch}» найдено несколько pull request`,
    );
  }
  const previous = session.existingRootPullRequest;
  if (
    previous &&
    (requests.length !== 1 || requests[0]!.number !== previous.number)
  ) {
    throw new ChangeInitializationError(
      "Сохранённый корневой pull request больше не является единственным PR ветки",
    );
  }
  if (requests.length === 0 && previous === null) {
    try {
      await command(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          repositoryArgument(repository),
          "--base",
          REVIEW_PARENT_BRANCH,
          "--head",
          session.changeBranch,
          "--draft",
          "--title",
          initialPullRequestTitle(session.changeId),
          "--body",
          initialPullRequestBody(session.changeId),
        ],
        { cwd: workspaceDirectory, signal },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChangeInitializationError(
        `Не удалось создать Draft pull request ветки «${session.changeBranch}»`,
      );
    }
    requests = await listReviewPullRequests(
      command,
      workspaceDirectory,
      repositoryArgument(repository),
      session.changeBranch,
      "all",
      signal,
    );
    if (requests.length !== 1) {
      throw new ChangeInitializationError(
        "GitHub не подтвердил единственный созданный pull request",
      );
    }
  }

  let pullRequest = await readReviewPullRequest(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    requests[0]!.number,
    signal,
  );
  assertPullRequestRepository(pullRequest, repository.url);
  const expectedDraft = previous?.isDraft ?? true;
  assertRootPullRequestIdentity(
    pullRequest,
    session.changeBranch,
    expectedHead,
    expectedDraft,
  );
  if (pullRequest.baseRefName !== REVIEW_PARENT_BRANCH) {
    try {
      await updateGitHubPullRequest(
        command,
        workspaceDirectory,
        repository,
        pullRequest.number,
        { base: REVIEW_PARENT_BRANCH },
        signal,
      );
      pullRequest = await readReviewPullRequest(
        command,
        workspaceDirectory,
        repositoryArgument(repository),
        pullRequest.number,
        signal,
      );
      assertPullRequestRepository(pullRequest, repository.url);
      assertRootPullRequestIdentity(
        pullRequest,
        session.changeBranch,
        expectedHead,
        expectedDraft,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChangeInitializationError(
        `Не удалось направить pull request #${pullRequest.number} в main`,
      );
    }
  }
  if (
    pullRequest.baseRefName !== REVIEW_PARENT_BRANCH
  ) {
    throw new ChangeInitializationError(
      "Корневой pull request не соответствует опубликованной change-ветке",
    );
  }
  return pullRequest;
}

async function inspectExistingRootPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeBranch: string,
  signal?: AbortSignal,
): Promise<{ readonly number: number; readonly isDraft: boolean } | null> {
  try {
    const repository = await resolveReviewRepository(
      command,
      workspaceDirectory,
      signal,
    );
    const requests = await listReviewPullRequests(
      command,
      workspaceDirectory,
      repositoryArgument(repository),
      changeBranch,
      "all",
      signal,
    );
    if (requests.length > 1) {
      throw new ChangeInitializationError(
        `Для ветки «${changeBranch}» найдено несколько pull request`,
      );
    }
    const pullRequest = requests[0];
    if (!pullRequest) return null;
    assertPullRequestRepository(pullRequest, repository.url);
    if (
      pullRequest.state !== "OPEN" ||
      pullRequest.isCrossRepository ||
      pullRequest.headRefName !== changeBranch
    ) {
      throw new ChangeInitializationError(
        "Существующий корневой pull request закрыт или не соответствует change-ветке",
      );
    }
    return { number: pullRequest.number, isDraft: pullRequest.isDraft };
  } catch (error) {
    if (error instanceof ChangeInitializationError || signal?.aborted) throw error;
    throw new ChangeInitializationError(
      "Не удалось безопасно проверить существующий корневой pull request",
    );
  }
}

function assertRootPullRequestIdentity(
  pullRequest: ReviewPullRequest,
  changeBranch: string,
  expectedHead: string,
  expectedDraft: boolean,
): void {
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isCrossRepository ||
    pullRequest.isDraft !== expectedDraft ||
    pullRequest.headRefName !== changeBranch ||
    pullRequest.headRefOid !== expectedHead
  ) {
    throw new ChangeInitializationError(
      "Корневой pull request не соответствует опубликованной change-ветке",
    );
  }
}

async function readBaseBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", ref],
      { cwd: workspaceDirectory, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]?.split("\t") ?? [];
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный remote ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      `Ветка «${branch}» отсутствует или недоступна в Git remote origin`,
    );
  }
}

async function pushBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["push", "--set-upstream", "origin", branch], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      `Не удалось опубликовать ветку «${branch}» в Git remote origin`,
    );
  }
}

async function assertCurrentBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  expected: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: workspaceDirectory,
      signal,
    });
    if (result.stdout.trim() !== expected) throw new Error("Другая ветка");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      `Требуется корневая Git-ветка «${expected}»`,
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
    if (result.stdout.length > 0) throw new Error("Dirty");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeInitializationError(
      "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
    );
  }
}

async function readHead(
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
    throw new ChangeInitializationError("Не удалось определить текущий Git HEAD");
  }
}

async function isChangeCommitted(
  command: BoundedCommandRunner,
  gitRoot: string,
  changeRepositoryPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await command("git", ["cat-file", "-e", `HEAD:${changeRepositoryPath}`], {
      cwd: gitRoot,
      signal,
    });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function readChangedPaths(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const groups = await Promise.all([
    readNullSeparatedCommand(command, "git", ["diff", "--name-only", "-z"], gitRoot, signal),
    readNullSeparatedCommand(
      command,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      gitRoot,
      signal,
    ),
    readNullSeparatedCommand(
      command,
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      gitRoot,
      signal,
    ),
  ]);
  return [...new Set(groups.flat())];
}

async function readNullSeparatedCommand(
  command: BoundedCommandRunner,
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const result = await command(executable, arguments_, { cwd, signal });
  if (result.stdout.length === 0) return [];
  const entries = result.stdout.split("\0");
  if (entries.at(-1) !== "") {
    throw new ChangeInitializationError("Git вернул некорректный список путей");
  }
  entries.pop();
  return entries.map((path) =>
    z.string().min(1).max(MAX_PATH_LENGTH).parse(path),
  );
}

function isInsideRepositoryPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function changeCommitSubject(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const detailed = `docs(openspec): add ${changeId} change`;
  return detailed.length <= 71 ? detailed : FALLBACK_COMMIT_SUBJECT;
}

export function initialPullRequestTitle(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const detailed = `Подготовить OpenSpec change «${changeId}»`;
  return detailed.length <= 256 ? detailed : FALLBACK_PULL_REQUEST_TITLE;
}

export function initialPullRequestBody(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  return `## Статус\n\nPlanning change выполняется оркестратором.\n\n## OpenSpec change\n\n\`${changeId}\``;
}
