import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
export const DEFAULT_COMMAND_MAX_BUFFER = 1024 * 1024;

export interface BoundedCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

export interface BoundedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type BoundedCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options?: BoundedCommandOptions,
) => Promise<BoundedCommandResult>;

/** Запускает исполняемый файл напрямую: аргументы никогда не проходят через shell. */
export const runBoundedCommand: BoundedCommandRunner = async (
  executable,
  arguments_,
  options = {},
) => {
  const result = await execFileAsync(executable, [...arguments_], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? DEFAULT_COMMAND_MAX_BUFFER,
    signal: options.signal,
    shell: false,
    timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};
