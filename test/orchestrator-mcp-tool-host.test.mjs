import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  defineMcpTool,
  McpToolError,
  OrchestratorMcpToolHost,
} from "../server/orchestrator-mcp-tool-host.ts";

async function connectClient(url) {
  const client = new Client({ name: "orchestrator-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end("{}");
  });
}

test("MCP-хост выполняет текстовые и структурированные инструменты повторно", async (context) => {
  const host = await OrchestratorMcpToolHost.listen();
  context.after(() => host.close());
  let echoCalls = 0;
  const scope = host.expose({
    echo: defineMcpTool({
      description: "Повторить текст",
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        echoCalls += 1;
        return { text: value };
      },
    }),
    decide: defineMcpTool({
      description: "Принять решение",
      inputSchema: z.object({ decision: z.enum(["accept", "revise"]) }),
      outputSchema: z.object({ accepted: z.boolean() }),
      execute: ({ decision }) => ({
        text: "Решение обработано",
        data: { accepted: decision === "accept" },
      }),
    }),
  });
  const client = await connectClient(scope.url);
  context.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(({ name }) => name).sort(),
    ["decide", "echo"],
  );

  const echoes = await Promise.all([
    client.callTool({ name: "echo", arguments: { value: "первый" } }),
    client.callTool({ name: "echo", arguments: { value: "второй" } }),
  ]);
  assert.deepEqual(echoes.map(firstText), ["первый", "второй"]);
  assert.equal(echoCalls, 2);

  const decision = await client.callTool({
    name: "decide",
    arguments: { decision: "accept" },
  });
  assert.equal(firstText(decision), "Решение обработано");
  assert.deepEqual(decision.structuredContent, { accepted: true });

  const invalid = await client.callTool({ name: "echo", arguments: { value: 42 } });
  assert.equal(invalid.isError, true);
  assert.match(firstText(invalid), /Invalid|validation|string/i);
  assert.equal(echoCalls, 2);
});

test("MCP-хост различает ожидаемые и внутренние ошибки", async (context) => {
  const logEntries = [];
  const host = await OrchestratorMcpToolHost.listen({
    logger: { error: (...args) => logEntries.push(args) },
  });
  context.after(() => host.close());
  const scope = host.expose({
    expected: defineMcpTool({
      description: "Вернуть ожидаемую ошибку",
      inputSchema: z.object({}),
      execute: () => {
        throw new McpToolError("Нужно исправить аргументы");
      },
    }),
    unexpected: defineMcpTool({
      description: "Вернуть внутреннюю ошибку",
      inputSchema: z.object({ secret: z.string() }),
      execute: () => {
        throw new Error("Внутренняя диагностическая причина");
      },
    }),
    malformed: defineMcpTool({
      description: "Вернуть невалидный структурированный результат",
      inputSchema: z.object({}),
      outputSchema: z.object({ accepted: z.boolean() }),
      execute: () => ({
        text: "Невалидный результат",
        data: { accepted: "yes" },
      }),
    }),
  });
  const client = await connectClient(scope.url);
  context.after(() => client.close());

  const expected = await client.callTool({ name: "expected", arguments: {} });
  assert.equal(expected.isError, true);
  assert.equal(firstText(expected), "Нужно исправить аргументы");
  assert.equal(logEntries.length, 0);

  const unexpected = await client.callTool({
    name: "unexpected",
    arguments: { secret: "не логировать payload" },
  });
  assert.equal(unexpected.isError, true);
  assert.equal(firstText(unexpected), "Инструмент завершился с внутренней ошибкой");
  assert.equal(JSON.stringify(unexpected).includes("диагностическая"), false);
  assert.equal(JSON.stringify(logEntries).includes("не логировать payload"), false);
  assert.equal(logEntries.length, 1);

  const malformed = await client.callTool({ name: "malformed", arguments: {} });
  assert.equal(malformed.isError, true);
  assert.equal(firstText(malformed), "Инструмент завершился с внутренней ошибкой");
  assert.equal(JSON.stringify(malformed).includes("accepted"), false);
  assert.equal(logEntries.length, 2);
});

test("scope неизменяемо дополняет конфигурацию агента и preapproval", async (context) => {
  const host = await OrchestratorMcpToolHost.listen();
  context.after(() => host.close());
  const scope = host.expose({
    first: defineMcpTool({
      description: "Первый инструмент",
      inputSchema: z.object({}),
      execute: () => ({ text: "ok" }),
    }),
    second: defineMcpTool({
      description: "Второй инструмент",
      inputSchema: z.object({}),
      execute: () => ({ text: "ok" }),
    }),
  });
  const original = {
    provider: "codex/gpt-test",
    mcpServers: {
      existing: { type: "stdio", command: "existing-mcp" },
    },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "existing", tool: "inspect" }],
    },
  };

  const configured = scope.configureAgent(original);
  assert.notEqual(configured, original);
  assert.deepEqual(original, {
    provider: "codex/gpt-test",
    mcpServers: {
      existing: { type: "stdio", command: "existing-mcp" },
    },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "existing", tool: "inspect" }],
    },
  });
  assert.deepEqual(configured.mcpServers, {
    existing: { type: "stdio", command: "existing-mcp" },
    [scope.serverName]: { type: "http", url: scope.url },
  });
  assert.deepEqual(configured.toolPolicy.preapproved, [
    { kind: "mcp", server: "existing", tool: "inspect" },
    { kind: "mcp", server: scope.serverName, tool: "first" },
    { kind: "mcp", server: scope.serverName, tool: "second" },
  ]);
  assert.equal("headers" in configured.mcpServers[scope.serverName], false);

  assert.throws(
    () =>
      scope.configureAgent({
        provider: "codex/gpt-test",
        mcpServers: {
          [scope.serverName]: { type: "http", url: "http://127.0.0.1/other" },
        },
      }),
    /уже содержит MCP-сервер/,
  );

  await scope.close();
  assert.throws(() => scope.configureAgent(original), /закрытым MCP scope/);
});

test("параллельные хосты и scope изолируют порты и каталоги инструментов", async (context) => {
  const firstHost = await OrchestratorMcpToolHost.listen();
  const secondHost = await OrchestratorMcpToolHost.listen();
  context.after(() => Promise.all([firstHost.close(), secondHost.close()]));
  assert.notEqual(firstHost.port, secondHost.port);

  const alpha = firstHost.expose({
    alpha: defineMcpTool({
      description: "Alpha",
      inputSchema: z.object({}),
      execute: () => ({ text: "alpha" }),
    }),
  });
  const beta = firstHost.expose({
    beta: defineMcpTool({
      description: "Beta",
      inputSchema: z.object({}),
      execute: () => ({ text: "beta" }),
    }),
  });
  const gamma = secondHost.expose({
    gamma: defineMcpTool({
      description: "Gamma",
      inputSchema: z.object({}),
      execute: () => ({ text: "gamma" }),
    }),
  });
  assert.notEqual(alpha.url, beta.url);

  const [alphaClient, betaClient, gammaClient] = await Promise.all([
    connectClient(alpha.url),
    connectClient(beta.url),
    connectClient(gamma.url),
  ]);
  context.after(() => Promise.all([alphaClient.close(), betaClient.close(), gammaClient.close()]));

  const catalogs = await Promise.all([
    alphaClient.listTools(),
    betaClient.listTools(),
    gammaClient.listTools(),
  ]);
  assert.deepEqual(
    catalogs.map(({ tools }) => tools.map(({ name }) => name)),
    [["alpha"], ["beta"], ["gamma"]],
  );

  await alpha.close();
  await alpha.close();
  assert.equal((await fetch(alpha.url)).status, 404);
  assert.equal(firstText(await betaClient.callTool({ name: "beta", arguments: {} })), "beta");
});

test("localhost-защита отклоняет посторонние Host и Origin без Bearer Token", async (context) => {
  const host = await OrchestratorMcpToolHost.listen();
  context.after(() => host.close());
  const scope = host.expose({
    ping: defineMcpTool({
      description: "Проверить соединение",
      inputSchema: z.object({}),
      execute: () => ({ text: "pong" }),
    }),
  });

  assert.equal(
    await rawRequest(scope.url, {
      host: "evil.example",
      "content-type": "application/json",
    }),
    403,
  );
  assert.equal(
    await rawRequest(scope.url, {
      host: `127.0.0.1:${host.port}`,
      origin: "https://evil.example",
      "content-type": "application/json",
    }),
    403,
  );

  const client = await connectClient(scope.url);
  context.after(() => client.close());
  assert.equal(firstText(await client.callTool({ name: "ping", arguments: {} })), "pong");
});

test("обработчик живёт без TTL и получает отмену только при закрытии scope", async (context) => {
  const host = await OrchestratorMcpToolHost.listen();
  context.after(() => host.close());
  let release;
  let executionSignal;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const scope = host.expose({
    wait: defineMcpTool({
      description: "Ожидать внешнее решение",
      inputSchema: z.object({}),
      execute: (_input, { signal }) => {
        executionSignal = signal;
        startedResolve();
        return new Promise((resolve) => {
          release = () => resolve({ text: "освобождён" });
          signal.addEventListener("abort", () => resolve({ text: "отменён" }), {
            once: true,
          });
        });
      },
    }),
  });
  const client = await connectClient(scope.url);
  context.after(() => client.close());

  const call = client.callTool({ name: "wait", arguments: {} });
  await started;
  let state = "pending";
  void call.then(() => {
    state = "resolved";
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state, "pending");
  assert.equal(executionSignal.aborted, false);

  release();
  assert.equal(firstText(await call), "освобождён");

  const secondCall = client.callTool({ name: "wait", arguments: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.close();
  assert.equal(executionSignal.aborted, true);
  await assert.rejects(secondCall);
});

test("MCP-хост сразу отклоняет некорректные определения", async (context) => {
  assert.throws(
    () =>
      defineMcpTool({
        description: "   ",
        inputSchema: z.object({}),
        execute: () => ({ text: "ok" }),
      }),
    /Описание MCP-инструмента/,
  );
  assert.throws(() => new McpToolError(" "), /Сообщение ошибки MCP-инструмента/);

  const host = await OrchestratorMcpToolHost.listen();
  context.after(() => host.close());
  assert.throws(() => host.expose({}), /хотя бы один инструмент/);
  assert.throws(
    () =>
      host.expose({
        "bad name": defineMcpTool({
          description: "Некорректное имя",
          inputSchema: z.object({}),
          execute: () => ({ text: "ok" }),
        }),
      }),
    /Недопустимое имя MCP-инструмента/,
  );

  await host.close();
  assert.throws(
    () =>
      host.expose({
        late: defineMcpTool({
          description: "Поздний инструмент",
          inputSchema: z.object({}),
          execute: () => ({ text: "ok" }),
        }),
      }),
    /уже закрыт/,
  );
  await host.close();
});
