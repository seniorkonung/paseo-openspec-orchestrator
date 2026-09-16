import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasOpenSpecInstallation } from "../server/openspec-installation.ts";

test("определяет OpenSpec по корневому openspec/config.yaml", async (context) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "openspec-installation-"));
  context.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  await mkdir(join(workspaceDirectory, "openspec"));
  await writeFile(join(workspaceDirectory, "openspec", "config.yaml"), "schema: custom\n");

  assert.equal(await hasOpenSpecInstallation(workspaceDirectory), true);
});

test("возвращает false при отсутствии конфигурации OpenSpec", async (context) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "openspec-installation-"));
  context.after(() => rm(workspaceDirectory, { recursive: true, force: true }));

  assert.equal(await hasOpenSpecInstallation(workspaceDirectory), false);
});

test("не считает директорию config.yaml конфигурацией OpenSpec", async (context) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "openspec-installation-"));
  context.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  await mkdir(join(workspaceDirectory, "openspec", "config.yaml"), { recursive: true });

  assert.equal(await hasOpenSpecInstallation(workspaceDirectory), false);
});
