import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
  orchestratorNotificationSettingsValuesSchema,
  type OrchestratorNotificationSettingsValues,
} from "../shared/orchestrator-notifications.ts";
import { resolvePaseoHome } from "./orchestrator-ledger.ts";

const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

const settingsDocumentSchema = z
  .object({
    version: z.literal(SETTINGS_VERSION),
    revision: z.number().int().nonnegative(),
    values: orchestratorNotificationSettingsValuesSchema,
  })
  .strict();

export interface StoredOrchestratorNotificationSettings {
  revision: number;
  values: OrchestratorNotificationSettingsValues;
}

export type SaveOrchestratorNotificationSettingsResult =
  | { status: "saved"; settings: StoredOrchestratorNotificationSettings }
  | { status: "conflict"; settings: StoredOrchestratorNotificationSettings };

export function defaultOrchestratorNotificationSettingsPath(): string {
  return join(
    resolvePaseoHome(),
    "plugin-settings",
    "paseo-openspec-orchestrator",
    "notifications.json",
  );
}

export function normalizeOrchestratorNotificationSettings(
  values: OrchestratorNotificationSettingsValues,
): OrchestratorNotificationSettingsValues {
  const rawServerUrl = values.serverUrl.trim();
  let url: URL;
  try {
    url = new URL(rawServerUrl);
  } catch {
    throw new Error("Адрес ntfy должен быть корректным URL с http:// или https://.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Адрес ntfy должен использовать http:// или https://.");
  }
  if (url.username || url.password) {
    throw new Error("Логин и пароль нельзя указывать в URL; используйте токен.");
  }
  if (url.search || url.hash) {
    throw new Error("Адрес ntfy не должен содержать query string или fragment.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const serverUrl = url.toString().replace(/\/$/, "");
  const topic = values.topic.trim();
  if (topic && !TOPIC_PATTERN.test(topic)) {
    throw new Error("Тема ntfy должна содержать 1–64 латинских букв, цифр, дефисов или подчёркиваний.");
  }

  return {
    enabled: values.enabled,
    serverUrl,
    topic,
    accessToken: values.accessToken.trim(),
    priority: values.priority,
  };
}

function emptySettings(): StoredOrchestratorNotificationSettings {
  return {
    revision: 0,
    values: { ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS },
  };
}

export class OrchestratorNotificationSettingsStore {
  #saveQueue: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(path = defaultOrchestratorNotificationSettingsPath()) {
    this.path = path;
  }

  async read(): Promise<StoredOrchestratorNotificationSettings> {
    let serialized: string;
    try {
      serialized = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySettings();
      throw error;
    }

    if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
      throw new Error("Файл настроек уведомлений слишком большой.");
    }

    let json: unknown;
    try {
      json = JSON.parse(serialized);
    } catch {
      throw new Error("Файл настроек уведомлений содержит некорректный JSON.");
    }
    const parsed = settingsDocumentSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Файл настроек уведомлений имеет неподдерживаемый формат.");
    }
    return {
      revision: parsed.data.revision,
      values: normalizeOrchestratorNotificationSettings(parsed.data.values),
    };
  }

  async save(
    expectedRevision: number,
    values: OrchestratorNotificationSettingsValues,
  ): Promise<SaveOrchestratorNotificationSettingsResult> {
    const normalized = normalizeOrchestratorNotificationSettings(values);
    let result: SaveOrchestratorNotificationSettingsResult | undefined;
    const operation = this.#saveQueue.then(async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        result = { status: "conflict", settings: current };
        return;
      }

      const settings: StoredOrchestratorNotificationSettings = {
        revision: current.revision + 1,
        values: normalized,
      };
      await this.#writeAtomic(settings);
      result = { status: "saved", settings };
    });
    this.#saveQueue = operation.catch(() => undefined);
    await operation;
    return result!;
  }

  async #writeAtomic(settings: StoredOrchestratorNotificationSettings): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.notifications-${process.pid}-${randomUUID()}.tmp`,
    );
    const document = JSON.stringify(
      {
        version: SETTINGS_VERSION,
        revision: settings.revision,
        values: settings.values,
      },
      null,
      2,
    );
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${document}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
