import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
  type BoundedCommandResult,
} from "./bounded-command.ts";

const MAX_PATH_LENGTH = 8_192;
const MAX_TOOL_RECORDS = 16;

export interface RequiredMiseTool {
  readonly id: string;
  readonly displayName: string;
  readonly miseName: string;
  readonly executable: string;
}

export const REQUIRED_MISE_TOOLS = [
  {
    id: "openspec",
    displayName: "OpenSpec",
    miseName: "npm:@fission-ai/openspec",
    executable: "openspec",
  },
] as const satisfies readonly RequiredMiseTool[];

export type RequiredMiseToolDefinition = (typeof REQUIRED_MISE_TOOLS)[number];

const miseToolSchema = z
  .object({
    source: z
      .object({
        path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
      }),
    installed: z.boolean(),
    active: z.boolean(),
  });

const miseToolListSchema = z.array(miseToolSchema).max(MAX_TOOL_RECORDS);

export type MiseToolchainDecision =
  | { readonly kind: "available" }
  | { readonly kind: "mise-unavailable" }
  | {
      readonly kind: "tool-unavailable";
      readonly reason: "not-configured" | "not-installed" | "unavailable";
      readonly tool: RequiredMiseToolDefinition;
    };

export type MiseToolchainProbe = (
  workspaceDirectory: string,
  signal?: AbortSignal,
) => Promise<MiseToolchainDecision>;

export interface MiseToolchainProbeOptions {
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: typeof realpath;
}

/**
 * `mise exec` по умолчанию может установить отсутствующий tool. В workflow
 * проверки внешние установки запрещены, поэтому отключаем это поведение явно.
 * Источник: https://mise.jdx.dev/configuration/settings.html#exec-auto-install
 */
export function miseExecutionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, MISE_EXEC_AUTO_INSTALL: "0" };
}

/** Запускает tool из конфигурации текущего workspace, не обращаясь к shell. */
export function runWorkspaceMiseCommand(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  executable: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<BoundedCommandResult> {
  return command("mise", ["exec", "--no-deps", "--", executable, ...arguments_], {
    cwd: workspaceDirectory,
    env: miseExecutionEnvironment(),
    signal,
  });
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const candidatePath = relative(workspaceRoot, candidate);
  return (
    candidatePath.length > 0 &&
    !isAbsolute(candidatePath) &&
    candidatePath !== ".." &&
    !candidatePath.startsWith(`..${sep}`)
  );
}

export function createMiseToolchainProbe(
  options: MiseToolchainProbeOptions = {},
): MiseToolchainProbe {
  const command = options.command ?? runBoundedCommand;
  const resolveRealPath = options.resolveRealPath ?? realpath;

  return async (workspaceDirectory, signal) => {
    try {
      await command("mise", ["--help"], { cwd: workspaceDirectory, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: "mise-unavailable" };
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await resolveRealPath(workspaceDirectory);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw error;
    }

    for (const tool of REQUIRED_MISE_TOOLS) {
      let records: z.output<typeof miseToolListSchema>;
      try {
        const { stdout } = await command(
          "mise",
          ["ls", "--current", "--json", tool.miseName],
          { cwd: workspaceDirectory, signal },
        );
        records = miseToolListSchema.parse(JSON.parse(stdout) as unknown);
      } catch (error) {
        if (signal?.aborted) throw error;
        return { kind: "tool-unavailable", reason: "unavailable", tool };
      }

      const localRecords: Array<z.output<typeof miseToolSchema>> = [];
      for (const record of records) {
        if (!record.active) continue;
        try {
          const sourcePath = isAbsolute(record.source.path)
            ? record.source.path
            : resolve(workspaceDirectory, record.source.path);
          const sourceConfiguration = await resolveRealPath(sourcePath);
          if (isWithinWorkspace(workspaceRoot, sourceConfiguration)) {
            localRecords.push(record);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }

      const localRecord = localRecords[0];
      if (!localRecord) {
        return { kind: "tool-unavailable", reason: "not-configured", tool };
      }
      if (!localRecord.installed) {
        return { kind: "tool-unavailable", reason: "not-installed", tool };
      }

      try {
        const { stdout } = await command("mise", ["which", tool.executable], {
          cwd: workspaceDirectory,
          signal,
        });
        z.string().trim().min(1).max(MAX_PATH_LENGTH).parse(stdout);
      } catch (error) {
        if (signal?.aborted) throw error;
        return { kind: "tool-unavailable", reason: "unavailable", tool };
      }
    }

    return { kind: "available" };
  };
}

export const inspectMiseToolchain = createMiseToolchainProbe();
