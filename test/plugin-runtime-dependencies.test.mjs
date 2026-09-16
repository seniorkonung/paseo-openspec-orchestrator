import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}

test("манифест устанавливает только runtime-зависимости управляемого плагина", async () => {
  const manifest = await readJson("paseo-plugin.json");
  assert.deepEqual(manifest.build, [["npm", "ci", "--omit=dev"]]);
});

test("MCP-сервер является runtime-зависимостью, а клиент используется только тестами", async () => {
  const packageJson = await readJson("package.json");
  assert.equal(packageJson.dependencies["@modelcontextprotocol/server"], "^2.0.0");
  assert.equal(packageJson.dependencies["@modelcontextprotocol/node"], "^2.0.0");
  assert.equal(packageJson.devDependencies["@modelcontextprotocol/client"], "^2.0.0");
  assert.equal(packageJson.devDependencies["@modelcontextprotocol/server"], undefined);
  assert.equal(packageJson.devDependencies["@modelcontextprotocol/node"], undefined);
});
