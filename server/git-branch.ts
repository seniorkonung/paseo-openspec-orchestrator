import { execFile } from "node:child_process";

const MAX_BRANCH_NAME_LENGTH = 512;
const MAX_OUTPUT_BYTES = 16 * 1024;

export type GitBranchDecision =
  | { kind: "main"; name: "main" }
  | { kind: "non-main"; name: string }
  | { kind: "detached" };

export type GitBranchCommand = (
  workspaceDirectory: string,
  signal: AbortSignal,
) => Promise<string>;

export type GitBranchProbe = (
  workspaceDirectory: string,
  signal: AbortSignal,
) => Promise<GitBranchDecision>;

export interface GitBranchProbeOptions {
  command?: GitBranchCommand;
  signal?: AbortSignal;
}

function runGitBranchCommand(
  workspaceDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["branch", "--show-current"],
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

function validateBranchOutput(stdout: string): string {
  const branch = stdout.trim();
  if (!branch) return branch;
  if (branch.length > MAX_BRANCH_NAME_LENGTH) {
    throw new Error("Git вернул слишком длинное имя ветки");
  }
  if ([...branch].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) {
    throw new Error("Git вернул недопустимое имя ветки");
  }
  return branch;
}

export async function readGitBranch(
  workspaceDirectory: string,
  options: GitBranchProbeOptions = {},
): Promise<GitBranchDecision> {
  const signal = options.signal ?? new AbortController().signal;
  const stdout = await (options.command ?? runGitBranchCommand)(workspaceDirectory, signal);
  const branch = validateBranchOutput(stdout);

  if (!branch) return { kind: "detached" };
  if (branch === "main") return { kind: "main", name: "main" };
  return { kind: "non-main", name: branch };
}
