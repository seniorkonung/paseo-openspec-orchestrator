import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPrompt, stageVerificationRule } from "../server/agent-prompt.ts";

test("сессия без правок кода не запускает ни тесты, ни проверки проекта", () => {
  const rule = stageVerificationRule({ kind: "no-code" });

  assert.match(rule, /changes no implementation code and does not complete a plan\.md phase/u);
  assert.match(rule, /never run tests, builds, or project checks/u);
  assert.match(rule, /Only the implementation review that starts after the last task of a plan\.md phase completes that phase/u);
});

test("сессия с правками кода ограничивается точечной проверкой даже после последней задачи фазы", () => {
  const rule = stageVerificationRule({ kind: "code" });

  assert.match(rule, /does not complete a plan\.md phase, even when no incomplete task remains after it/u);
  assert.match(rule, /never run the full checks the repository requires before completing a phase/u);
  assert.match(rule, /run only the focused verification the repository requires for that change/u);
  assert.match(rule, /Only the implementation review that starts after the last task of a plan\.md phase completes that phase/u);
});

test("только завершающая фазу сессия запускает полные проверки после своих правок", () => {
  const rule = stageVerificationRule({ kind: "phase-completion", phaseNumber: 3 });

  assert.match(rule, /Every task of Phase 3 is complete, so this session completes that plan\.md phase/u);
  assert.match(rule, /after your last code correction, run the full checks the repository requires before completing a phase/u);
  assert.doesNotMatch(rule, /never run/u);
});

test("промпт стадии всегда содержит правило проверок после остальных правил", () => {
  const prompt = buildAgentPrompt({
    role: "Роль.",
    communication: "interactive",
    verification: { kind: "no-code" },
    workflowData: {},
    rules: ["Первое правило."],
    body: ["Шаг."],
    completion: "Завершение.",
  });
  const rules = prompt.split("\n\n")[2];

  assert.ok(rules.startsWith("Первое правило. This session changes no implementation code"));
});
