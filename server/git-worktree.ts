import { execFile } from "node:child_process";

const MAX_OUTPUT_BYTES = 256 * 1024;

export type GitWorktreeDecision = { kind: "clean" } | { kind: "dirty" };

export type GitWorktreeCommand = (
  workspaceDirectory: string,
  signal: AbortSignal,
) => Promise<string>;

export type GitWorktreeProbe = (
  workspaceDirectory: string,
  signal: AbortSignal,
) => Promise<GitWorktreeDecision>;

export interface GitWorktreeProbeOptions {
  command?: GitWorktreeCommand;
  signal?: AbortSignal;
}

function runGitStatusCommand(
  workspaceDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        signal,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );

    child.once("error", (error) => {
      reject(error);
    });
  });
}

export async function readGitWorktreeStatus(
  workspaceDirectory: string,
  options: GitWorktreeProbeOptions = {},
): Promise<GitWorktreeDecision> {
  const signal = options.signal ?? new AbortController().signal;
  const stdout = await (options.command ?? runGitStatusCommand)(workspaceDirectory, signal);
  return stdout.length === 0 ? { kind: "clean" } : { kind: "dirty" };
}
