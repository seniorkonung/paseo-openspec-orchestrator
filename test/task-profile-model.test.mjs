import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTaskProfiles,
  escalateTaskProfile,
  executionProfileFor,
  mergeTaskProfiles,
  parseTaskProfiles,
  recordForTask,
  renderTaskProfiles,
  summarizeTaskProfiles,
  unassessedTasks,
} from "../server/task-profile-model.ts";

const tasks = [
  { number: "2.1", description: "2.1 Добавить чтение настроек" },
  { number: "2.2", description: "2.2 Обновить документацию" },
];

function assessed(task, profile, rationale = "Задача повторяет существующий паттерн") {
  return { taskNumber: task.number, heading: task.description, assignment: { kind: "assessed", profile, rationale } };
}

test("файл профилей сохраняет оценки и эскалацию при повторном разборе", () => {
  const records = [
    assessed(tasks[0], "High", "Меняется общий контракт модулей"),
    {
      taskNumber: "2.2",
      heading: tasks[1].description,
      assignment: { kind: "escalated", rationale: "Простая правка текста", reason: "Документация противоречит коду" },
    },
  ];
  const source = renderTaskProfiles(records);
  assert.match(source, /^# Профили агентов OpenSpec-задач\n/u);
  assert.match(source, /## 2\.2 Обновить документацию\n\n- \*\*Профиль:\*\* High\n- \*\*Обоснование:\*\* Простая правка текста\n- \*\*Эскалация на High:\*\* Документация противоречит коду\n/u);
  assert.deepEqual(parseTaskProfiles(source), records);
  assert.deepEqual(parseTaskProfiles(renderTaskProfiles([])), []);
});

test("разбор файла профилей отклоняет отклонения от формата с понятной причиной", () => {
  const valid = renderTaskProfiles([assessed(tasks[0], "Medium")]);
  const cases = [
    [valid.replace("<!-- paseo-openspec-orchestrator:task-profiles:v1 -->\n", ""), /нет служебного marker/u],
    [valid.replace("**Профиль:** Medium", "**Профиль:** Low"), /должно быть одним из: High, Medium/u],
    [valid.replace("Задача повторяет существующий паттерн", "Simple task"), /русском/u],
    [`${valid}\n## 2.1 Добавить чтение настроек\n\n- **Профиль:** High\n- **Обоснование:** Повтор\n`, /профиль задачи 2\.1 повторяется/u],
    [valid.replace("## 2.1", "## Без номера"), /некорректный заголовок задачи/u],
    [`${valid}- **Лишнее:** поле\n- **Ещё:** поле\n`, /2 или 3 строки полей/u],
    [
      valid.replace("паттерн\n", "паттерн\n- **Эскалация на High:** Причина эскалации\n"),
      /после эскалации поле «Профиль» должно быть High/u,
    ],
  ];
  for (const [source, message] of cases) {
    assert.throws(() => parseTaskProfiles(source), message);
  }
});

test("оценки должны покрывать ровно задачи сессии", () => {
  const input = (...assessments) => ({ assessments });
  const entry = (taskNumber, profile = "Medium") => ({ taskNumber, profile, rationale: "Понятная локальная правка" });
  assert.throws(() => bindTaskProfiles(tasks, input(entry("2.1"))), /Нет оценки задач: 2\.2/u);
  assert.throws(
    () => bindTaskProfiles(tasks, input(entry("2.1"), entry("2.2"), entry("2.3"))),
    /вне этой сессии: 2\.3/u,
  );
  assert.throws(
    () => bindTaskProfiles(tasks, input(entry("2.1"), entry("2.1"), entry("2.2"))),
    /2\.1 передана больше одного раза/u,
  );
  const bound = bindTaskProfiles(tasks, input(entry("2.2", "High"), entry("2.1")));
  assert.deepEqual(bound.map(({ heading, assignment }) => [heading, assignment.profile]), [
    ["2.1 Добавить чтение настроек", "Medium"],
    ["2.2 Обновить документацию", "High"],
  ]);
});

test("изменённая задача теряет оценку, а новая оценка заменяет прежнюю на месте", () => {
  const existing = [assessed(tasks[0], "Medium"), assessed({ number: "1.1", description: "1.1 Схема" }, "High")];
  const edited = { number: "2.1", description: "2.1 Добавить чтение и запись настроек" };
  assert.equal(recordForTask(existing, tasks[0]).assignment.profile, "Medium");
  assert.deepEqual(unassessedTasks([edited, tasks[1]], existing), [edited, tasks[1]]);

  const merged = mergeTaskProfiles(existing, [assessed(edited, "High"), assessed(tasks[1], "Medium")]);
  assert.deepEqual(merged.map(({ heading }) => heading), [
    "2.1 Добавить чтение и запись настроек",
    "1.1 Схема",
    "2.2 Обновить документацию",
  ]);
  assert.deepEqual(unassessedTasks([edited, tasks[1]], merged), []);
  assert.equal(summarizeTaskProfiles(merged), "High: 2.1, 1.1; Medium: 2.2");
});

test("эскалация переводит задачу Medium на High и сохраняет исходное обоснование", () => {
  const records = [assessed(tasks[0], "Medium"), assessed(tasks[1], "High")];
  const escalated = escalateTaskProfile(records, tasks[0], "  Причина сбоя не ясна  ");
  assert.deepEqual(recordForTask(escalated, tasks[0]).assignment, {
    kind: "escalated",
    rationale: "Задача повторяет существующий паттерн",
    reason: "Причина сбоя не ясна",
  });
  assert.deepEqual(executionProfileFor(recordForTask(escalated, tasks[0])), {
    profile: "High",
    escalationReason: "Причина сбоя не ясна",
  });
  assert.deepEqual(executionProfileFor(records[0]), { profile: "Medium", escalationReason: null });
  assert.throws(() => escalateTaskProfile(records, tasks[1], "Причина"), /уже назначен профиль High/u);
  assert.throws(
    () => escalateTaskProfile(records, { number: "2.3", description: "2.3 Новая задача" }, "Причина"),
    /не содержит оценку задачи 2\.3/u,
  );
  assert.throws(() => escalateTaskProfile(records, tasks[0], "unclear"), /русском/u);
});
