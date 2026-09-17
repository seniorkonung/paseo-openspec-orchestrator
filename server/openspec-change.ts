import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ORCHESTRATOR_LIMITS,
  type OrchestratorChange,
} from "../shared/orchestrator.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";

const MAX_PATH_LENGTH = 8_192;

export const openSpecChangeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORCHESTRATOR_LIMITS.changeId)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Change ID должен быть в kebab-case");

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
  })
  .loose();

export class OpenSpecChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenSpecChangeError";
  }
}

export interface OpenSpecChangeVerifierOptions {
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: typeof realpath;
}

export type OpenSpecChangeVerifier = (
  workspaceDirectory: string,
  changeId: string,
  signal?: AbortSignal,
) => Promise<OrchestratorChange>;

export function createOpenSpecChangeVerifier(
  options: OpenSpecChangeVerifierOptions = {},
): OpenSpecChangeVerifier {
  const command = options.command ?? runBoundedCommand;
  const resolveRealPath = options.resolveRealPath ?? realpath;

  return async (workspaceDirectory, changeId, signal) => {
    const parsedChangeId = openSpecChangeIdSchema.safeParse(changeId);
    if (!parsedChangeId.success) {
      throw new OpenSpecChangeError("Change ID должен быть в kebab-case");
    }
    const normalizedChangeId = parsedChangeId.data;
    let statusOutput: string;
    try {
      ({ stdout: statusOutput } = await command(
        "openspec",
        ["status", "--change", normalizedChangeId, "--json"],
        { cwd: workspaceDirectory, signal },
      ));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OpenSpecChangeError(
        `OpenSpec не подтвердил существование change «${normalizedChangeId}»`,
      );
    }

    let status: z.output<typeof statusSchema>;
    try {
      status = statusSchema.parse(JSON.parse(statusOutput) as unknown);
    } catch {
      throw new OpenSpecChangeError(
        `OpenSpec вернул некорректные данные для change «${normalizedChangeId}»`,
      );
    }
    if (status.changeName !== normalizedChangeId) {
      throw new OpenSpecChangeError(
        `OpenSpec вернул другой change вместо «${normalizedChangeId}»`,
      );
    }

    let workspaceRoot: string;
    let changeRoot: string;
    try {
      const reportedChangeRoot = isAbsolute(status.changeRoot)
        ? status.changeRoot
        : resolve(workspaceDirectory, status.changeRoot);
      [workspaceRoot, changeRoot] = await Promise.all([
        resolveRealPath(workspaceDirectory),
        resolveRealPath(reportedChangeRoot),
      ]);
      if (!(await stat(changeRoot)).isDirectory()) {
        throw new Error("Change root не является директорией");
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OpenSpecChangeError(`Change «${normalizedChangeId}» не существует на диске`);
    }

    const changePath = relative(workspaceRoot, changeRoot);
    if (
      changePath.length === 0 ||
      isAbsolute(changePath) ||
      changePath === ".." ||
      changePath.startsWith(`..${sep}`)
    ) {
      throw new OpenSpecChangeError(
        `Change «${normalizedChangeId}» находится за пределами текущего workspace`,
      );
    }
    let gitRoot: string;
    try {
      const { stdout } = await command("git", ["rev-parse", "--show-toplevel"], {
        cwd: workspaceRoot,
        signal,
      });
      const reportedGitRoot = z.string().trim().min(1).max(MAX_PATH_LENGTH).parse(stdout);
      gitRoot = await resolveRealPath(reportedGitRoot);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OpenSpecChangeError("Не удалось определить корень Git-репозитория");
    }
    const gitChangePath = relative(gitRoot, changeRoot);
    if (
      gitChangePath.length === 0 ||
      isAbsolute(gitChangePath) ||
      gitChangePath === ".." ||
      gitChangePath.startsWith(`..${sep}`)
    ) {
      throw new OpenSpecChangeError(
        `Change «${normalizedChangeId}» находится за пределами Git-репозитория`,
      );
    }
    const gitObjectPath = gitChangePath.split(sep).join("/");

    try {
      await command("git", ["cat-file", "-e", `HEAD:${gitObjectPath}`], {
        cwd: gitRoot,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OpenSpecChangeError(
        `Change «${normalizedChangeId}» не добавлен в последний Git-коммит; сделайте отдельный коммит change и повторите вызов`,
      );
    }

    try {
      const { stdout } = await command(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: gitRoot, signal },
      );
      if (stdout.length > 0) {
        throw new OpenSpecChangeError(
          "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
        );
      }
    } catch (error) {
      if (error instanceof OpenSpecChangeError || signal?.aborted) throw error;
      throw new OpenSpecChangeError("Не удалось проверить чистоту рабочего дерева Git");
    }

    return { id: normalizedChangeId };
  };
}

export const verifyOpenSpecChange = createOpenSpecChangeVerifier();
