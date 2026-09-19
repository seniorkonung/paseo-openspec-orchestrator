import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PhaseWorkError,
  classifyPhaseWork,
  createPhaseWorkService,
  phaseTaskFingerprint,
  parsePhasedPlan,
} from "../server/phase-work.ts";

const changeId = "phase-change";
const fingerprint = (character) => character.repeat(64);

function plan(...numbers) {
  return [
    "# Phased Plan",
    "",
    "## Direction",
    "Последовательно доставить результат.",
    "",
    ...numbers.flatMap((number) => [
      `## Phase ${number}: Результат ${number}`,
      "",
      `**Objective:** Переход ${number}`,
      "",
      `**Outcome:** Состояние ${number}`,
      "",
      `**Boundaries:** Граница ${number}`,
      "",
      `**Ready to advance:** Проверка ${number}`,
      "",
    ]),
  ].join("\n");
}

function snapshot(phases, tasks) {
  return {
    phases,
    tasks,
    schemaName: "spec-driven",
    planPath: "/repo/openspec/changes/phase-change/plan.md",
    taskArtifactPaths: ["/repo/openspec/changes/phase-change/tasks.md"],
  };
}

function task(number, done = false, id = `task-${number}`) {
  return {
    id,
    number,
    description: `${number} Задача ${number}`,
    done,
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, `${number} Задача ${number}`),
  };
}

test("parser принимает последовательные фазы и игнорирует заголовки внутри code fence", () => {
  const markdown = `${plan(1, 2)}\n\n\`\`\`markdown\n## Phase 99: Не фаза\n\`\`\``;
  assert.deepEqual(parsePhasedPlan(markdown).map(({ number, title }) => ({ number, title })), [
    { number: 1, title: "Результат 1" },
    { number: 2, title: "Результат 2" },
  ]);
});

test("parser fail-closed отклоняет пропуски, дубли, неверные поля и незакрытый fence", () => {
  assert.throws(() => parsePhasedPlan(plan(1, 3)), PhaseWorkError);
  assert.throws(() => parsePhasedPlan(plan(1, 1)), PhaseWorkError);
  assert.throws(
    () => parsePhasedPlan(plan(1).replace("**Outcome:** Состояние 1", "**Outcome:**")),
    PhaseWorkError,
  );
  assert.throws(() => parsePhasedPlan(`${plan(1)}\n\`\`\``), PhaseWorkError);
  assert.throws(
    () => parsePhasedPlan([
      "## Phase 1: Результат",
      "```markdown",
      "**Objective:** Только пример",
      "**Outcome:** Только пример",
      "**Boundaries:** Только пример",
      "**Ready to advance:** Только пример",
      "```",
    ].join("\n")),
    /Objective/u,
  );
});

test("классификатор выбирает planning, минимальную implementation-фазу и complete", () => {
  const phases = parsePhasedPlan(plan(1, 2));
  assert.deepEqual(
    classifyPhaseWork(snapshot(phases, []), null).kind,
    "planning-required",
  );
  const preplanned = classifyPhaseWork(
    snapshot(phases, [task("1.1"), task("2.1")]),
    null,
  );
  assert.equal(preplanned.kind, "implementation-required");
  assert.equal(preplanned.phaseNumber, 1);
  const second = classifyPhaseWork(
    snapshot(phases, [task("1.1", true), task("2.1")]),
    null,
  );
  assert.equal(second.kind, "implementation-required");
  assert.equal(second.phaseNumber, 2);
  assert.equal(
    classifyPhaseWork(snapshot(phases, [task("1.1", true), task("2.1", true)]), null).kind,
    "change-complete",
  );
});

test("классификатор сохраняет fingerprints и запрещает gaps, rewrite и reopen", () => {
  const phases = parsePhasedPlan(plan(1, 2));
  assert.throws(
    () => classifyPhaseWork(snapshot(phases, [task("2.1")]), null),
    /после нераспланированной Phase 1/u,
  );
  const complete = classifyPhaseWork(snapshot(phases, [task("1.1", true), task("2.1", true)]), null);
  assert.equal(complete.kind, "change-complete");
  assert.throws(
    () => classifyPhaseWork(snapshot(phases, [task("1.1"), task("2.1", true)]), complete.progress),
    /снова открыта/u,
  );
  assert.throws(
    () => classifyPhaseWork(
      snapshot(phases, [
        { ...task("1.1", true), description: "1.1 Переписано", fingerprint: fingerprint("c") },
        task("2.1", true),
      ]),
      complete.progress,
    ),
    /точный префикс/u,
  );
  assert.throws(
    () => classifyPhaseWork(
      snapshot(phases, [task("1.1", true), task("2.1", true), task("2.2", true)]),
      complete.progress,
    ),
    /уже отмечена завершённой/u,
  );
  const reopenedPhase = classifyPhaseWork(
    snapshot(phases, [task("1.1", true), task("2.1", true), task("2.2")]),
    complete.progress,
  );
  assert.equal(reopenedPhase.kind, "implementation-required");
  assert.equal(reopenedPhase.phaseNumber, 2);
  assert.throws(
    () => classifyPhaseWork(
      snapshot(phases, [task("1.1"), task("1.2", false, "task-1.1")]),
      null,
    ),
    /Повторяется ID/u,
  );
  assert.throws(
    () => classifyPhaseWork(
      snapshot(phases, [task("1.1"), task("1.1", false, "other-id")]),
      null,
    ),
    /Повторяется ID или номер/u,
  );
  assert.throws(
    () => classifyPhaseWork(
      snapshot(phases, [task("3.1")]),
      null,
    ),
    /неизвестную Phase 3/u,
  );
});

test("service безопасно читает plan.md и отклоняет symlink, oversized и выход из Git root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "phase-work-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const gitRoot = join(root, "repo");
  const changeRoot = join(gitRoot, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  const planPath = join(changeRoot, "plan.md");
  const tasksPath = join(changeRoot, "tasks.md");
  await writeFile(planPath, plan(1));
  await writeFile(tasksPath, "- [ ] 1.1 Задача\n");
  const statusGateway = {
    async read() {
      return {
        changeName: changeId,
        schemaName: "spec-driven",
        gitRoot,
        changeRoot,
        isPlanningComplete: true,
        applyRequires: ["tasks"],
        artifacts: new Map(),
        artifactOrder: [],
        artifactPaths: new Map([["tasks", { existingOutputPaths: [tasksPath] }]]),
      };
    },
  };
  const command = async () => ({
    stdout: JSON.stringify({
      changeName: changeId,
      schemaName: "spec-driven",
      progress: { total: 1, complete: 0, remaining: 1 },
      tasks: [{ id: "task-a", description: "1.1 Задача", done: false }],
      state: "ready",
      instruction: "Выполнить",
    }),
    stderr: "",
  });
  const service = createPhaseWorkService({ command, statusGateway });
  assert.equal((await service.inspect(gitRoot, changeId, null)).kind, "implementation-required");

  await rm(planPath);
  await symlink(tasksPath, planPath);
  await assert.rejects(service.inspect(gitRoot, changeId, null), /обычным файлом/u);

  await rm(planPath);
  await writeFile(planPath, "x".repeat(256 * 1024 + 1));
  await assert.rejects(service.inspect(gitRoot, changeId, null), /не больше|слишком велик/u);

  await writeFile(planPath, Buffer.from([0xff]));
  await assert.rejects(service.inspect(gitRoot, changeId, null), /UTF-8/u);

  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "plan.md"), plan(1));
  const escapingService = createPhaseWorkService({
    command,
    statusGateway: {
      async read() { return { ...(await statusGateway.read()), changeRoot: outside }; },
    },
  });
  await assert.rejects(escapingService.inspect(gitRoot, changeId, null), /за пределами/u);
});
