import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PULL_REQUEST_HEAD_WAIT,
  deliverRootCommit,
  RootBranchDeliveryError,
} from "../server/root-branch-delivery.ts";

const changeId = "one-pr";
const branch = `change/${changeId}`;
const base = "a".repeat(40);
const head = "b".repeat(40);
const other = "c".repeat(40);
const repositoryUrl = "https://github.com/example/project";

function fixture(options = {}) {
  let remote = options.remote ?? base;
  let pushed = false;
  // GitHub применяет push к PR асинхронно: первые чтения PR видят прежний head.
  let staleReads = options.stalePrReads ?? 0;
  const calls = [];
  // Пары «предок потомок», известные тестовой истории Git.
  const ancestry = new Set([`${base} ${head}`, ...(options.ancestry ?? [])]);
  const pr = (headRefOid = remote) => ({
    number: 41,
    url: `${repositoryUrl}/pull/41`,
    state: options.prState ?? "OPEN",
    isDraft: options.isDraft ?? true,
    isCrossRepository: false,
    baseRefName: pushed ? options.afterPushBase ?? "main" : "main",
    headRefName: branch,
    headRefOid,
    mergeCommit: options.prState === "MERGED" ? { oid: head } : null,
    title: "Корневой PR",
    body: "Описание",
  });
  const command = async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(key);
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${options.local ?? head}\n`, stderr: "" };
    if (key === `git ls-remote --heads origin refs/heads/${branch}`) {
      return { stdout: `${remote}\trefs/heads/${branch}\n`, stderr: "" };
    }
    if (key === "git remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }), stderr: "" };
    }
    if (key.startsWith("gh pr list ")) return { stdout: JSON.stringify([pr()]), stderr: "" };
    if (key.startsWith("gh pr view ")) {
      const stale = staleReads > 0;
      if (stale) staleReads -= 1;
      return { stdout: JSON.stringify(pr(stale ? base : remote)), stderr: "" };
    }
    if (key.startsWith("git merge-base --is-ancestor ")) {
      if (ancestry.has(args.slice(2).join(" "))) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("не предок"), { code: 1 });
    }
    if (key === `git push origin HEAD:refs/heads/${branch}`) {
      remote = head;
      pushed = true;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return { command, calls, remote: () => remote };
}

// Виртуальные часы: паузы ожидания head PR проходят мгновенно и записываются.
function virtualHeadWait() {
  let now = 0;
  const sleeps = [];
  const wait = {
    ...DEFAULT_PULL_REQUEST_HEAD_WAIT,
    now: () => now,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { wait, sleeps };
}

function pushes(state) {
  return state.calls.filter((call) => call.startsWith("git push")).length;
}

test("проверенный коммит публикуется только в корневую ветку единственного Draft PR", async () => {
  const state = fixture();
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command);
  assert.equal(state.remote(), head);
  assert.deepEqual(state.calls.filter((call) => call.startsWith("git push")), [
    `git push origin HEAD:refs/heads/${branch}`,
  ]);
  assert.equal(state.calls.some((call) => call.includes("pr create")), false);
});

test("повтор после push подтверждает HEAD без второго push", async () => {
  const state = fixture({ remote: head });
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command);
  assert.equal(state.calls.some((call) => call.startsWith("git push")), false);
});

test("расхождение origin и преждевременный merge останавливают публикацию", async () => {
  for (const options of [{ remote: other }, { prState: "MERGED" }, { isDraft: false }]) {
    const state = fixture(options);
    await assert.rejects(
      deliverRootCommit("/repo", changeId, base, head, undefined, state.command),
      RootBranchDeliveryError,
    );
    assert.equal(state.calls.some((call) => call.startsWith("git push")), false);
  }
});

test("origin на промежуточном коммите допускает fast-forward публикацию", async () => {
  // Пользователь или агент уже опубликовал часть коммитов этапа.
  const state = fixture({ remote: other, ancestry: [`${other} ${head}`] });
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command);
  assert.equal(state.remote(), head);
  assert.equal(state.calls.filter((call) => call.startsWith("git push")).length, 1);
});

test("коммит не от baseline этапа не публикуется", async () => {
  const state = fixture({ remote: other, ancestry: [`${other} ${head}`] });
  await assert.rejects(
    deliverRootCommit("/repo", changeId, "d".repeat(40), head, undefined, state.command),
    /не происходит от сохранённого baseline/u,
  );
  assert.equal(state.calls.some((call) => call.startsWith("git push")), false);
});

test("принятые коммиты публикуются в Ready PR только по явному разрешению", async () => {
  const strict = fixture({ isDraft: false });
  await assert.rejects(
    deliverRootCommit("/repo", changeId, base, head, undefined, strict.command),
    /Draft/u,
  );
  const relaxed = fixture({ isDraft: false });
  await deliverRootCommit(
    "/repo", changeId, base, head, undefined, relaxed.command, undefined, { requireDraft: false },
  );
  assert.equal(relaxed.remote(), head);
});

test("изменение base корневого PR после push останавливает подтверждение", async () => {
  const state = fixture({ afterPushBase: "release", stalePrReads: 1 });
  const { wait, sleeps } = virtualHeadWait();
  await assert.rejects(
    deliverRootCommit("/repo", changeId, base, head, undefined, state.command, undefined, { headWait: wait }),
    /Корневой PR изменился/u,
  );
  assert.equal(state.remote(), head);
  assert.deepEqual(sleeps, [500], "изменение PR останавливает ожидание при первом чтении");
});

test("публикация ждёт, пока GitHub применит push к head корневого PR", async () => {
  // Прежде публикация сразу сверяла head PR и почти всегда падала на первом вызове.
  const state = fixture({ stalePrReads: 3 });
  const { wait, sleeps } = virtualHeadWait();
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command, undefined, { headWait: wait });
  assert.equal(state.remote(), head);
  assert.equal(pushes(state), 1);
  assert.deepEqual(sleeps, [500, 1_000, 2_000]);
});

test("повтор после push ждёт head PR без второго push", async () => {
  const state = fixture({ remote: head, stalePrReads: 2 });
  const { wait, sleeps } = virtualHeadWait();
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command, undefined, { headWait: wait });
  assert.equal(pushes(state), 0);
  assert.deepEqual(sleeps, [500, 1_000]);
});

test("head PR, не обновлённый за срок ожидания, даёт ошибку с причиной и сохраняет push", async (context) => {
  context.mock.method(console, "warn", () => {});
  const state = fixture({ stalePrReads: Number.POSITIVE_INFINITY });
  const { wait, sleeps } = virtualHeadWait();
  await assert.rejects(
    deliverRootCommit("/repo", changeId, base, head, undefined, state.command, undefined, { headWait: wait }),
    (error) => {
      assert.ok(error instanceof RootBranchDeliveryError);
      assert.match(error.message, /GitHub не обновил корневой PR #41 до коммита bbbbbbbbbbbb за 30 с/u);
      assert.match(error.message, /уже опубликован в origin, повторите позже/u);
      return true;
    },
  );
  assert.equal(state.remote(), head);
  assert.equal(pushes(state), 1);
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), DEFAULT_PULL_REQUEST_HEAD_WAIT.timeoutMs);
  assert.ok(sleeps.every((ms) => ms <= DEFAULT_PULL_REQUEST_HEAD_WAIT.maxDelayMs));
  assert.equal(console.warn.mock.callCount(), 1);
});

test("отмена прерывает ожидание head PR", async () => {
  const state = fixture({ stalePrReads: Number.POSITIVE_INFINITY });
  const controller = new AbortController();
  const command = async (executable, args, options) => {
    const result = await state.command(executable, args, options);
    if (executable === "git" && args[0] === "push") controller.abort();
    return result;
  };
  await assert.rejects(
    deliverRootCommit("/repo", changeId, base, head, controller.signal, command),
    { name: "AbortError" },
  );
  assert.equal(pushes(state), 1);
});
