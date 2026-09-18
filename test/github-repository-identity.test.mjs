import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubRemoteIdentity } from "../server/github-repository-identity.ts";

test("разбирает HTTPS, SSH URL и SCP-подобный GitHub remote", () => {
  const expected = {
    kind: "valid",
    identity: { host: "github.com", nameWithOwner: "example/project" },
  };

  assert.deepEqual(
    parseGitHubRemoteIdentity("https://github.com/example/project.git"),
    expected,
  );
  assert.deepEqual(
    parseGitHubRemoteIdentity("ssh://git@github.com/example/project.git"),
    expected,
  );
  assert.deepEqual(
    parseGitHubRemoteIdentity("git@github.com:example/project.git"),
    expected,
  );
});

test("нормализует регистр host, не изменяя owner/name", () => {
  assert.deepEqual(
    parseGitHubRemoteIdentity("git@GitHub.COM:Example/Project.git"),
    {
      kind: "valid",
      identity: { host: "github.com", nameWithOwner: "Example/Project" },
    },
  );
});

test("возвращает типизированную причину для каждого недоверенного сегмента", () => {
  assert.deepEqual(parseGitHubRemoteIdentity("ftp://github.com/example/project"), {
    kind: "invalid",
    reason: "remote-url",
  });
  assert.deepEqual(parseGitHubRemoteIdentity("git@bad_host:example/project.git"), {
    kind: "invalid",
    reason: "host",
  });
  assert.deepEqual(parseGitHubRemoteIdentity("git@github.com:single-name.git"), {
    kind: "invalid",
    reason: "repository",
  });
});

test("ограничивает размер remote до разбора", () => {
  assert.deepEqual(
    parseGitHubRemoteIdentity(`https://github.com/example/${"a".repeat(3_000)}`),
    { kind: "invalid", reason: "remote-url" },
  );
});
