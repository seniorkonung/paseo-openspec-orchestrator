import assert from "node:assert/strict";
import test from "node:test";
import {
  reconnectDelayMs,
  selectSnapshotWithoutRegression,
  shouldApplyRpcSnapshot,
  startSynchronizationLoop,
} from "../client/orchestrator-sync.ts";
import {
  currentStateActionLinks,
  currentStateDescription,
  formatChangeLabel,
  formatDuration,
  getTimelineUpdate,
} from "../client/orchestrator-view-model.ts";

function snapshot(revision) {
  return {
    workspaceId: "workspace-1",
    revision,
    change: null,
    lifecycle: { status: "idle", availableCommand: "start" },
    currentAction: null,
    history: [],
    persistence: { status: "ready" },
  };
}

test("поздний RPC-ответ не заменяет более свежую cache revision", () => {
  assert.equal(shouldApplyRpcSnapshot("12", "12"), true);
  assert.equal(shouldApplyRpcSnapshot("13", "12"), false);
  assert.equal(shouldApplyRpcSnapshot(undefined, "12"), false);

  const response = { revision: "12", value: "ответ" };
  const current = { revision: "13", value: "актуальное" };
  assert.equal(selectSnapshotWithoutRegression("11", current, response), current);
  assert.equal(selectSnapshotWithoutRegression("11", undefined, response), response);
  assert.equal(
    selectSnapshotWithoutRegression("11", { revision: "11", value: "старое" }, response),
    response,
  );
});

test("reconnect использует ограниченный экспоненциальный backoff", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(reconnectDelayMs), [500, 1_000, 2_000, 4_000, 8_000, 8_000]);
});

test("лента прокручивается только когда пользователь находится у нижнего края", () => {
  assert.deepEqual(getTimelineUpdate(4, 6, true), { added: 2, shouldScroll: true });
  assert.deepEqual(getTimelineUpdate(4, 6, false), { added: 2, shouldScroll: false });
  assert.deepEqual(getTimelineUpdate(0, 6, true), { added: 6, shouldScroll: false });
});

test("длительность отображается компактно", () => {
  assert.equal(
    formatDuration("2026-09-16T10:00:00.000Z", "2026-09-16T10:00:00.500Z"),
    "< 1 с",
  );
  assert.equal(
    formatDuration("2026-09-16T10:00:00.000Z", "2026-09-16T10:01:05.000Z"),
    "1 мин 5 с",
  );
});

test("view model покрывает пустой change и основные состояния панели", () => {
  assert.equal(formatChangeLabel(undefined), "Загружается…");
  assert.equal(formatChangeLabel(null), "Change не выбран");
  assert.equal(
    formatChangeLabel({ id: "change-a", title: "Изменение A" }),
    "Изменение A · change-a",
  );
  assert.equal(currentStateDescription(undefined), "Ожидаю состояние сервера");
  assert.equal(
    currentStateDescription({
      ...snapshot("2"),
      lifecycle: { status: "paused", availableCommand: "resume" },
    }),
    "Новые действия не начнутся до продолжения",
  );
  assert.equal(
    currentStateDescription({
      ...snapshot("3"),
      lifecycle: {
        status: "failed",
        availableCommand: "retry",
        message: "Проверяемая ошибка",
      },
    }),
    "Проверяемая ошибка",
  );
});

test("панель сохраняет доступ к ссылке PR во время ожидания merge", () => {
  const link = { kind: "external", url: "https://github.com/example/project/pull/51", label: "PR реализации #51" };
  const failed = {
    ...snapshot("4"),
    lifecycle: { status: "failed", availableCommand: "retry", message: "Дождитесь merge" },
    history: [{
      id: "merge", text: "PR ожидает merge", startedAt: "2026-09-23T10:00:00Z",
      finishedAt: "2026-09-23T10:00:01Z", outcome: "failed", links: [link],
    }],
  };
  assert.deepEqual(currentStateActionLinks(failed), [link]);
  assert.deepEqual(currentStateActionLinks({ ...failed, lifecycle: { status: "idle", availableCommand: "start" } }), []);
  assert.deepEqual(currentStateActionLinks({ ...failed, history: [{ ...failed.history[0], outcome: "succeeded" }] }), []);
});

test("long-poll loop выполняет только один wait одновременно", async () => {
  let cached = snapshot("1");
  let active = 0;
  let maximumActive = 0;
  const pending = [];
  const loop = startSynchronizationLoop({
    getCached: () => cached,
    wait: () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve) =>
        pending.push((response) => {
          active -= 1;
          resolve(response);
        }),
      );
    },
    resync: async () => cached,
    apply: (next) => {
      cached = next;
    },
    setStatus: () => undefined,
  });

  assert.equal(pending.length, 1);
  pending.shift()({ status: "unchanged", revision: "1" });
  await Promise.resolve();
  assert.equal(pending.length, 1);
  assert.equal(maximumActive, 1);
  loop.stop();
  pending.shift()({ status: "unchanged", revision: "1" });
  await loop.done;
});

test("cleanup игнорирует поздний long-poll ответ", async () => {
  const cached = snapshot("1");
  const applied = [];
  let finishWait;
  const loop = startSynchronizationLoop({
    getCached: () => cached,
    wait: () => new Promise((resolve) => {
      finishWait = resolve;
    }),
    resync: async () => snapshot("2"),
    apply: (next) => applied.push(next),
    setStatus: () => undefined,
  });

  loop.stop();
  finishWait({ status: "changed", snapshot: snapshot("2") });
  await loop.done;
  assert.equal(applied.length, 0);
});

test("ошибка wait запускает resync и возвращает live-состояние", async () => {
  let cached = snapshot("1");
  const statuses = [];
  const delays = [];
  let loop;
  loop = startSynchronizationLoop({
    getCached: () => cached,
    wait: async () => {
      throw new Error("соединение потеряно");
    },
    resync: async () => snapshot("2"),
    apply: (next) => {
      cached = next;
      loop.stop();
    },
    setStatus: (status) => statuses.push(status),
    sleep: async (durationMs) => {
      delays.push(durationMs);
    },
  });

  await loop.done;
  assert.equal(cached.revision, "2");
  assert.deepEqual(delays, [500]);
  assert.deepEqual(statuses, ["live", "reconnecting", "live"]);
});
