import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { createChangeArtifactStatusGateway, type ChangeArtifactStatusGateway } from "./change-artifact-status.ts";
import { ChangeArchiveError, pendingArchiveSessionSchema, type ArchivedChange, type PendingArchiveSession } from "./change-archive-model.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { assertCleanReviewWorktree, readCurrentReviewBranch, readReviewHeadCommit } from "./review-publication-gateway.ts";
import type { RootPullRequestIdentity, RootPullRequestService } from "./root-pull-request.ts";

const listSchema = z.object({ changes: z.array(z.object({
  name: openSpecChangeIdSchema,
  totalTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
}).loose()) }).loose();
const MAX_SPEC_BYTES = 1024 * 1024;

export interface ChangeArchiveVerification {
  plan(workspaceDirectory: string, changeId: string, identity: RootPullRequestIdentity, signal?: AbortSignal): Promise<PendingArchiveSession>;
  inspectRecovery(workspaceDirectory: string, session: PendingArchiveSession, signal?: AbortSignal): Promise<"fresh" | "partial" | "committed">;
  verifyCommit(workspaceDirectory: string, session: PendingArchiveSession, signal?: AbortSignal): Promise<ArchivedChange>;
  verifyArchived(workspaceDirectory: string, archived: ArchivedChange, signal?: AbortSignal): Promise<void>;
}

export function createChangeArchiveVerification(options: {
  readonly rootPullRequest: RootPullRequestService;
  readonly command?: BoundedCommandRunner;
  readonly statusGateway?: ChangeArtifactStatusGateway;
  readonly now?: () => Date;
}): ChangeArchiveVerification {
  const command = options.command ?? runBoundedCommand;
  const statusGateway = options.statusGateway ?? createChangeArtifactStatusGateway({ command });
  const now = options.now ?? (() => new Date());

  const readChanges = async (directory: string, signal?: AbortSignal) => {
    const { stdout } = await runWorkspaceMiseCommand(command, directory, "openspec", ["list", "--json"], signal);
    return listSchema.parse(JSON.parse(stdout) as unknown).changes;
  };

  const verifyTree = async (directory: string, session: PendingArchiveSession, signal?: AbortSignal): Promise<void> => {
    const root = await realpath(directory);
    const source = join(root, session.sourcePath);
    const target = join(root, session.archivePath);
    if (await pathExists(source)) throw new ChangeArchiveError("Активный каталог change остался после архивации");
    const targetStat = await lstat(target).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) throw new ChangeArchiveError("Каталог архива отсутствует или не является обычным каталогом");
    const resolved = await realpath(target);
    if (relative(root, resolved).split(sep).some((part) => part === "..")) throw new ChangeArchiveError("Архив вышел за пределы репозитория");
    const specRoot = `${dirname(dirname(session.sourcePath))}/specs/`;
    const allowedSpecs = new Set(session.deltaSpecPaths.map((path) => `${specRoot}${path.slice("specs/".length)}`));
    const [before, after, mainTree] = await Promise.all([
      readTree(command, directory, session.baselineCommit, session.sourcePath, signal),
      readTree(command, directory, "HEAD", session.archivePath, signal),
      readTreePaths(command, directory, "HEAD", [...allowedSpecs], signal, false),
    ]);
    if (before.size === 0 || before.size !== after.size) throw new ChangeArchiveError("Архив не сохранил все файлы change");
    for (const [path, entry] of before) {
      const expected = `${session.archivePath}${path.slice(session.sourcePath.length)}`;
      if (after.get(expected) !== entry) throw new ChangeArchiveError(`Архив изменил файл ${path}`);
    }
    const { stdout: changed } = await command("git", ["diff", "--name-only", "-z", session.baselineCommit, "HEAD"], { cwd: directory, signal });
    for (const path of changed.split("\0").filter(Boolean)) {
      if (!path.startsWith(`${session.sourcePath}/`) && !path.startsWith(`${session.archivePath}/`) && !allowedSpecs.has(path)) {
        throw new ChangeArchiveError(`Архивный коммит изменил посторонний путь ${path}`);
      }
    }
    await assertNoIgnoredFiles(command, directory, session.archivePath, signal);
    await verifyDeltaSpecs(root, session, specRoot, after, mainTree);
  };

  return {
    async plan(directory, changeIdInput, identity, signal) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const head = await options.rootPullRequest.synchronize(directory, changeId, identity.changeBranch, signal);
      const pr = await options.rootPullRequest.inspect(directory, changeId, identity.changeBranch, identity, signal);
      if (pr.kind !== "open" || !pr.isDraft || pr.head !== head) throw new ChangeArchiveError("Перед архивацией нужен открытый Draft PR с неизменным HEAD");
      const status = await statusGateway.read(directory, changeId, signal);
      if ([...status.artifacts.values()].some((artifact) => artifact.status !== "done" && artifact.status !== "skipped")) {
        throw new ChangeArchiveError("Не все артефакты change завершены");
      }
      const matches = (await readChanges(directory, signal)).filter((change) => change.name === changeId);
      if (matches.length !== 1 || matches[0]!.completedTasks !== matches[0]!.totalTasks) {
        throw new ChangeArchiveError("Список OpenSpec не подтверждает завершение всех задач");
      }
      const sourcePath = relative(status.gitRoot, status.changeRoot).split(sep).join("/");
      if (sourcePath.split("/").at(-2) !== "changes") throw new ChangeArchiveError("Change должен находиться в каталоге openspec/changes");
      if ((await readTree(command, directory, head, sourcePath, signal)).size === 0) throw new ChangeArchiveError("В baseline отсутствуют файлы выбранного change");
      await assertNoIgnoredFiles(command, directory, sourcePath, signal);
      const deltaSpecPaths = (status.artifactPaths.get("specs")?.existingOutputPaths ?? []).map((path) => {
        const local = relative(status.changeRoot, path).split(sep).join("/");
        if (!/^specs\/.+\/spec\.md$/u.test(local) || local.split("/").includes("..")) {
          throw new ChangeArchiveError("OpenSpec вернул недопустимый путь delta spec");
        }
        return local;
      });
      if (new Set(deltaSpecPaths).size !== deltaSpecPaths.length) throw new ChangeArchiveError("OpenSpec повторил путь delta spec");
      const date = localDate(now());
      const targetName = /^\d{4}-\d{2}-\d{2}-/u.test(changeId) ? changeId : `${date}-${changeId}`;
      const archivePath = `${dirname(sourcePath)}/archive/${targetName}`;
      const archiveDirectory = join(status.gitRoot, dirname(archivePath));
      const archiveInfo = await lstat(archiveDirectory).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (archiveInfo && (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink())) throw new ChangeArchiveError("Каталог archive небезопасен");
      if (archiveInfo) {
        const localArchive = relative(status.gitRoot, await realpath(archiveDirectory));
        if (!localArchive || localArchive === ".." || localArchive.startsWith(`..${sep}`)) throw new ChangeArchiveError("Каталог archive находится вне репозитория");
      }
      if (await pathExists(join(status.gitRoot, archivePath))) throw new ChangeArchiveError("Архив с таким именем уже существует");
      return pendingArchiveSessionSchema.parse({ changeId, branch: identity.changeBranch, baselineCommit: head, sourcePath, archivePath, deltaSpecPaths, rootPullRequest: identity });
    },
    async inspectRecovery(directory, sessionInput, signal) {
      const session = pendingArchiveSessionSchema.parse(sessionInput);
      const branch = await readCurrentReviewBranch(command, directory, signal);
      const head = await readReviewHeadCommit(command, directory, signal);
      if (branch !== session.branch) throw new ChangeArchiveError("Во время архивации изменилась ветка");
      if (head === session.baselineCommit) {
        const sourceExists = await pathExists(join(directory, session.sourcePath));
        const targetExists = await pathExists(join(directory, session.archivePath));
        const { stdout: worktree } = await command("git", ["status", "--porcelain", "-z"], { cwd: directory, signal });
        return sourceExists && !targetExists && worktree.length === 0 ? "fresh" : "partial";
      }
      await assertSingleCommit(command, directory, session.baselineCommit, signal);
      return "committed";
    },
    async verifyCommit(directory, sessionInput, signal) {
      const session = pendingArchiveSessionSchema.parse(sessionInput);
      await assertCleanReviewWorktree(command, directory, signal);
      const commit = await assertSingleCommit(command, directory, session.baselineCommit, signal);
      await verifyTree(directory, session, signal);
      const matches = (await readChanges(directory, signal)).filter((change) => change.name === session.changeId);
      if (matches.length !== 0) throw new ChangeArchiveError("Архивированный change всё ещё числится активным");
      return { session, commit };
    },
    async verifyArchived(directory, archived, signal) {
      const parsed = pendingArchiveSessionSchema.parse(archived.session);
      await assertCleanReviewWorktree(command, directory, signal);
      const head = await readReviewHeadCommit(command, directory, signal);
      if (head !== archived.commit) throw new ChangeArchiveError("HEAD изменился после архивного коммита");
      await assertSingleCommit(command, directory, parsed.baselineCommit, signal);
      await verifyTree(directory, parsed, signal);
    },
  };
}

async function assertSingleCommit(command: BoundedCommandRunner, directory: string, baseline: string, signal?: AbortSignal): Promise<string> {
  const [{ stdout: headOutput }, { stdout: parentOutput }, { stdout: subjectOutput }] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], { cwd: directory, signal }),
    command("git", ["rev-parse", "HEAD^"], { cwd: directory, signal }),
    command("git", ["log", "-1", "--format=%s"], { cwd: directory, signal }),
  ]);
  const head = headOutput.trim();
  const subject = subjectOutput.trim();
  if (parentOutput.trim() !== baseline || !/^(feat|fix|refactor|test|docs|chore|build|ci|perf|style)\([a-z0-9-]+\): .+/u.test(subject) || subject.length >= 72) {
    throw new ChangeArchiveError("Архивация требует ровно один Conventional Commit после baseline");
  }
  return head;
}

async function readTree(command: BoundedCommandRunner, directory: string, revision: string, prefix: string, signal?: AbortSignal, regularOnly = true): Promise<Map<string, string>> {
  return readTreePaths(command, directory, revision, [prefix], signal, regularOnly);
}

async function readTreePaths(command: BoundedCommandRunner, directory: string, revision: string, paths: readonly string[], signal?: AbortSignal, regularOnly = true): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let index = 0; index < paths.length; index += 64) {
    const literals = paths.slice(index, index + 64).map((path) => `:(literal)${path}`);
    const { stdout } = await command("git", ["ls-tree", "-r", "-z", revision, "--", ...literals], { cwd: directory, signal });
    for (const record of stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
      if (!match || (regularOnly && match[1] !== "100644" && match[1] !== "100755")) throw new ChangeArchiveError("Архив содержит необычный Git-объект");
      result.set(match[3]!, `${match[1]}:${match[2]}`);
    }
  }
  return result;
}

async function assertNoIgnoredFiles(command: BoundedCommandRunner, directory: string, path: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await command("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", path], { cwd: directory, signal });
  if (stdout.length > 0) throw new ChangeArchiveError("Каталог change содержит игнорируемые Git файлы");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function verifyDeltaSpecs(root: string, session: PendingArchiveSession, specRoot: string, tree: ReadonlyMap<string, string>, mainTree: ReadonlyMap<string, string>): Promise<void> {
  const prefix = `${session.archivePath}/specs/`;
  const declared = new Set(session.deltaSpecPaths.map((path) => `${session.archivePath}/${path}`));
  const actual = [...tree.keys()].filter((path) => path.startsWith(prefix) && path.endsWith("/spec.md"));
  if (declared.size !== actual.length || actual.some((path) => !declared.has(path))) {
    throw new ChangeArchiveError("Delta specs не совпадают с путями из OpenSpec status");
  }
  const metadata = await readBoundedSpec(root, join(root, session.archivePath, ".openspec.yaml"));
  const retireAllowed = /^retire_capabilities:\s*true\s*$/mu.test(metadata ?? "");
  for (const path of actual) {
    const capability = path.slice(prefix.length, -"/spec.md".length);
    if (!capability || capability.split("/").some((part) => part === "." || part === ".." || part === "")) throw new ChangeArchiveError("Некорректный путь delta spec");
    const delta = await readBoundedSpec(root, join(root, path));
    if (delta === null) throw new ChangeArchiveError(`Отсутствует delta spec ${path}`);
    const mainRepositoryPath = `${specRoot}${capability}/spec.md`;
    const mainPath = join(root, mainRepositoryPath);
    const main = await readBoundedSpec(root, mainPath);
    if (main === null && !retireAllowed) throw new ChangeArchiveError(`Spec ${capability}: основной spec отсутствует после sync`);
    if (main !== null && !/^100(644|755):/u.test(mainTree.get(mainRepositoryPath) ?? "")) {
      throw new ChangeArchiveError(`Spec ${capability} отсутствует в архивном коммите`);
    }
    assertDeltaApplied(delta, main ?? "", capability);
  }
}

async function readBoundedSpec(root: string, path: string): Promise<string | null> {
  const info = await lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SPEC_BYTES) {
    throw new ChangeArchiveError("Spec должен быть обычным файлом размером не более 1 MiB");
  }
  const resolved = await realpath(path);
  const local = relative(root, resolved);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new ChangeArchiveError("Spec находится вне репозитория");
  return readFile(path, "utf8");
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertDeltaApplied(delta: string, main: string, capability: string): void {
  const mainRequirements = parseRequirements(main);
  let inspected = 0;
  for (const section of delta.replace(/\r\n?/gu, "\n").split(/(?=^##\s+)/mu)) {
    const heading = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/mu.exec(section);
    if (!heading) continue;
    const before = inspected;
    const operation = heading[1]!;
    if (operation === "RENAMED") {
      for (const match of section.matchAll(/-\s*FROM:\s*`?([^`\n]+)`?\s*\n\s*-\s*TO:\s*`?([^`\n]+)`?/gu)) {
        inspected++;
        const oldName = match[1]!.trim().replace(/^### Requirement:\s*/u, "");
        const newName = match[2]!.trim().replace(/^### Requirement:\s*/u, "");
        if (mainRequirements.has(oldName) || !mainRequirements.has(newName)) throw new ChangeArchiveError(`Spec ${capability}: переименование не синхронизировано`);
      }
      if (inspected === before) throw new ChangeArchiveError(`Spec ${capability}: отсутствуют данные переименования`);
      continue;
    }
    for (const [name, body] of parseRequirements(section)) {
      inspected++;
      const actual = mainRequirements.get(name);
      if (operation === "REMOVED") {
        if (actual !== undefined) throw new ChangeArchiveError(`Spec ${capability}: требование ${name} не удалено`);
      } else if (!body.trim() || actual === undefined || !requirementIncludes(actual, body)) {
        throw new ChangeArchiveError(`Spec ${capability}: требование ${name} не синхронизировано`);
      }
    }
    if (inspected === before) throw new ChangeArchiveError(`Spec ${capability}: раздел ${operation} не содержит требований`);
  }
  if (inspected === 0) throw new ChangeArchiveError(`Spec ${capability}: delta spec не содержит проверяемых требований`);
}

function parseRequirements(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  const blocks = markdown.replace(/\r\n?/gu, "\n").split(/(?=^### Requirement:\s*)/mu);
  for (const block of blocks) {
    const match = /^### Requirement:\s*([^\n]+)\n?/u.exec(block);
    if (match) {
      const name = match[1]!.trim();
      if (result.has(name)) throw new ChangeArchiveError(`Повторяется требование ${name}`);
      result.set(name, block.slice(match[0].length).trim());
    }
  }
  return result;
}

function requirementIncludes(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const expectedParts = expected.split(/(?=^#### Scenario:\s*)/mu).map(normalize).filter(Boolean);
  const actualNormalized = normalize(actual);
  return expectedParts.every((part) => actualNormalized.includes(part));
}
