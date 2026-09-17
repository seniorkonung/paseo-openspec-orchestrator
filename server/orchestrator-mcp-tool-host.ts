import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { z } from "zod";

type PaseoApi = PluginHandlerContext["paseo"];
type AgentCreateOptions = Parameters<PaseoApi["agents"]["create"]>[0];
export type OrchestratorAgentConfig = AgentCreateOptions["config"];

type MaybePromise<T> = T | Promise<T>;
type ToolName = string;

export interface McpToolExecutionContext {
  readonly signal: AbortSignal;
}

export interface McpTextToolResult {
  readonly text: string;
}

export interface McpStructuredToolResult<Output> extends McpTextToolResult {
  readonly data: Output;
}

export interface TextMcpToolDefinition<InputSchema extends z.ZodType> {
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: never;
  execute(
    input: z.output<InputSchema>,
    context: McpToolExecutionContext,
  ): MaybePromise<McpTextToolResult>;
}

export interface StructuredMcpToolDefinition<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodObject,
> {
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  execute(
    input: z.output<InputSchema>,
    context: McpToolExecutionContext,
  ): MaybePromise<McpStructuredToolResult<z.input<OutputSchema>>>;
}

export class McpToolError extends Error {
  constructor(message: string) {
    if (message.trim().length === 0) {
      throw new TypeError("Сообщение ошибки MCP-инструмента не может быть пустым");
    }
    super(message);
    this.name = "McpToolError";
  }
}

const registerTool = Symbol("registerTool");

interface ToolRegistrationContext {
  readonly reportUnexpectedError: (error: unknown) => void;
}

export interface DefinedMcpTool {
  readonly description: string;
  readonly [registerTool]: (
    server: McpServer,
    name: ToolName,
    context: ToolRegistrationContext,
  ) => void;
}

export function defineMcpTool<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodObject = z.ZodObject,
>(
  definition:
    | TextMcpToolDefinition<InputSchema>
    | StructuredMcpToolDefinition<InputSchema, OutputSchema>,
): DefinedMcpTool {
  const description = definition.description.trim();
  if (description.length === 0) {
    throw new TypeError("Описание MCP-инструмента не может быть пустым");
  }

  if (definition.outputSchema === undefined) {
    const { execute, inputSchema } = definition;
    return Object.freeze({
      description,
      [registerTool](
        server: McpServer,
        name: ToolName,
        context: ToolRegistrationContext,
      ) {
        const runtimeInputSchema: z.ZodType = inputSchema;
        const callback: ToolCallback<z.ZodType> = async (input, serverContext) => {
          try {
            const result = await execute(input as z.output<InputSchema>, {
              signal: serverContext.mcpReq.signal,
            });
            assertTextResult(result);
            return { content: [{ type: "text", text: result.text }] };
          } catch (error) {
            return toolErrorResult(error, context);
          }
        };
        server.registerTool(
          name,
          { description, inputSchema: runtimeInputSchema },
          callback,
        );
      },
    });
  }

  const { execute, inputSchema, outputSchema } = definition;
  return Object.freeze({
    description,
    [registerTool](
      server: McpServer,
      name: ToolName,
      context: ToolRegistrationContext,
    ) {
      const runtimeInputSchema: z.ZodType = inputSchema;
      const runtimeOutputSchema: z.ZodObject = outputSchema;
      const callback: ToolCallback<z.ZodType> = async (input, serverContext) => {
        try {
          const result = await execute(input as z.output<InputSchema>, {
            signal: serverContext.mcpReq.signal,
          });
          assertTextResult(result);
          if (!("data" in result)) {
            throw new TypeError("MCP-инструмент не вернул структурированные данные");
          }
          const data = await outputSchema.parseAsync(result.data);
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: data,
          };
        } catch (error) {
          return toolErrorResult(error, context);
        }
      };
      server.registerTool(
        name,
        {
          description,
          inputSchema: runtimeInputSchema,
          outputSchema: runtimeOutputSchema,
        },
        callback,
      );
    },
  });
}

export interface OrchestratorMcpToolHostOptions {
  readonly logger?: Pick<Console, "error">;
}

export interface OrchestratorMcpToolScope {
  readonly url: string;
  readonly serverName: string;
  readonly toolNames: readonly string[];
  configureAgent(config: OrchestratorAgentConfig): OrchestratorAgentConfig;
  close(): Promise<void>;
}

interface ScopeRuntime {
  readonly serve: (request: IncomingMessage, response: ServerResponse) => void;
  readonly close: () => Promise<void>;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const LOOPBACK_HOST = "127.0.0.1";

export class OrchestratorMcpToolHost {
  readonly port: number;
  readonly #server: Server;
  readonly #scopes: Map<string, ScopeRuntime>;
  readonly #logger: Pick<Console, "error">;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  private constructor(
    server: Server,
    scopes: Map<string, ScopeRuntime>,
    port: number,
    logger: Pick<Console, "error">,
  ) {
    this.#server = server;
    this.#scopes = scopes;
    this.port = port;
    this.#logger = logger;
  }

  static async listen(
    options: OrchestratorMcpToolHostOptions = {},
  ): Promise<OrchestratorMcpToolHost> {
    const scopes = new Map<string, ScopeRuntime>();
    const logger = options.logger ?? console;

    // Эти проверки рекомендованы для localhost-серверов самим MCP SDK.
    // Источник: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html#validate-host-and-origin-in-front-of-it
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = createServer((request, response) => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }

      const pathname = requestPathname(request);
      if (pathname === null) {
        respond(response, 400, "Некорректный URL запроса");
        return;
      }

      const scope = scopes.get(pathname);
      if (!scope) {
        respond(response, 404, "MCP scope не найден");
        return;
      }

      scope.serve(request, response);
    });

    await listenOnFreePort(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      await closeHttpServer(server);
      throw new Error("Не удалось определить порт MCP-хоста");
    }

    return new OrchestratorMcpToolHost(server, scopes, address.port, logger);
  }

  expose<const Tools extends Readonly<Record<string, DefinedMcpTool>>>(
    tools: Tools,
  ): OrchestratorMcpToolScope {
    this.#assertOpen();
    const entries = Object.entries(tools);
    if (entries.length === 0) {
      throw new TypeError("MCP scope должен содержать хотя бы один инструмент");
    }
    for (const [name] of entries) {
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new TypeError(`Недопустимое имя MCP-инструмента: ${JSON.stringify(name)}`);
      }
    }

    const scopeId = randomUUID();
    const pathname = `/mcp/${scopeId}`;
    const serverName = `openspec-orchestrator-${scopeId}`;
    const url = `http://${LOOPBACK_HOST}:${this.port}${pathname}`;
    const toolNames = Object.freeze(entries.map(([name]) => name));
    const inFlight = new Set<ServerResponse>();

    const reportUnexpectedError = (toolName: string | null, error: unknown) => {
      try {
        this.#logger.error("[OpenSpec] Непредвиденная ошибка локального MCP-хоста", {
          scopeId,
          toolName,
          error,
        });
      } catch {
        // Ошибка пользовательского logger не должна менять результат MCP-вызова.
      }
    };

    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: serverName, version: "1.0.0" });
        for (const [name, tool] of entries) {
          tool[registerTool](server, name, {
            reportUnexpectedError: (error) => reportUnexpectedError(name, error),
          });
        }
        return server;
      },
      { onerror: (error) => reportUnexpectedError(null, error) },
    );
    const nodeHandler = toNodeHandler(handler, {
      onerror: (error) => reportUnexpectedError(null, error),
    });

    let closed = false;
    let closePromise: Promise<void> | null = null;
    const runtime: ScopeRuntime = {
      serve(request, response) {
        if (closed) {
          respond(response, 404, "MCP scope закрыт");
          return;
        }

        inFlight.add(response);
        response.once("close", () => inFlight.delete(response));
        void nodeHandler(request, response).catch((error: unknown) => {
          reportUnexpectedError(null, error);
          if (!response.headersSent) {
            respond(response, 500, "Внутренняя ошибка MCP-хоста");
          } else if (!response.destroyed) {
            response.destroy();
          }
        });
      },
      close: async () => {
        if (closePromise) return closePromise;
        closed = true;
        this.#scopes.delete(pathname);
        closePromise = (async () => {
          const handlerClose = handler.close();
          for (const response of inFlight) {
            response.destroy();
          }
          await handlerClose;
        })();
        return closePromise;
      },
    };

    this.#scopes.set(pathname, runtime);

    return Object.freeze({
      url,
      serverName,
      toolNames,
      configureAgent: (config: OrchestratorAgentConfig) => {
        if (closed || this.#closed) {
          throw new Error("Нельзя настроить агента с закрытым MCP scope");
        }
        return configureAgent(config, serverName, toolNames, url);
      },
      close: runtime.close,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const scopeResults = await Promise.allSettled(
        [...this.#scopes.values()].map((scope) => scope.close()),
      );
      await closeHttpServer(this.#server);
      const failures = scopeResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Не удалось закрыть все MCP scope");
      }
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("MCP-хост уже закрыт");
    }
  }
}

function configureAgent(
  config: OrchestratorAgentConfig,
  serverName: string,
  toolNames: readonly string[],
  url: string,
): OrchestratorAgentConfig {
  if (config.mcpServers?.[serverName]) {
    throw new Error(`Конфигурация агента уже содержит MCP-сервер ${serverName}`);
  }

  const preapproved = [...(config.toolPolicy?.preapproved ?? [])];
  const existing = new Set(
    preapproved.map((entry) => `${entry.kind}\u0000${entry.server}\u0000${entry.tool}`),
  );
  for (const tool of toolNames) {
    const key = `mcp\u0000${serverName}\u0000${tool}`;
    if (existing.has(key)) continue;
    preapproved.push({ kind: "mcp", server: serverName, tool });
    existing.add(key);
  }

  return {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      [serverName]: { type: "http", url },
    },
    toolPolicy: { preapproved },
  };
}

function assertTextResult(result: McpTextToolResult): void {
  if (typeof result !== "object" || result === null || typeof result.text !== "string") {
    throw new TypeError("MCP-инструмент вернул некорректный текстовый результат");
  }
}

function toolErrorResult(
  error: unknown,
  context: ToolRegistrationContext,
): CallToolResult {
  if (error instanceof McpToolError) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
    };
  }

  context.reportUnexpectedError(error);
  return {
    content: [{ type: "text", text: "Инструмент завершился с внутренней ошибкой" }],
    isError: true,
  };
}

function requestPathname(request: IncomingMessage): string | null {
  if (!request.url) return null;
  try {
    return new URL(request.url, `http://${LOOPBACK_HOST}`).pathname;
  } catch {
    return null;
  }
}

function respond(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: message }));
}

function listenOnFreePort(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0 });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
