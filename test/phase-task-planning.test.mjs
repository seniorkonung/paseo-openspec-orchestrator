import assert from "node:assert/strict";
import test from "node:test";
import {
  pendingPhaseTaskPlanningSessionSchema,
  phaseTaskPlanningPrompt,
  assertPhasePlanningDecision,
} from "../server/phase-task-planning.ts";
import { phaseTaskFingerprint } from "../server/phase-work.ts";
import { assertPhasePlanningChangedPaths } from "../server/workflow/steps/validate-phase-planning.ts";

const session = pendingPhaseTaskPlanningSessionSchema.parse({
  changeId: "phase-change",
  changeBranch: "change/phase-change",
  planningBranch: "change/phase-change",
  phaseNumber: 2,
  baselineCommit: "a".repeat(40),
  baselineProgress: {
    phases: [
      { number: 1, fingerprint: "1".repeat(64) },
      { number: 2, fingerprint: "2".repeat(64) },
    ],
    tasks: [{
      id: "task-a",
      number: "1.1",
      description: "1.1 Готовая задача",
      done: true,
      fingerprint: phaseTaskFingerprint("task-a", "1.1", "1.1 Готовая задача"),
    }],
    nextImplementationRun: 4,
  },
  taskPaths: ["openspec/changes/phase-change/tasks.md"],
});

test("prompt прямо поручает openspec-update-change только одну фазу без catalog probe", () => {
  const prompt = phaseTaskPlanningPrompt(session, false);
  assert.match(prompt, /Invoke the openspec-update-change skill/u);
  assert.match(prompt, /exclusively for Phase 2/u);
  assert.match(prompt, /Do not inspect the command catalog first/u);
  assert.match(prompt, /interactive confirmation/u);
  assert.match(prompt, /at least one incomplete task numbered 2\.\*/u);
  assert.doesNotMatch(prompt, /agent\.commands|commands\(\)/u);
});

test("recovery prompt запрещает повторный вызов skill и новый commit", () => {
  const prompt = phaseTaskPlanningPrompt(session, true);
  assert.match(prompt, /recovery session/u);
  assert.match(prompt, /Do not invoke the skill/u);
  assert.match(prompt, /do not invoke the skill, edit files, or amend\/create a commit/iu);
});

test("planning result сохраняет completion state старых задач и добавляет только целевую фазу", () => {
  const added = {
    id: "task-b",
    number: "2.1",
    description: "2.1 Новая задача",
    done: false,
    phaseNumber: 2,
    fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Новая задача"),
  };
  const preserved = {
    ...session.baselineProgress.tasks[0],
    phaseNumber: 1,
  };
  const decision = {
    kind: "implementation-required",
    phaseNumber: 2,
    runNumber: 4,
    progress: session.baselineProgress,
    snapshot: { tasks: [preserved, added] },
  };
  assert.doesNotThrow(() =>
    assertPhasePlanningDecision(decision, session.baselineProgress, 2)
  );
  assert.throws(
    () => assertPhasePlanningDecision(
      { ...decision, snapshot: { tasks: [{ ...preserved, done: false }, added] } },
      session.baselineProgress,
      2,
    ),
    /completion state/u,
  );
  assert.throws(
    () => assertPhasePlanningDecision(
      {
        ...decision,
        snapshot: {
          tasks: [preserved, added, {
            ...added,
            id: "task-c",
            phaseNumber: 1,
            number: "1.2",
            fingerprint: phaseTaskFingerprint("task-c", "1.2", "1.2 Новая задача"),
          }],
        },
      },
      session.baselineProgress,
      2,
    ),
    /незавершённую задачу 2\.\*/u,
  );
});

test("финальная проверка phase planning не допускает изменения кода", () => {
  const allowed = [
    "openspec/changes/phase-change/tasks.md",
    "openspec/changes/phase-change/review.md",
  ];
  assert.doesNotThrow(() => assertPhasePlanningChangedPaths(allowed, allowed));
  assert.throws(
    () => assertPhasePlanningChangedPaths(
      [...allowed, "server/application.ts"],
      allowed,
    ),
    /недопустимый файл/u,
  );
});
