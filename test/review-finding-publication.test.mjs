import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  reviewPullRequestTitle,
} from "../server/change-review-publication.ts";
import {
  assertActiveReviewPullRequest,
  parseFindingCompletionInput,
  publishReviewFindingOutcome,
} from "../server/review-finding-publication.ts";

const workspaceDirectory = process.cwd();
const changeId = "publication-contract";
const parentBranch = `change/${changeId}`;
const branch = `planning/${changeId}`;
const baselineCommit = "a".repeat(40);
const expectedHead = "b".repeat(40);

function pullRequest(overrides = {}) {
  return {
    number: 43,
    url: "https://github.com/example/project/pull/43",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: parentBranch,
    headRefName: branch,
    headRefOid: expectedHead,
    title: reviewPullRequestTitle(changeId),
    body: "Существующее описание review pull request.",
    ...overrides,
  };
}

function publicationRequest(overrides = {}) {
  return {
    workspaceDirectory,
    changeId,
    branch,
    findingId: "F1",
    baselineCommit,
    expectedHead,
    kind: "review",
    outcome: "resolved",
    input: {
      mode: "publish",
      problem: "Контракт не фиксировал обязательный результат.",
      resolution: "Обязательный результат добавлен в проверяемый контракт.",
    },
    ...overrides,
  };
}

function githubFixture(overrides = {}) {
  return {
    pullRequest: pullRequest(),
    remoteHead: expectedHead,
    pullRequests: undefined,
    editError: null,
    editCount: 0,
    bodyFiles: [],
    ...overrides,
  };
}

function createCommand(fixture) {
  return async (executable, arguments_) => {
    if (executable === "git" && arguments_[0] === "remote") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "ls-remote") {
      return {
        stdout: `${fixture.remoteHead}\trefs/heads/${branch}\n`,
        stderr: "",
      };
    }
    if (executable !== "gh") {
      throw new Error(`Неожиданная команда: ${executable} ${arguments_.join(" ")}`);
    }
    if (arguments_[0] === "auth") return { stdout: "", stderr: "" };
    if (arguments_[0] === "repo") {
      return {
        stdout: JSON.stringify({
          nameWithOwner: "example/project",
          url: "https://github.com/example/project",
        }),
        stderr: "",
      };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "list") {
      return {
        stdout: JSON.stringify(fixture.pullRequests ?? [fixture.pullRequest]),
        stderr: "",
      };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "view") {
      return { stdout: JSON.stringify(fixture.pullRequest), stderr: "" };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "edit") {
      fixture.editCount += 1;
      const bodyPath = arguments_[arguments_.indexOf("--body-file") + 1];
      fixture.bodyFiles.push(bodyPath);
      if (fixture.editError) throw fixture.editError;
      fixture.pullRequest.body = await readFile(bodyPath, "utf8");
      return { stdout: fixture.pullRequest.url, stderr: "" };
    }
    throw new Error(`Неожиданный вызов gh: ${arguments_.join(" ")}`);
  };
}

test("completion input сохраняет типизированные режимы и отклоняет небезопасные резюме", () => {
  assert.deepEqual(
    parseFindingCompletionInput({
      mode: "publish",
      problem: "  Проблема описана кратко.  ",
      resolution: "Решение зафиксировано.",
    }),
    {
      mode: "publish",
      problem: "Проблема описана кратко.",
      resolution: "Решение зафиксировано.",
    },
  );
  assert.deepEqual(
    parseFindingCompletionInput({ mode: "acknowledge-existing" }),
    { mode: "acknowledge-existing" },
  );

  const invalidInputs = [
    { mode: "publish", problem: "", resolution: "Решено." },
    { mode: "publish", problem: "Проблема.\nВторая строка.", resolution: "Решено." },
    { mode: "publish", problem: "Проблема.\u202E", resolution: "Решено." },
    { mode: "publish", problem: `П${"р".repeat(500)}`, resolution: "Решено." },
    { mode: "publish", problem: "Only English text", resolution: "Решено." },
    {
      mode: "publish",
      problem: "Проблема <!-- paseo-openspec-orchestrator:finding:review -->",
      resolution: "Решено.",
    },
    { mode: "publish", problem: "Проблема." },
    {
      mode: "acknowledge-existing",
      problem: "Лишнее описание.",
      resolution: "Лишний итог.",
    },
  ];
  for (const input of invalidInputs) {
    assert.throws(() => parseFindingCompletionInput(input));
  }
});

test("публикация сохраняет body, хронологически добавляет разные findings и идемпотентна", async () => {
  const fixture = githubFixture();
  const command = createCommand(fixture);
  const originalBody = fixture.pullRequest.body;

  const first = await publishReviewFindingOutcome(publicationRequest(), command);
  assert.deepEqual(first, {
    number: 43,
    url: "https://github.com/example/project/pull/43",
  });
  assert.ok(fixture.pullRequest.body.startsWith(originalBody));

  await publishReviewFindingOutcome(
    publicationRequest({
      baselineCommit: "c".repeat(40),
      kind: "implementation-review",
      outcome: "accepted-risk",
      input: {
        mode: "publish",
        problem: "Legacy-ветка не имеет автоматического отката.",
        resolution: "Ограниченный риск принят до завершения миграции.",
      },
    }),
    command,
  );
  await publishReviewFindingOutcome(
    publicationRequest({
      findingId: "F2",
      baselineCommit: "d".repeat(40),
      input: {
        mode: "publish",
        problem: "Второй сценарий оставался неоднозначным.",
        resolution: "Для второго сценария добавлено однозначное правило.",
      },
    }),
    command,
  );

  const body = fixture.pullRequest.body;
  const reviewF1 = body.indexOf("OpenSpec review `F1` — исправлено");
  const implementationF1 = body.indexOf(
    "OpenSpec implementation review `F1` — риск принят",
  );
  const reviewF2 = body.indexOf("OpenSpec review `F2` — исправлено");
  assert.ok(reviewF1 > originalBody.length);
  assert.ok(implementationF1 > reviewF1);
  assert.ok(reviewF2 > implementationF1);
  assert.equal(body.match(/paseo-openspec-orchestrator:findings:start/gu)?.length, 1);
  assert.equal(fixture.editCount, 3);

  await publishReviewFindingOutcome(publicationRequest(), command);
  await publishReviewFindingOutcome(
    publicationRequest({ input: { mode: "acknowledge-existing" } }),
    command,
  );
  assert.equal(fixture.editCount, 3);
  for (const bodyPath of fixture.bodyFiles) {
    await assert.rejects(access(bodyPath));
  }
});

test("публикация очищает временный body-файл после ошибки gh", async () => {
  const fixture = githubFixture({ editError: new Error("gh edit failed") });
  await assert.rejects(
    publishReviewFindingOutcome(publicationRequest(), createCommand(fixture)),
    /Не удалось обновить описание review pull request #43/,
  );
  assert.equal(fixture.bodyFiles.length, 1);
  await assert.rejects(access(fixture.bodyFiles[0]));
});

test("проверка review PR отклоняет отсутствие, дубли и неверные metadata", async (t) => {
  const cases = [
    ["отсутствующий PR", (fixture) => { fixture.pullRequests = []; }],
    ["дублированный PR", (fixture) => {
      fixture.pullRequests = [
        fixture.pullRequest,
        pullRequest({
          number: 44,
          url: "https://github.com/example/project/pull/44",
        }),
      ];
    }],
    ["закрытый PR", (fixture) => { fixture.pullRequest.state = "CLOSED"; }],
    ["Draft PR", (fixture) => { fixture.pullRequest.isDraft = true; }],
    ["PR из fork", (fixture) => { fixture.pullRequest.isCrossRepository = true; }],
    ["PR в неверную base-ветку", (fixture) => {
      fixture.pullRequest.baseRefName = "main";
    }],
    ["PR с неверной head-веткой", (fixture) => {
      fixture.pullRequest.headRefName = "feature/other-review";
    }],
    ["PR с неверным title", (fixture) => { fixture.pullRequest.title = "Другой title"; }],
    ["PR другого репозитория", (fixture) => {
      fixture.pullRequest.url = "https://github.com/other/project/pull/43";
    }],
    ["PR с SHA не из origin", (fixture) => {
      fixture.remoteHead = "c".repeat(40);
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = githubFixture();
      mutate(fixture);
      await assert.rejects(
        assertActiveReviewPullRequest(
          workspaceDirectory,
          changeId,
          branch,
          undefined,
          createCommand(fixture),
        ),
      );
    });
  }
});
