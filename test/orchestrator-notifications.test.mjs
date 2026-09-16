import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
  formatOrchestratorNotificationTitle,
  normalizeOrchestratorWorkspaceDisplay,
} from "../shared/orchestrator-notifications.ts";
import {
  normalizeOrchestratorNotificationSettings,
  OrchestratorNotificationSettingsStore,
} from "../server/orchestrator-notification-settings.ts";
import { publishOrchestratorNotification } from "../server/orchestrator-notification-publisher.ts";
import { OrchestratorNotificationService } from "../server/orchestrator-notifications.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";

async function temporaryDirectory(context, prefix = "openspec-notifications-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function engineContext(workspaceDirectory = "/workspace/project") {
  const workspaceDisplay = { projectName: null, workspaceName: null };
  return {
    workspaceDirectory,
    workspaceDisplay,
    refreshWorkspaceDisplay: async () => workspaceDisplay,
  };
}

test("настройки уведомлений нормализуют URL и отклоняют небезопасные значения", () => {
  const values = normalizeOrchestratorNotificationSettings({
    ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
    serverUrl: "https://ntfy.example/notifications///",
    topic: "openspec-workflow",
    accessToken: "  token  ",
  });
  assert.equal(values.serverUrl, "https://ntfy.example/notifications");
  assert.equal(values.accessToken, "token");

  assert.throws(
    () =>
      normalizeOrchestratorNotificationSettings({
        ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
        serverUrl: "file:///tmp/ntfy",
      }),
    /http:\/\/ или https:\/\//,
  );
  assert.throws(
    () =>
      normalizeOrchestratorNotificationSettings({
        ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
        topic: "topic/with/slash",
      }),
    /Тема ntfy/,
  );
});

test("хранилище уведомлений сохраняет настройки атомарно и защищает revision", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "notifications.json");
  const store = new OrchestratorNotificationSettingsStore(path);

  const initial = await store.read();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.values, DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS);

  const saved = await store.save(0, {
    ...initial.values,
    enabled: false,
    topic: "openspec",
  });
  assert.equal(saved.status, "saved");
  assert.equal(saved.settings.revision, 1);

  const conflict = await store.save(0, initial.values);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.settings.revision, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /"enabled": false/);
});

test("publisher отправляет минимальное типизированное уведомление и не отправляет отключённое", async () => {
  const requests = [];
  const fetchStub = async (input, init) => {
    requests.push({ input, init });
    return { ok: true, status: 200 };
  };
  await publishOrchestratorNotification(
    {
      ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
      topic: "openspec",
      accessToken: "secret-token",
    },
    { kind: "retry", message: "Переключите ветку и нажмите «Повторить»" },
    { fetch: fetchStub },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "https://ntfy.sh");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    topic: "openspec",
    title: "Требуется повтор",
    message: "Переключите ветку и нажмите «Повторить»",
    priority: 3,
  });

  await publishOrchestratorNotification(
    { ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS, enabled: false, topic: "openspec" },
    { kind: "manual", message: "Не должно уйти" },
    { fetch: fetchStub },
  );
  assert.equal(requests.length, 1);
});

test("publisher ставит проект и workspace в начало заголовка без идентификатора", async () => {
  const requests = [];
  await publishOrchestratorNotification(
    {
      ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
      topic: "openspec",
    },
    { kind: "retry", message: "Нужен retry" },
    {
      fetch: async (input, init) => {
        requests.push({ input, init });
        return { ok: true, status: 200 };
      },
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Проверка авторизации",
      },
    },
  );

  assert.deepEqual(JSON.parse(requests[0].init.body), {
    topic: "openspec",
    title: "Платёжный сервис / Проверка авторизации — Требуется повтор",
    message: "Нужен retry",
    priority: 3,
  });
  assert.equal(requests[0].init.body.includes("workspace-42"), false);
});

test("display-контекст нормализует управляющие символы и длинные названия", () => {
  const display = normalizeOrchestratorWorkspaceDisplay({
    projectName: "  Проект\nвторой  ",
    workspaceName: `${"w".repeat(300)}\tокно`,
  });

  assert.equal(display.projectName, "Проект второй");
  assert.equal(display.workspaceName.length, 256);
  assert.equal(
    formatOrchestratorNotificationTitle("completed", display),
    `Проект второй / ${"w".repeat(256)} — Workflow завершён`,
  );
});

test("service передаёт display-контекст и безопасно отключается без темы", async (context) => {
  const directory = await temporaryDirectory(context, "openspec-notification-service-");
  const settings = new OrchestratorNotificationSettingsStore(join(directory, "settings.json"));
  await settings.save(0, {
    ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
    topic: "openspec",
  });
  const published = [];
  const service = new OrchestratorNotificationService({
    settings,
    publish: async (values, notification, options) => {
      published.push({ values, notification, options });
    },
  });

  assert.equal(
    await service.notify(
      "workspace-42",
      { kind: "manual", message: "Готово" },
      { projectName: "Платёжный сервис", workspaceName: "Проверка авторизации" },
    ),
    true,
  );
  assert.equal(published[0].notification.message, "Готово");
  assert.deepEqual(published[0].options.workspace, {
    projectName: "Платёжный сервис",
    workspaceName: "Проверка авторизации",
  });

  await settings.save(1, {
    ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
    enabled: false,
    topic: "openspec",
  });
  assert.equal(
    await service.notify("workspace-42", { kind: "progress", message: "Не отправлять" }),
    false,
  );
  assert.equal(published.length, 1);
});

test("engine уведомляет о retry, прогрессе шага и завершении", async (context) => {
  const directory = await temporaryDirectory(context);
  const ledger = new OrchestratorLedger({ paseoHome: directory });
  await ledger.open("workspace-notifications");
  const events = [];
  const notifications = {
    async notify(workspaceId, notification, workspace) {
      events.push({ workspaceId, ...notification, workspace });
      return true;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    notifications,
    steps: [
      {
        id: "announce",
        label: "Объявляю прогресс",
        async run({ services }) {
          await services.notify({ kind: "progress", message: "Шаг выполняется" });
          return { kind: "continue", next: "finish" };
        },
      },
      {
        id: "finish",
        label: "Завершаю workflow",
        async run() {
          return { kind: "complete" };
        },
      },
    ],
  });
  engine.initialize("workspace-notifications", {
    workspaceDirectory: "/workspace/project",
    workspaceDisplay: {
      projectName: "Платёжный сервис",
      workspaceName: "Проверка авторизации",
    },
    refreshWorkspaceDisplay: async () => ({
      projectName: "Платёжный сервис",
      workspaceName: "Проверка авторизации",
    }),
  });
  engine.command("workspace-notifications", "start");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(events, [
    {
      workspaceId: "workspace-notifications",
      kind: "progress",
      message: "Шаг выполняется",
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Проверка авторизации",
      },
    },
    {
      workspaceId: "workspace-notifications",
      kind: "completed",
      message: "Все действия текущего запуска завершены",
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Проверка авторизации",
      },
    },
  ]);

  engine.dispose();
  await ledger.close();
});

test("engine обновляет имя workspace перед уведомлением и сохраняет последнее при ошибке", async (context) => {
  const warn = context.mock.method(console, "warn", () => undefined);
  const directory = await temporaryDirectory(context);
  const ledger = new OrchestratorLedger({ paseoHome: directory });
  await ledger.open("workspace-renamed-notifications");
  const events = [];
  let workspaceName = "Автоматическое название";
  let refreshFails = false;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    notifications: {
      async notify(_workspaceId, notification, workspace) {
        events.push({ ...notification, workspace });
        return true;
      },
    },
    steps: [
      {
        id: "announce-before-and-after-rename",
        label: "Проверяю обновление названия",
        async run({ services }) {
          await services.notify({ kind: "progress", message: "До переименования" });
          workspaceName = "Проверка авторизации";
          await services.notify({ kind: "progress", message: "После переименования" });
          refreshFails = true;
          return { kind: "complete" };
        },
      },
    ],
  });
  engine.initialize("workspace-renamed-notifications", {
    workspaceDirectory: "/workspace/project",
    workspaceDisplay: {
      projectName: "Платёжный сервис",
      workspaceName,
    },
    refreshWorkspaceDisplay: async () => {
      if (refreshFails) throw new Error("Paseo временно недоступен");
      return {
        projectName: "Платёжный сервис",
        workspaceName,
      };
    },
  });
  engine.command("workspace-renamed-notifications", "start");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(events, [
    {
      kind: "progress",
      message: "До переименования",
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Автоматическое название",
      },
    },
    {
      kind: "progress",
      message: "После переименования",
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Проверка авторизации",
      },
    },
    {
      kind: "completed",
      message: "Все действия текущего запуска завершены",
      workspace: {
        projectName: "Платёжный сервис",
        workspaceName: "Проверка авторизации",
      },
    },
  ]);
  assert.equal(warn.mock.callCount(), 1);

  engine.dispose();
  await ledger.close();
});

test("engine уведомляет о необходимости retry при halt", async (context) => {
  const directory = await temporaryDirectory(context);
  const ledger = new OrchestratorLedger({ paseoHome: directory });
  await ledger.open("workspace-retry-notification");
  const events = [];
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    notifications: {
      async notify(workspaceId, notification) {
        events.push({ workspaceId, ...notification });
        return true;
      },
    },
    steps: [
      {
        id: "blocked",
        label: "Ожидаю исправления",
        async run() {
          return {
            kind: "halt",
            summary: "Нужна ветка",
            message: "Переключите ветку и нажмите «Повторить»",
          };
        },
      },
    ],
  });
  engine.initialize("workspace-retry-notification", engineContext());
  engine.command("workspace-retry-notification", "start");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(events, [
    {
      workspaceId: "workspace-retry-notification",
      kind: "retry",
      message: "Переключите ветку и нажмите «Повторить»",
    },
  ]);
  engine.dispose();
  await ledger.close();
});
