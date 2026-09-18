import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  ChangePublicationError,
  MAX_OPEN_PULL_REQUESTS,
  PUBLICATION_BASE_BRANCH,
  PUBLICATION_REMOTE,
  gitBranchNameSchema,
  openPullRequestListSchema,
  openPullRequestSchema,
  pullRequestSchema,
  pullRequestTitleSchema,
  repositorySchema,
  type PublicationCompletionInput,
  type PublicationTarget,
  type PublishedPullRequest,
} from "./change-publication-model.ts";
import {
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";

export async function inspectPublicationTarget(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal: AbortSignal,
): Promise<PublicationTarget> {
  await assertCleanWorktree(command, workspaceDirectory, signal);
  const [currentBranch, expectedHead] = await Promise.all([
    readCurrentBranch(command, workspaceDirectory, signal),
    readHeadCommit(command, workspaceDirectory, signal),
  ]);
  if (currentBranch !== branch) {
    throw new ChangePublicationError(
      `Текущая Git-ветка изменилась с «${branch}» на «${currentBranch}»`,
    );
  }

  let originUrl: string;
  try {
    const result = await command("git", ["remote", "get-url", PUBLICATION_REMOTE], {
      cwd: workspaceDirectory,
      signal,
    });
    originUrl = result.stdout.trim();
    if (!originUrl) throw new Error("Пустой URL origin");
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError("Git remote origin отсутствует или недоступен");
  }

  const remote = parseGitHubRemote(originUrl);
  try {
    await command("gh", ["auth", "status", "--hostname", remote.host], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError(
      `GitHub CLI недоступен или не авторизован для origin host «${remote.host}»`,
    );
  }

  const repositoryArgument =
    remote.host === "github.com"
      ? remote.nameWithOwner
      : `${remote.host}/${remote.nameWithOwner}`;
  let repository: z.output<typeof repositorySchema>;
  try {
    const result = await command(
      "gh",
      ["repo", "view", repositoryArgument, "--json", "nameWithOwner,url"],
      { cwd: workspaceDirectory, signal },
    );
    repository = repositorySchema.parse(JSON.parse(result.stdout));
    if (
      new URL(repository.url).hostname.toLowerCase() !== remote.host ||
      repository.nameWithOwner.toLowerCase() !== remote.nameWithOwner.toLowerCase()
    ) {
      throw new Error("gh разрешил другой GitHub-репозиторий");
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError(
      "Git remote origin не разрешается в доступный GitHub-репозиторий",
    );
  }

  await readRemoteCommit(command, workspaceDirectory, PUBLICATION_BASE_BRANCH, signal).catch(
    (error) => {
      if (signal.aborted) throw error;
      throw new ChangePublicationError(
        "Ветка main отсутствует или недоступна в Git remote origin",
      );
    },
  );

  const openPullRequests = await listOpenPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument,
    branch,
    signal,
  );
  if (openPullRequests.length > 1) {
    throw new ChangePublicationError(
      `Для ветки «${branch}» найдено несколько открытых pull request`,
    );
  }
  const existingPullRequest = openPullRequests[0] ?? null;
  if (existingPullRequest) {
    assertPullRequestRepository(existingPullRequest, repository.url);
    if (existingPullRequest.headRefName !== branch) {
      throw new ChangePublicationError(
        `GitHub CLI вернул pull request другой ветки вместо «${branch}»`,
      );
    }
  }
  if (existingPullRequest?.isCrossRepository) {
    throw new ChangePublicationError(
      `Открытый pull request #${existingPullRequest.number} использует fork вместо origin`,
    );
  }

  return {
    repository: repositoryArgument,
    repositoryUrl: repository.url,
    expectedHead,
    existingPullRequest,
  };
}

export async function verifyPublication(
  command: BoundedCommandRunner,
  request: {
    readonly workspaceDirectory: string;
    readonly changeId: string;
    readonly branch: string;
    readonly target: PublicationTarget;
    readonly input: PublicationCompletionInput;
    readonly signal: AbortSignal;
  },
): Promise<PublishedPullRequest> {
  await assertCleanWorktree(command, request.workspaceDirectory, request.signal);
  const [currentBranch, head] = await Promise.all([
    readCurrentBranch(command, request.workspaceDirectory, request.signal),
    readHeadCommit(command, request.workspaceDirectory, request.signal),
  ]);
  if (currentBranch !== request.branch) {
    throw new ChangePublicationError(
      `Текущая Git-ветка изменилась с «${request.branch}» на «${currentBranch}»`,
    );
  }
  if (head !== request.target.expectedHead) {
    throw new ChangePublicationError(
      "Git HEAD изменился во время публикации; этап не должен создавать коммиты",
    );
  }

  const remoteHead = await readRemoteCommit(
    command,
    request.workspaceDirectory,
    request.branch,
    request.signal,
  );
  if (remoteHead !== head) {
    throw new ChangePublicationError(
      `Git remote origin не содержит текущий HEAD ветки «${request.branch}»`,
    );
  }

  const expectedNumber = request.target.existingPullRequest?.number;
  if (expectedNumber !== undefined && expectedNumber !== request.input.pullRequestNumber) {
    throw new ChangePublicationError(
      `Нужно актуализировать существующий pull request #${expectedNumber}`,
    );
  }

  const pullRequest = await readPullRequest(
    command,
    request.workspaceDirectory,
    request.target.repository,
    request.input.pullRequestNumber,
    request.signal,
  );
  assertPullRequestRepository(pullRequest, request.target.repositoryUrl);
  if (pullRequest.state !== "OPEN") {
    throw new ChangePublicationError(
      `Pull request #${pullRequest.number} должен быть открыт`,
    );
  }
  if (pullRequest.isCrossRepository) {
    throw new ChangePublicationError("Pull request должен использовать ветку из origin");
  }
  if (pullRequest.baseRefName !== PUBLICATION_BASE_BRANCH) {
    throw new ChangePublicationError("Pull request должен быть направлен в ветку main");
  }
  if (pullRequest.headRefName !== request.branch || pullRequest.headRefOid !== head) {
    throw new ChangePublicationError(
      "Pull request не содержит текущий HEAD выбранной Git-ветки",
    );
  }
  if (request.target.existingPullRequest === null && !pullRequest.isDraft) {
    throw new ChangePublicationError("Новый интеграционный pull request должен быть Draft");
  }
  if (
    request.target.existingPullRequest &&
    pullRequest.isDraft !== request.target.existingPullRequest.isDraft
  ) {
    throw new ChangePublicationError(
      "Статус Draft существующего pull request не должен изменяться",
    );
  }
  if (
    pullRequest.title !== request.input.title ||
    pullRequest.body !== request.input.body
  ) {
    throw new ChangePublicationError(
      "Название или описание pull request не совпадает с подтверждаемым содержимым",
    );
  }
  assertStablePullRequestContent(
    request.input.title,
    request.input.body,
    request.changeId,
    request.branch,
  );

  const openPullRequests = await listOpenPullRequests(
    command,
    request.workspaceDirectory,
    request.target.repository,
    request.branch,
    request.signal,
  );
  if (
    openPullRequests.length !== 1 ||
    openPullRequests[0]?.number !== pullRequest.number
  ) {
    throw new ChangePublicationError(
      "Для выбранной ветки должен существовать ровно один открытый pull request",
    );
  }
  assertPullRequestRepository(openPullRequests[0], request.target.repositoryUrl);
  if (
    openPullRequests[0].headRefName !== request.branch ||
    openPullRequests[0].isCrossRepository
  ) {
    throw new ChangePublicationError(
      "Список открытых pull request не подтверждает ветку из origin",
    );
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequestTitleSchema.parse(pullRequest.title),
  };
}

async function listOpenPullRequests(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  branch: string,
  signal: AbortSignal,
): Promise<readonly z.output<typeof openPullRequestSchema>[]> {
  try {
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
        "open",
        "--limit",
        String(MAX_OPEN_PULL_REQUESTS),
        "--json",
        "number,url,isDraft,isCrossRepository,headRefName",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return openPullRequestListSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof ChangePublicationError || signal.aborted) throw error;
    throw new ChangePublicationError("Не удалось получить открытые pull request ветки");
  }
}

async function readPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  pullRequestNumber: number,
  signal: AbortSignal,
): Promise<z.output<typeof pullRequestSchema>> {
  try {
    const result = await command(
      "gh",
      [
        "pr",
        "view",
        String(pullRequestNumber),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError(
      `Не удалось прочитать pull request #${pullRequestNumber}`,
    );
  }
}

async function assertCleanWorktree(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length > 0) {
      throw new ChangePublicationError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangePublicationError || signal.aborted) throw error;
    throw new ChangePublicationError("Не удалось проверить чистоту рабочего дерева Git");
  }
}

async function readCurrentBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: workspaceDirectory,
      signal,
    });
    return gitBranchNameSchema.parse(result.stdout);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError("Не удалось подтвердить текущую Git-ветку");
  }
}

async function readHeadCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError("Не удалось определить текущий Git HEAD");
  }
}

async function readRemoteCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal: AbortSignal,
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--exit-code", "--heads", PUBLICATION_REMOTE, ref],
      { cwd: workspaceDirectory, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]?.split("\t") ?? [];
    if (extra !== undefined || reportedRef !== ref) throw new Error("Некорректный remote ref");
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangePublicationError(
      `Не удалось прочитать ветку «${branch}» в Git remote origin`,
    );
  }
}

function assertStablePullRequestContent(
  title: string,
  body: string,
  changeId: string,
  branch: string,
): void {
  const unstableTitle =
    /\b(?:wip|draft)\b|чернов|#\d+|\b(?:task|issue|задач[аи])\s*[-#:]?\s*\d+/iu;
  if (
    unstableTitle.test(title) ||
    title.toLowerCase().includes(changeId.toLowerCase()) ||
    title.toLowerCase().includes(branch.toLowerCase())
  ) {
    throw new ChangePublicationError(
      "Название pull request должно описывать стабильный результат change",
    );
  }

  const requiredHeadings = [
    "## Суть",
    "## Ожидаемый результат",
    "## Границы change",
    "## OpenSpec change",
  ];
  const headingMatches = [...body.matchAll(/^##[^#\r\n]*\r?$/gmu)];
  if (
    headingMatches.length !== requiredHeadings.length ||
    headingMatches.some((match, index) => match[0].trimEnd() !== requiredHeadings[index])
  ) {
    throw new ChangePublicationError(
      "Описание pull request не соответствует структуре интеграционного PR",
    );
  }
  for (let index = 0; index < headingMatches.length; index += 1) {
    const heading = headingMatches[index]!;
    const contentStart = (heading.index ?? 0) + heading[0].length;
    const contentEnd = headingMatches[index + 1]?.index ?? body.length;
    if (body.slice(contentStart, contentEnd).trim().length === 0) {
      throw new ChangePublicationError(
        `Раздел «${requiredHeadings[index]}» в описании pull request не заполнен`,
      );
    }
  }
  if (!body.includes(`\`${changeId}\``)) {
    throw new ChangePublicationError(
      "Описание pull request должно содержать ID выбранного OpenSpec change",
    );
  }
}

function assertPullRequestRepository(
  pullRequest: { readonly number: number; readonly url: string },
  repositoryUrl: string,
): void {
  const expectedUrl = `${repositoryUrl.replace(/\/$/u, "")}/pull/${pullRequest.number}`;
  if (pullRequest.url !== expectedUrl) {
    throw new ChangePublicationError(
      `Pull request #${pullRequest.number} принадлежит другому GitHub-репозиторию`,
    );
  }
}

function parseGitHubRemote(remoteUrl: string): GitHubRemoteIdentity {
  const parsed = parseGitHubRemoteIdentity(remoteUrl);
  if (parsed.kind === "valid") return parsed.identity;
  if (parsed.reason === "host") {
    throw new ChangePublicationError("Git remote origin содержит недопустимый host");
  }
  if (parsed.reason === "repository") {
    throw new ChangePublicationError(
      "Git remote origin должен указывать на GitHub-репозиторий owner/name",
    );
  }
  throw new ChangePublicationError("Git remote origin должен указывать на GitHub");
}
