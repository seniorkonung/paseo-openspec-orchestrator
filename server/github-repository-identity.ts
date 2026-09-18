import { z } from "zod";

const MAX_REMOTE_URL_LENGTH = 2_048;

export const githubHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u,
    "Ожидалось безопасное доменное имя GitHub host",
  );

export const repositoryNameWithOwnerSchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "Ожидалось имя GitHub-репозитория в формате owner/name",
  );

export interface GitHubRemoteIdentity {
  readonly host: string;
  readonly nameWithOwner: string;
}

export type GitHubRemoteParseResult =
  | {
      readonly kind: "valid";
      readonly identity: GitHubRemoteIdentity;
    }
  | {
      readonly kind: "invalid";
      readonly reason: "remote-url" | "host" | "repository";
    };

export function parseGitHubRemoteIdentity(
  remoteUrl: string,
): GitHubRemoteParseResult {
  if (remoteUrl.length > MAX_REMOTE_URL_LENGTH) {
    return { kind: "invalid", reason: "remote-url" };
  }

  try {
    const url = new URL(remoteUrl);
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname) {
      return { kind: "invalid", reason: "remote-url" };
    }
    return identityFromParts(url.hostname, url.pathname);
  } catch {
    // SCP-подобные SSH remotes не являются WHATWG URL и разбираются ниже.
  }

  const scpLike = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/u.exec(remoteUrl);
  if (!scpLike?.[1] || !scpLike[2]) {
    return { kind: "invalid", reason: "remote-url" };
  }
  return identityFromParts(scpLike[1], scpLike[2]);
}

function identityFromParts(host: string, repositoryPath: string): GitHubRemoteParseResult {
  const parsedHost = githubHostSchema.safeParse(host);
  if (!parsedHost.success) return { kind: "invalid", reason: "host" };

  const nameWithOwner = repositoryNameWithOwnerSchema.safeParse(
    repositoryPath.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""),
  );
  if (!nameWithOwner.success) {
    return { kind: "invalid", reason: "repository" };
  }
  return {
    kind: "valid",
    identity: { host: parsedHost.data, nameWithOwner: nameWithOwner.data },
  };
}
