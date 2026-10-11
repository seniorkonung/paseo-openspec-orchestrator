import assert from "node:assert/strict";
import test from "node:test";
import { RootPullRequestError } from "../server/root-pull-request.ts";
import { createAwaitRootMergeStep } from "../server/workflow/steps/await-root-merge.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const changeId = "ci-gate";
const branch = `change/${changeId}`;
const firstHead = "a".repeat(40);
const secondHead = "b".repeat(40);
const identity = {
  number: 41,
  url: "https://github.com/example/project/pull/41",
  repositoryHost: "github.com",
  repositoryNameWithOwner: "example/project",
  repositoryUrl: "https://github.com/example/project",
  changeBranch: branch,
};

/**
 * Корневой PR, проверки которого задаёт `checks(poll, repository)`: номер
 * запроса считается от начала теста, поэтому повторные запуски шага видят
 * продолжение той же последовательности.
 */
function harness({ checks, policy = {} }) {
  const repository = { head: firstHead, ready: false, merged: false };
  const polls = [];
  const pullRequest = () => repository.merged
    ? { kind: "merged", head: repository.head, identity }
    : { kind: "open", isDraft: !repository.ready, head: repository.head, identity };
  const step = createAwaitRootMergeStep({
    workspaceDirectory: "/workspace/project",
    archive: { async verifyArchived() { return repository.head; } },
    rootPullRequest: {
      async synchronize() { return repository.head; },
      async inspect() { return pullRequest(); },
      async makeDraft() { throw new Error("финальный gate не возвращает PR в Draft"); },
      async makeReady(_workspace, inspection) { repository.ready = true; return { ...inspection, isDraft: false }; },
      async inspectChecks(_workspace, requested) {
        assert.deepEqual(requested, identity);
        polls.push(repository.head);
        const progress = checks(polls.length, repository);
        if (progress instanceof Error) throw progress;
        return repository.merged
          ? { kind: "merged", head: repository.head }
          : { kind: "open", isDraft: !repository.ready, head: repository.head, checks: progress };
      },
    },
    checksWait: { pollIntervalMs: 1, settleMs: 0, timeoutMs: 5_000, maxConsecutiveFailures: 3, ...policy },
  });
  return { step, repository, polls };
}

function contextFor({ signal = new AbortController().signal, pauseSignal = new AbortController().signal } = {}) {
  const links = [];
  return {
    links,
    signal,
    pauseSignal,
    state: {
      ...createInitialWorkflowState(),
      change: { id: changeId },
      changeBranch: branch,
      activeBranch: branch,
      rootPullRequest: identity,
      archivedChange: { session: { changeId }, commit: firstHead },
    },
    updateActionLinks(next) { links.splice(0, links.length, ...next); },
    async checkpointState() {},
    async notify() { return true; },
  };
}

test("финальный gate уведомляет о merge только после завершения всех проверок CI, не оценивая их исход", async () => {
  const pending = [2, 1, 0];
  const { step, repository, polls } = harness({ checks: (poll) => ({ total: 3, pending: pending[poll - 1] }) });
  const context = contextFor();

  const result = await step.run(context);

  assert.equal(repository.ready, true);
  assert.equal(polls.length, 3);
  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Проверки CI завершены (3), корневой PR #41 ожидает merge");
  assert.equal(result.message, `Проверьте результаты и выполните merge ${identity.url}, затем нажмите «Повторить»`);
  assert.deepEqual(context.links, [{ kind: "external", url: identity.url, label: "Корневой PR #41" }]);
});

test("проверки, зарегистрированные после перевода в Ready, не пропускаются", async () => {
  // Сначала GitHub не сообщает ни одной проверки: workflow по ready_for_review
  // ещё не создан. Затем проверка появляется и завершается.
  const { step, polls } = harness({
    policy: { pollIntervalMs: 5, settleMs: 60 },
    checks: (poll) => (poll <= 2 ? { total: 0, pending: 0 } : { total: 1, pending: poll <= 5 ? 1 : 0 }),
  });

  const result = await step.run(contextFor());

  assert.ok(polls.length > 5);
  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Проверки CI завершены (1), корневой PR #41 ожидает merge");
});

test("без проверок CI уведомление приходит только после окна ожидания их появления", async () => {
  const { step } = harness({ policy: { pollIntervalMs: 5, settleMs: 40 }, checks: () => ({ total: 0, pending: 0 }) });

  const startedAt = performance.now();
  const result = await step.run(contextFor());

  assert.ok(performance.now() - startedAt >= 40);
  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Проверок CI нет, корневой PR #41 ожидает merge");
});

test("«Повторить» после уведомления снова ждёт завершения проверок текущего HEAD", async () => {
  let pendingPolls = 0;
  const { step, repository, polls } = harness({
    checks: () => {
      if (pendingPolls === 0) return { total: 2, pending: 0 };
      pendingPolls -= 1;
      return { total: 2, pending: 2 };
    },
  });

  assert.equal((await step.run(contextFor())).kind, "halt");
  assert.deepEqual(polls, [firstHead]);

  // Пользователь исправил проблему и опубликовал новый коммит: CI для него
  // ещё идёт, и повторный запуск шага должен его дождаться.
  repository.head = secondHead;
  pendingPolls = 3;
  const retried = await step.run(contextFor());
  assert.equal(retried.kind, "halt");
  assert.match(retried.summary, /^Проверки CI завершены \(2\)/u);
  assert.deepEqual(polls, [firstHead, secondHead, secondHead, secondHead, secondHead]);

  // Повтор без изменений снова проверяет CI и снова отдаёт управление.
  const repeated = await step.run(contextFor());
  assert.equal(repeated.kind, "halt");
  assert.equal(polls.length, 6);
});

test("пауза прерывает ожидание проверок и возвращает шаг к самому себе", async () => {
  const pause = new AbortController();
  const { step, polls } = harness({
    checks: (poll) => {
      if (poll === 2) pause.abort();
      return { total: 1, pending: 1 };
    },
  });

  const result = await step.run(contextFor({ pauseSignal: pause.signal }));

  assert.deepEqual(result, { kind: "continue", next: "await-root-merge", summary: "Ожидание проверок CI прервано паузой" });
  assert.equal(polls.length, 2);
});

test("незавершённые проверки после лимита ожидания отдают управление пользователю", async () => {
  const { step } = harness({ policy: { pollIntervalMs: 5, timeoutMs: 20 }, checks: () => ({ total: 3, pending: 1 }) });

  const result = await step.run(contextFor());

  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Проверки CI корневого PR #41 не завершились за 1 мин");
  assert.match(result.message, /незавершённых: 1\); нажмите «Повторить», чтобы ждать дальше$/u);
});

test("кратковременные ошибки GitHub не прерывают ожидание, а устойчивые останавливают gate", async (context) => {
  const warnings = context.mock.method(console, "warn", () => undefined);
  const unavailable = () => new RootPullRequestError("Не удалось прочитать проверки CI корневого pull request #41");

  const recovering = harness({ checks: (poll) => (poll <= 2 ? unavailable() : { total: 1, pending: 0 }) });
  const recovered = await recovering.step.run(contextFor());
  assert.equal(recovered.kind, "halt");
  assert.match(recovered.summary, /^Проверки CI завершены \(1\)/u);
  assert.equal(warnings.mock.callCount(), 2);

  const failing = harness({ checks: () => unavailable() });
  const failed = await failing.step.run(contextFor());
  assert.equal(failing.polls.length, 3);
  assert.equal(failed.kind, "halt");
  assert.equal(failed.summary, "Не удалось прочитать проверки CI корневого pull request #41");
});

test("merge во время ожидания проверок завершает workflow", async () => {
  const { step } = harness({
    checks: (poll, repository) => {
      if (poll === 2) repository.merged = true;
      return { total: 1, pending: 1 };
    },
  });

  const result = await step.run(contextFor());

  assert.deepEqual(result, { kind: "complete", summary: `Change ${changeId} архивирован, корневой PR слит` });
});

test("новый коммит в корневой ветке во время ожидания останавливает gate для повторной проверки", async () => {
  const { step } = harness({
    checks: (poll, repository) => {
      if (poll === 2) repository.head = secondHead;
      return { total: 1, pending: 1 };
    },
  });

  const result = await step.run(contextFor());

  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "HEAD изменился после Ready");
});

test("отмена workflow прерывает ожидание проверок", async () => {
  const cancel = new AbortController();
  const { step } = harness({
    checks: (poll) => {
      if (poll === 2) cancel.abort();
      return { total: 1, pending: 1 };
    },
  });

  await assert.rejects(step.run(contextFor({ signal: cancel.signal })), { name: "AbortError" });
});
