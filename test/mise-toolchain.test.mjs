import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMiseToolchainProbe,
  REQUIRED_MISE_TOOLS,
} from "../server/mise-toolchain.ts";

const openSpecTool = REQUIRED_MISE_TOOLS[0];

async function workspaceFixture(context, prefix = "mise-toolchain-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configuration = join(root, "mise.toml");
  await writeFile(configuration, `[tools]\n"${openSpecTool.miseName}" = "latest"\n`);
  return { root, configuration };
}

function toolRecord(configuration, overrides = {}) {
  return {
    source: { type: "mise.toml", path: configuration },
    installed: true,
    active: true,
    ...overrides,
  };
}

test("проверяет локально настроенный и установленный mise tool без чтения версии", async (context) => {
  const { root, configuration } = await workspaceFixture(context);
  const calls = [];
  const probe = createMiseToolchainProbe({
    async command(executable, arguments_, options) {
      calls.push({ executable, arguments_, options });
      if (arguments_[0] === "ls") {
        return { stdout: JSON.stringify([toolRecord(configuration)]), stderr: "" };
      }
      return { stdout: "/mise/installs/openspec/bin/openspec\n", stderr: "" };
    },
  });

  assert.deepEqual(await probe(root), { kind: "available" });
  assert.deepEqual(
    calls.map(({ executable, arguments_ }) => [executable, ...arguments_]),
    [
      ["mise", "--help"],
      ["mise", "ls", "--current", "--json", openSpecTool.miseName],
      ["mise", "which", openSpecTool.executable],
    ],
  );
  assert.ok(calls.every(({ options }) => options.cwd === root));
});

test("различает отсутствие mise и локальной настройки обязательного tool", async (context) => {
  const { root } = await workspaceFixture(context);
  const missingMise = createMiseToolchainProbe({
    command: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(await missingMise(root), { kind: "mise-unavailable" });

  const notConfigured = createMiseToolchainProbe({
    async command(_executable, arguments_) {
      return {
        stdout: arguments_[0] === "ls" ? "[]" : "mise help\n",
        stderr: "",
      };
    },
  });
  assert.deepEqual(await notConfigured(root), {
    kind: "tool-unavailable",
    reason: "not-configured",
    tool: openSpecTool,
  });
});

test("не принимает настройку mise tool из-за пределов workspace", async (context) => {
  const { root } = await workspaceFixture(context);
  const external = await workspaceFixture(context, "external-mise-");
  const probe = createMiseToolchainProbe({
    async command(_executable, arguments_) {
      return {
        stdout:
          arguments_[0] === "ls"
            ? JSON.stringify([toolRecord(external.configuration)])
            : "mise help\n",
        stderr: "",
      };
    },
  });

  assert.deepEqual(await probe(root), {
    kind: "tool-unavailable",
    reason: "not-configured",
    tool: openSpecTool,
  });
});

test("не запускает и не устанавливает автоматически отсутствующий mise tool", async (context) => {
  const { root, configuration } = await workspaceFixture(context);
  const calls = [];
  const probe = createMiseToolchainProbe({
    async command(executable, arguments_) {
      calls.push([executable, ...arguments_]);
      return {
        stdout:
          arguments_[0] === "ls"
            ? JSON.stringify([toolRecord(configuration, { installed: false })])
            : "mise help\n",
        stderr: "",
      };
    },
  });

  assert.deepEqual(await probe(root), {
    kind: "tool-unavailable",
    reason: "not-installed",
    tool: openSpecTool,
  });
  assert.equal(calls.length, 2);
});

test("сообщает о недоступном executable установленного mise tool", async (context) => {
  const { root, configuration } = await workspaceFixture(context);
  const probe = createMiseToolchainProbe({
    async command(_executable, arguments_) {
      if (arguments_[0] === "ls") {
        return { stdout: JSON.stringify([toolRecord(configuration)]), stderr: "" };
      }
      if (arguments_[0] === "which") throw new Error("broken executable");
      return { stdout: "mise help\n", stderr: "" };
    },
  });

  assert.deepEqual(await probe(root), {
    kind: "tool-unavailable",
    reason: "unavailable",
    tool: openSpecTool,
  });
});
