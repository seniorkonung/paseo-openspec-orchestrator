import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PhaseWorkError,
  assertPhaseTaskScope,
  classifyPhaseWork,
  createPhaseWorkService,
  createTaskScopeCheck,
  inspectWithinTaskScope,
  phaseProgressSchema,
  phaseTaskFingerprint,
  parsePhasedPlan,
  plannedPhaseNumbers,
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

test("parser извлекает только уникальные номера фаз и игнорирует code fence", () => {
  const markdown = `${plan(1, 2)}\n\n\`\`\`markdown\n## Phase 99: Не фаза\n\`\`\``;
  assert.deepEqual(parsePhasedPlan(markdown), [{ number: 1 }, { number: 2 }]);
});

test("парсер распознаёт русские и английские заголовки, кроме примеров в блоках кода", () => {
  const markdown = [
    "## Фаза 1: Первый результат",
    "## Phase 2: Второй результат",
    "## ФАЗА 3: Третий результат",
    "## Phase 1: Повтор первой фазы",
    "```markdown",
    "## Фаза 99: Пример",
    "```",
    "~~~markdown",
    "## Phase 98: Пример",
    "~~~",
  ].join("\n");

  assert.deepEqual(parsePhasedPlan(markdown), [
    { number: 1 },
    { number: 2 },
    { number: 3 },
  ]);
});

test("parser молча пропускает произвольную структуру и не проверяет содержимое фаз", () => {
  assert.deepEqual(parsePhasedPlan([
    "произвольный текст до заголовков",
    "## Phase 3",
    "секция без Objective и остальных полей",
    "## Phase 1: Заголовок",
    "## Phase 3: Повтор",
    "## Phase без номера",
    "```markdown",
    "## Phase 99: Пример",
  ].join("\n")), [{ number: 3 }, { number: 1 }]);
  assert.deepEqual(parsePhasedPlan("совсем не структурированный документ"), []);
});

test("progress принимает старые phase fingerprints, но больше их не сохраняет", () => {
  const progress = phaseProgressSchema.parse({
    phases: [{ number: 1, fingerprint: fingerprint("a") }],
    tasks: [],
    nextImplementationRun: 1,
  });

  assert.deepEqual(progress.phases, [{ number: 1 }]);
});

test("классификатор выбирает planning, первую implementation-фазу и complete", () => {
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

  const headingOrder = parsePhasedPlan(plan(3, 1));
  const firstByHeading = classifyPhaseWork(
    snapshot(headingOrder, [task("3.1"), task("1.1")]),
    null,
  );
  assert.equal(firstByHeading.kind, "implementation-required");
  assert.equal(firstByHeading.phaseNumber, 3);
});

test("классификатор сохраняет task fingerprints и запрещает gaps, rewrite и reopen", () => {
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

test("сервис читает русский plan.md и отклоняет символьную ссылку, большой файл и выход из Git-репозитория", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "phase-work-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const gitRoot = join(root, "repo");
  const changeRoot = join(gitRoot, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  const planPath = join(changeRoot, "plan.md");
  const tasksPath = join(changeRoot, "tasks.md");
  await writeFile(planPath, [
    "## Направление",
    "",
    "## Фаза 1: Первый результат",
    "",
    "**Цель:** Создать результат",
  ].join("\n"));
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

function phaseDecision(phaseNumbers, tasks, previous = null) {
  return classifyPhaseWork(snapshot(parsePhasedPlan(plan(...phaseNumbers)), tasks), previous);
}

test("implementation run принимает задачи текущей фазы и новой фазы после неё", () => {
  const baseline = phaseDecision([1, 2], [task("1.1")]).progress;
  const scope = { kind: "implementation", phaseNumber: 1, baseline };

  assert.doesNotThrow(() =>
    assertPhaseTaskScope(phaseDecision([1, 2], [task("1.1"), task("1.2")], baseline), scope)
  );
  // Новая фаза агента получает свободный номер и стоит в plan.md сразу после Phase 1.
  const separated = phaseDecision([1, 3, 2], [task("1.1"), task("1.2"), task("3.1")], baseline);
  assert.doesNotThrow(() => assertPhaseTaskScope(separated, scope));
  assert.deepEqual(plannedPhaseNumbers(separated), [1, 3]);
});

test("implementation run не наполняет задачами фазы, которые планирует оркестратор", () => {
  const baseline = phaseDecision([1, 2], [task("1.1")]).progress;
  const scope = { kind: "implementation", phaseNumber: 1, baseline };

  // Найденный дефект: remediation-задача в ещё не распланированной Phase 2.
  assert.throws(
    () => assertPhaseTaskScope(phaseDecision([1, 2], [task("1.1"), task("2.1")], baseline), scope),
    /Во время implementation run Phase 1 новые задачи допускаются только в Phase 1 или в новой фазе, вставленной в plan\.md после неё с номером больше всех прежних\. Задачи 2\.1 нарушают это правило: фазы без задач планирует оркестратор/u,
  );
  // Новая фаза заняла номер 2, а прежняя Phase 2 перенумерована: номер фазы уже был в плане.
  assert.throws(
    () => assertPhaseTaskScope(phaseDecision([1, 2, 3], [task("1.1"), task("2.1")], baseline), scope),
    /Задачи 2\.1 нарушают это правило/u,
  );
  const many = Array.from({ length: 12 }, (_, index) => task(`2.${index + 1}`));
  assert.throws(
    () => assertPhaseTaskScope(phaseDecision([1, 2], [task("1.1"), ...many], baseline), scope),
    /Задачи 2\.1, 2\.2, 2\.3, 2\.4, 2\.5, 2\.6, 2\.7, 2\.8, 2\.9, 2\.10 и ещё 2 нарушают/u,
  );

  const preplanned = phaseDecision([1, 2, 3], [task("1.1"), task("2.1")]).progress;
  assert.throws(
    () => assertPhaseTaskScope(
      phaseDecision([1, 2, 3], [task("1.1"), task("2.1"), task("2.2")], preplanned),
      { kind: "implementation", phaseNumber: 1, baseline: preplanned },
    ),
    /Задачи 2\.2 нарушают это правило/u,
  );

  const secondRun = phaseDecision([1, 2, 3], [task("1.1", true), task("2.1")]).progress;
  assert.throws(
    () => assertPhaseTaskScope(
      phaseDecision([1, 4, 2, 3], [task("1.1", true), task("2.1"), task("4.1")], secondRun),
      { kind: "implementation", phaseNumber: 2, baseline: secondRun },
    ),
    /Задачи 4\.1 нарушают это правило/u,
  );
});

test("планирование фазы добавляет задачи только в целевую фазу", () => {
  const baseline = phaseDecision([1, 2, 3], [task("1.1", true)]).progress;
  const scope = { kind: "phase-planning", phaseNumber: 2, baseline };

  assert.doesNotThrow(() =>
    assertPhaseTaskScope(
      phaseDecision([1, 2, 3], [task("1.1", true), task("2.1"), task("2.2")], baseline),
      scope,
    )
  );
  assert.throws(
    () => assertPhaseTaskScope(
      phaseDecision([1, 2, 3], [task("1.1", true), task("2.1"), task("3.1")], baseline),
      scope,
    ),
    /При планировании Phase 2 новые задачи допускаются только в ней\. Задачи 3\.1 относятся к другим фазам/u,
  );
  assert.throws(
    () => assertPhaseTaskScope(
      phaseDecision([1, 2, 4, 3], [task("1.1", true), task("2.1"), task("4.1")], baseline),
      scope,
    ),
    /Задачи 4\.1 относятся к другим фазам/u,
  );
});

test("начальное планирование пополняет задачами только уже распланированные фазы", () => {
  const initial = phaseDecision([1, 2], [task("1.1")]);
  const scope = { kind: "initial-planning", plannedPhases: plannedPhaseNumbers(initial) };
  assert.deepEqual(scope.plannedPhases, [1]);

  // До первой проверки фаз история задач не фиксируется: review может переписать задачи Phase 1.
  assert.doesNotThrow(() =>
    assertPhaseTaskScope(phaseDecision([1, 2], [task("1.1", false, "task-new"), task("1.2")]), scope)
  );
  assert.throws(
    () => assertPhaseTaskScope(phaseDecision([1, 2], [task("1.1"), task("2.1")]), scope),
    /До первой проверки фаз задачи можно добавлять только в фазы, где они уже были: Phase 1\. Задачи 2\.1 нарушают это правило/u,
  );
  assert.throws(
    () => assertPhaseTaskScope(
      phaseDecision([1, 2], [task("1.1")]),
      { kind: "initial-planning", plannedPhases: [] },
    ),
    /До начального review задач не было ни в одной фазе.*Задачи 1\.1 нарушают это правило/u,
  );
});

test("список распланированных фаз следует порядку plan.md и пропускает фазы без задач", () => {
  assert.deepEqual(plannedPhaseNumbers(phaseDecision([3, 1, 2], [task("1.1"), task("3.1")])), [3, 1]);
  assert.deepEqual(plannedPhaseNumbers(phaseDecision([1, 2], [])), []);
});

test("проверка области передаёт inspect baseline области и отклоняет нарушение", async () => {
  const baseline = phaseDecision([1, 2], [task("1.1")]).progress;
  const previousValues = [];
  let tasks = [task("1.1"), task("1.2")];
  const phaseWork = {
    async inspect(workspace, inspectedChangeId, previous) {
      assert.equal(workspace, "/repo");
      assert.equal(inspectedChangeId, changeId);
      previousValues.push(previous);
      return phaseDecision([1, 2], tasks, previous);
    },
  };
  const implementation = { kind: "implementation", phaseNumber: 1, baseline };

  const decision = await inspectWithinTaskScope(phaseWork, "/repo", changeId, implementation);
  assert.equal(decision.kind, "implementation-required");
  await inspectWithinTaskScope(phaseWork, "/repo", changeId, {
    kind: "initial-planning",
    plannedPhases: [1],
  });
  assert.deepEqual(previousValues, [baseline, null]);

  tasks = [task("1.1"), task("2.1")];
  await assert.rejects(
    inspectWithinTaskScope(phaseWork, "/repo", changeId, implementation),
    (error) => error instanceof PhaseWorkError && /Задачи 2\.1/u.test(error.message),
  );
});

test("нарушение области задач становится ошибкой этапа, а сбой OpenSpec передаётся как есть", async () => {
  class StageError extends Error {}
  const baseline = phaseDecision([1, 2], [task("1.1")]).progress;
  const scope = { kind: "implementation", phaseNumber: 1, baseline };
  const signal = new AbortController().signal;
  const violating = createTaskScopeCheck(
    { async inspect(_workspace, _changeId, previous) {
      return phaseDecision([1, 2], [task("1.1"), task("2.1")], previous);
    } },
    "/repo",
    changeId,
    scope,
    (message) => new StageError(message),
  );
  await assert.rejects(
    violating(signal),
    (error) => error instanceof StageError && /Задачи 2\.1 нарушают/u.test(error.message),
  );

  const failure = new Error("OpenSpec недоступен");
  const broken = createTaskScopeCheck(
    { async inspect() { throw failure; } },
    "/repo",
    changeId,
    scope,
    (message) => new StageError(message),
  );
  await assert.rejects(broken(signal), (error) => error === failure);
});
