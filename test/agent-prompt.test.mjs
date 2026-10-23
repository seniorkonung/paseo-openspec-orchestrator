import assert from "node:assert/strict";
import test from "node:test";
import { STAGE_SCOPE_RULE, buildAgentPrompt, stageVerificationRule } from "../server/agent-prompt.ts";

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

  assert.ok(rules.startsWith("Первое правило. This rule never asks you to delegate."));
  assert.match(rules, /reasoning effort[^.]*for its task\. This session changes no implementation code/u);
  assert.ok(rules.endsWith(stageVerificationRule({ kind: "no-code" })));
});

test("промпт любой стадии запрещает субагентам наследовать модель, не побуждая делегировать", () => {
  const prompt = buildAgentPrompt({
    role: "Роль.",
    communication: "blocker-only",
    verification: { kind: "code" },
    workflowData: {},
    rules: [],
    body: ["Шаг."],
    completion: "Завершение.",
  });
  const rules = prompt.split("\n\n")[2];

  assert.match(rules, /This rule never asks you to delegate\./u);
  assert.match(rules, /Only if delegating part of this stage to in-session subagents is worth its token cost/u);
  assert.match(rules, /do not let them inherit your model and reasoning effort/u);
  assert.match(rules, /choose the model and reasoning effort from your provider with the best price-to-quality fit for its task/u);
  assert.doesNotMatch(rules, /sonnet|opus|haiku|gpt|codex|claude/iu);
});

test("правило стадии удерживает агента в его роли, но не запрещает субагентов", () => {
  assert.match(STAGE_SCOPE_RULE, /Stay within this stage's role: do only the work this prompt assigns/u);
  assert.match(STAGE_SCOPE_RULE, /the orchestrator itself runs every step between stages/u);
  assert.match(STAGE_SCOPE_RULE, /Never create or archive workspaces or changes, and never invoke another workflow/u);
  assert.doesNotMatch(STAGE_SCOPE_RULE, /agent/iu);
});
