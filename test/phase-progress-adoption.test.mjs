import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptImplementationBaseline,
  adoptInitialPlannedPhases,
  adoptPhaseProgress,
  adoptPlanningRun,
  rebasePhaseProgress,
  taskTitle,
} from "../server/phase-progress-adoption.ts";
import { describeTaskHistoryViolation, phaseTaskFingerprint } from "../server/phase-work.ts";

const changeId = "adopted-change";

/** Задача в том виде, в каком её возвращает снимок OpenSpec: ID — позиция в файле. */
function task(position, number, title, done = false) {
  const id = String(position);
  const description = `${number} ${title}`;
  return {
    id,
    number,
    description,
    done,
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function snapshot(tasks, phases = [1, 2, 3]) {
  return {
    phases: phases.map((number) => ({ number })),
    tasks,
    schemaName: "spec-driven",
    planPath: `/repo/openspec/changes/${changeId}/plan.md`,
    taskArtifactPaths: [`/repo/openspec/changes/${changeId}/tasks.md`],
  };
}

function progress(tasks, phases = [1, 2, 3], nextImplementationRun = 3) {
  return {
    phases: phases.map((number) => ({ number })),
    tasks: tasks.map(({ id, number, description, done, fingerprint }) => ({
      id, number, description, done, fingerprint,
    })),
    nextImplementationRun,
  };
}

test("baseline run сохраняется, пока список задач его продолжает", () => {
  const baseline = progress([task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение"), task(3, "2.2", "Экран")]);
  const current = snapshot([
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Экран"),
    task(4, "2.3", "Доработка после review"),
  ]);
  const adoption = adoptImplementationBaseline(baseline, current, 2);
  assert.equal(adoption.violation, null);
  assert.equal(adoption.baseline, baseline);
});

test("перестановка и перенумерация невыполненных задач переносят baseline на новый список", () => {
  const baseline = progress([
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение"),
    task(3, "2.2", "Оболочка"),
    task(4, "2.3", "Заголовки"),
    task(5, "2.4", "Замена вставок"),
  ]);
  // 2.1 выполнена в текущем пакете; «Замена вставок» перенесена перед оболочкой.
  const current = snapshot([
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Замена вставок"),
    task(4, "2.3", "Оболочка"),
    task(5, "2.4", "Заголовки"),
  ]);
  const adoption = adoptImplementationBaseline(baseline, current, 2);
  assert.equal(adoption.violation, "Список задач перестал сохранять точный префикс на позиции 3");
  assert.deepEqual(
    adoption.baseline.tasks.map(({ id, description, done }) => [id, description, done]),
    [
      ["1", "1.1 Схема", true],
      // Выполнена после начала пакета: в baseline остаётся незавершённой.
      ["2", "2.1 Чтение", false],
      ["3", "2.2 Замена вставок", false],
      ["4", "2.3 Оболочка", false],
      ["5", "2.4 Заголовки", false],
    ],
  );
  assert.equal(adoption.baseline.nextImplementationRun, 3);
  assert.equal(describeTaskHistoryViolation(current.tasks, adoption.baseline), null);
});

test("отметка завершения следует за перенумерованной задачей, если её текст однозначен", () => {
  const baseline = progress([
    task(1, "1.1", "Схема", true),
    task(2, "1.2", "Подтвердить готовность", true),
    task(3, "2.1", "Подтвердить готовность", true),
    task(4, "2.2", "Чтение", true),
    task(5, "3.1", "Архив", true),
  ]);
  const current = snapshot([
    task(1, "1.1", "Вводная задача", true),
    task(2, "1.2", "Схема", true),
    task(3, "1.3", "Подтвердить готовность", true),
    task(4, "2.1", "Чтение", true),
    task(5, "2.2", "Подтвердить готовность", true),
    task(6, "3.1", "Архив", true),
  ]);
  const rebased = rebasePhaseProgress(baseline, current);
  assert.deepEqual(
    rebased.tasks.map(({ description, done }) => [description, done]),
    [
      // Новой задачи не было в baseline: на начало пакета она не завершена.
      ["1.1 Вводная задача", false],
      // Перенумерованы, текст однозначен.
      ["1.2 Схема", true],
      // Один текст у двух перенумерованных задач: сопоставление неоднозначно.
      ["1.3 Подтвердить готовность", false],
      ["2.1 Чтение", true],
      ["2.2 Подтвердить готовность", false],
      // Полное описание совпало с прежним.
      ["3.1 Архив", true],
    ],
  );
  assert.equal(taskTitle("2.10a Экран  "), "Экран");
});

test("снова открытая задача перестаёт считаться завершённой в baseline", () => {
  const baseline = progress([task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение")]);
  const current = snapshot([task(1, "1.1", "Схема", false), task(2, "2.1", "Чтение")]);
  const adoption = adoptImplementationBaseline(baseline, current, 2);
  assert.equal(adoption.violation, "Завершённая задача 1.1 снова открыта");
  assert.deepEqual(adoption.baseline.tasks.map(({ done }) => done), [false, false]);
});

test("задача, добавленная в чужую фазу вне этапа, входит в принятый baseline", () => {
  const baseline = progress([task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение")]);
  const current = snapshot([
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение"),
    task(3, "3.1", "Перестановка"),
  ]);
  const adoption = adoptImplementationBaseline(baseline, current, 2);
  assert.match(adoption.violation, /Задачи 3\.1 нарушают это правило/u);
  assert.equal(adoption.baseline.tasks.length, 3);
});

test("между run принятая история берёт фактические отметки задач", () => {
  const baseline = progress([task(1, "1.1", "Схема", true), task(2, "1.2", "Чтение", true)], [1, 2], 2);
  const kept = adoptPhaseProgress(baseline, snapshot([
    task(1, "1.1", "Схема", true),
    task(2, "1.2", "Чтение", true),
    task(3, "2.1", "Экран"),
  ], [1, 2]));
  assert.equal(kept.violation, null);
  assert.equal(kept.baseline, baseline);

  const adopted = adoptPhaseProgress(baseline, snapshot([
    task(1, "1.1", "Чтение", true),
    task(2, "1.2", "Схема"),
  ], [1, 2]));
  assert.equal(adopted.violation, "Список задач перестал сохранять точный префикс на позиции 1");
  assert.deepEqual(
    adopted.baseline.tasks.map(({ description, done }) => [description, done]),
    [["1.1 Чтение", true], ["1.2 Схема", false]],
  );
  assert.equal(adopted.baseline.nextImplementationRun, 2);
});

test("фазы начального планирования принимаются по текущим задачам", () => {
  const current = snapshot([task(1, "1.1", "Схема"), task(2, "2.1", "Чтение")]);
  assert.deepEqual(adoptInitialPlannedPhases([1, 2], current), { baseline: [1, 2], violation: null });
  const adopted = adoptInitialPlannedPhases([1], current);
  assert.match(adopted.violation, /Задачи 2\.1 нарушают это правило/u);
  assert.deepEqual(adopted.baseline, [1, 2]);
});

test("planning run сохраняет, переносит или аннулирует baseline по задачам вне фазы", () => {
  const run = {
    changeId,
    changeBranch: `change/${changeId}`,
    planningBranch: `change/${changeId}`,
    phaseNumber: 2,
    rootBaselineCommit: "a".repeat(40),
    baselineProgress: progress([task(1, "1.1", "Схема", true)], [1, 2, 3], 2),
  };
  const planned = [task(2, "2.1", "Чтение"), task(3, "2.2", "Экран")];

  // Задачи планируемой фазы можно переставлять: в baseline их нет.
  assert.deepEqual(
    adoptPlanningRun(run, snapshot([task(1, "1.1", "Схема", true), planned[1], planned[0]])),
    { kind: "kept" },
  );

  const reworded = adoptPlanningRun(
    run,
    snapshot([task(1, "1.1", "Схема хранения", true), ...planned]),
  );
  assert.equal(reworded.kind, "rebased");
  assert.equal(reworded.violation, "Список задач перестал сохранять точный префикс на позиции 1");
  assert.deepEqual(
    reworded.run.baselineProgress.tasks.map(({ description, done }) => [description, done]),
    [["1.1 Схема хранения", true]],
  );
  assert.equal(reworded.run.baselineProgress.nextImplementationRun, 2);

  // Открытая заново задача предыдущей фазы требует реализации до планирования.
  assert.deepEqual(
    adoptPlanningRun(run, snapshot([task(1, "1.1", "Схема", false), ...planned])),
    { kind: "void", violation: "Завершённая задача 1.1 снова открыта" },
  );
  // Задачи следующей фазы нельзя выразить baseline-префиксом.
  const later = adoptPlanningRun(
    run,
    snapshot([task(1, "1.1", "Схема", true), ...planned, task(4, "3.1", "Перестановка")]),
  );
  assert.equal(later.kind, "void");
  assert.match(later.violation, /Задачи 3\.1 относятся к другим фазам/u);
  // Задачу планируемой фазы уже выполнили: фаза перешла к реализации.
  assert.deepEqual(
    adoptPlanningRun(
      run,
      snapshot([task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение", true), planned[1]]),
    ),
    { kind: "void", violation: "Новая задача 2.1 уже отмечена завершённой" },
  );
});
