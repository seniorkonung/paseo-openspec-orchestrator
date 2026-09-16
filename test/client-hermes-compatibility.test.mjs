import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function hermesCompilerPath() {
  const executable =
    process.platform === "win32"
      ? join("win64-bin", "hermesc.exe")
      : process.platform === "darwin"
        ? join("osx-bin", "hermesc")
        : join("linux64-bin", "hermesc");
  return join(projectDirectory, "node_modules", "react-native", "sdks", "hermesc", executable);
}

test("клиентский бандл компилируется в байткод Hermes", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "openspec-hermes-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const result = await build({
    entryPoints: [join(projectDirectory, "index.client.tsx")],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/*",
      "@tanstack/react-query",
      "react",
      "react/*",
      "react-native",
      "zod",
    ],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  assert.ok(output, "esbuild должен создать клиентский бандл");

  const bundle = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${output.replaceAll("get: () => from[key]", "value: from[key]")}\nreturn module.exports;\n})`;
  const inputPath = join(temporaryDirectory, "plugin.js");
  const outputPath = join(temporaryDirectory, "plugin.hbc");
  await writeFile(inputPath, bundle);

  const compilation = spawnSync(
    hermesCompilerPath(),
    ["-emit-binary", "-out", outputPath, inputPath, "-O"],
    { encoding: "utf8" },
  );

  assert.equal(
    compilation.status,
    0,
    `Hermes не смог скомпилировать клиентский бандл:\n${compilation.stderr}`,
  );
});
