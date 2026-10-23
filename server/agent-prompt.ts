/**
 * Общие блоки стартовых промптов orchestrator-агентов.
 *
 * Каждая интерактивная стадия workflow запускает ровно одного агента с одним
 * стартовым промптом. Формулировки, одинаковые для всех стадий, живут здесь,
 * чтобы стадия описывала только свой контракт, а правила безопасности и границы
 * не расходились между стадиями. Всё, что уже описано вызываемым skill, в
 * промпт не переносится: промпт задаёт только то, чего skill не знает.
 */

/** Режим общения агента с пользователем на стадии. */
export type AgentCommunicationMode = "interactive" | "blocker-only";

const COMMUNICATION: Record<AgentCommunicationMode, string> = {
  interactive: "Communicate with the user in Russian.",
  "blocker-only":
    "Write in Russian, and only when a genuine blocker stops you; otherwise finish the stage without asking for approval.",
};

/** OpenSpec CLI доступен только через закреплённый mise-toolchain. */
export const OPENSPEC_CLI_RULE =
  "Run OpenSpec only as `mise exec --no-deps -- openspec ...` and never install or upgrade tools.";

/** Ветку выбирает workflow; агент работает на уже активной ветке. */
export const FIXED_BRANCH_RULE =
  "The workflow branch is already active: never create, switch, reset, rebase, merge, or force-push a branch, and never push tags.";

/** Стадии без PR-ответственности не вызывают GitHub API. */
export const NO_GITHUB_RULE =
  "Never invoke `gh` or call GitHub APIs: pull requests belong to the orchestrator.";

/** Стадии с GitHub-ответственностью работают неинтерактивно и не трогают учётные данные. */
export const GITHUB_CLI_RULE =
  "Use `gh` only non-interactively with `--repo`; never use `gh pr edit`, because pull-request field mutations belong to the orchestrator; never run `gh auth login`, `gh auth refresh`, or anything that prints a token.";

/**
 * Роль одной стадии. Оркестратор детерминированно запускает сессии по ролям и
 * сам выполняет шаги между ними, поэтому результат сессии должен быть
 * предсказуемым: агент делает только порученную работу и не берёт на себя
 * чужие шаги. Субагенты внутри сессии этим правилом не запрещены.
 */
export const STAGE_ROLE_RULE =
  "Stay within this stage's role: do only the work this prompt assigns, because the orchestrator itself runs every step between stages.";

/** Роль стадии и границы, общие для всех стадий, кроме архивирования. */
export const STAGE_SCOPE_RULE =
  `${STAGE_ROLE_RULE} Never create or archive workspaces or changes, and never invoke another workflow.`;

/**
 * Выбор модели субагентов. Субагенты по умолчанию наследуют модель и
 * reasoning effort сессии, а стадии могут работать на самой дорогой модели с
 * максимальным effort. Правило сформулировано условно, чтобы само по себе не
 * побуждать агента делегировать работу и не оправдывать лишних субагентов, и
 * не называет модель: её выбирает агент по линейке своего провайдера.
 */
const SUBAGENT_MODEL_RULE =
  "This rule never asks you to delegate. Only if delegating part of this stage to in-session subagents is worth its token cost, do not let them inherit your model and reasoning effort: for each subagent, choose the model and reasoning effort from your provider with the best price-to-quality fit for its task.";

/** Фазы, которые этап может пополнять задачами; структурно совместимо с PhaseTaskScope. */
export type TaskScopePromptInput =
  | { readonly kind: "initial-planning"; readonly plannedPhases: readonly number[] }
  | { readonly kind: "phase-planning" | "implementation"; readonly phaseNumber: number };

const UNPLANNED_PHASE_RULE =
  "The orchestrator plans every phase that has no tasks: never add tasks to such a phase, and capture work that belongs there in that phase of plan.md instead.";

/**
 * Порядок исполнения задач. Оркестратор не читает зависимости и пометки в
 * тексте: он берёт первую незавершённую задачу фазы по порядку в файле.
 */
export const TASK_ORDER_FACT =
  "The orchestrator executes the incomplete tasks of a phase one at a time, strictly in file order.";

/**
 * До начала реализации задачи фазы ещё не входят в сохранённую историю,
 * поэтому этап планирования расставляет их в порядке выполнения.
 */
const PLANNED_TASK_ORDER_RULE =
  "Place every task after the tasks it depends on: until they run, the incomplete tasks of the phases you may extend may be inserted, reordered, and renumbered. Never describe an execution order that differs from file order.";

/** Правило добавления задач: фазы без задач планирует только оркестратор. */
export function taskScopeRule(scope: TaskScopePromptInput): string {
  switch (scope.kind) {
    case "initial-planning":
      return scope.plannedPhases.length === 0
        ? `No phase has tasks yet, so do not add tasks. ${UNPLANNED_PHASE_RULE}`
        : `Add new tasks only to phases that already have tasks: ${scope.plannedPhases.map((phase) => `Phase ${phase}`).join(", ")}. ${TASK_ORDER_FACT} ${PLANNED_TASK_ORDER_RULE} ${UNPLANNED_PHASE_RULE}`;
    case "phase-planning":
      return `Add new tasks only to Phase ${scope.phaseNumber}. ${TASK_ORDER_FACT} ${PLANNED_TASK_ORDER_RULE} ${UNPLANNED_PHASE_RULE}`;
    case "implementation": {
      const phase = scope.phaseNumber;
      return `Add new tasks only to Phase ${phase} or to a new phase of your own, and append every new task after all existing tasks. ${TASK_ORDER_FACT} Append the new tasks in the order they must run. Number new Phase ${phase} tasks as ${phase}.<next free number>. Never add tasks to another existing phase. ${UNPLANNED_PHASE_RULE} When the agreed follow-up needs a phase of its own, insert its heading in plan.md right after Phase ${phase} with a number greater than every existing phase number, keep every existing phase number unchanged, and number its tasks with that new phase number.`;
    }
  }
}

/**
 * Правило сохранения списка задач для review-этапов. Во время implementation
 * run история задач неизменна. При планировании сохраняются только
 * завершённые задачи: незавершённые ещё можно расставить в порядке выполнения.
 */
export function taskHistoryRule(scope: TaskScopePromptInput): string {
  return scope.kind === "implementation"
    ? "Preserve the workflow's recorded task history: task IDs, numbers, descriptions, and order stay the same, completed tasks stay complete, and new tasks start incomplete."
    : "Preserve the workflow's recorded task history: completed tasks stay exactly as they are and stay complete, and new tasks start incomplete.";
}

/** Данные области задач для workflow data промпта. */
export function taskScopeWorkflowData(
  scope: TaskScopePromptInput,
): Readonly<Record<string, unknown>> {
  return scope.kind === "initial-planning"
    ? { plannedPhases: scope.plannedPhases }
    : { phaseNumber: scope.phaseNumber };
}

/**
 * Место сессии агента относительно завершения фазы plan.md.
 *
 * Агент не знает, какая стадия workflow завершает фазу, и иначе применяет
 * правила репозитория о полных проверках «перед завершением фазы» к концу
 * любой стадии, включая правку одних артефактов. Фазу завершает только
 * implementation review: оно начинается, когда все задачи фазы выполнены,
 * и его исправления — последние правки кода перед переходом к следующей фазе.
 *
 * - `no-code` — сессия не меняет код: артефакты, документация, восстановление;
 * - `code` — сессия может менять код, но фазу не завершает;
 * - `phase-completion` — сессия завершает фазу `phaseNumber`.
 */
export type StageVerification =
  | { readonly kind: "no-code" }
  | { readonly kind: "code" }
  | { readonly kind: "phase-completion"; readonly phaseNumber: number };

const PHASE_COMPLETION_FACT =
  "Only the implementation review that starts after the last task of a plan.md phase completes that phase.";

export function stageVerificationRule(verification: StageVerification): string {
  switch (verification.kind) {
    case "no-code":
      return `This session changes no implementation code and does not complete a plan.md phase: never run tests, builds, or project checks. ${PHASE_COMPLETION_FACT}`;
    case "code":
      return `This session does not complete a plan.md phase, even when no incomplete task remains after it: never run the full checks the repository requires before completing a phase. When you change code, run only the focused verification the repository requires for that change. ${PHASE_COMPLETION_FACT}`;
    case "phase-completion":
      return `Every task of Phase ${verification.phaseNumber} is complete, so this session completes that plan.md phase: after your last code correction, run the full checks the repository requires before completing a phase.`;
  }
}

export interface AgentPromptSpec {
  /** Одно предложение о зоне ответственности агента. */
  readonly role: string;
  readonly communication: AgentCommunicationMode;
  /** Какие проверки уместны в этой сессии; рендерится последним правилом. */
  readonly verification: StageVerification;
  /** Параметры стадии; передаются агенту как JSON. */
  readonly workflowData: Readonly<Record<string, unknown>>;
  /** Общие и стадийные правила; рендерятся одним абзацем. */
  readonly rules: readonly string[];
  /** Контракт стадии: по абзацу на шаг. Пустые абзацы отбрасываются. */
  readonly body: readonly string[];
  /** Условие завершения стадии. */
  readonly completion: string;
}

export function buildAgentPrompt(spec: AgentPromptSpec): string {
  return [
    spec.role,
    `${COMMUNICATION[spec.communication]} Workflow data: ${JSON.stringify(spec.workflowData)}`,
    [...spec.rules, SUBAGENT_MODEL_RULE, stageVerificationRule(spec.verification)].join(" "),
    ...spec.body,
    spec.completion,
  ]
    .filter((paragraph) => paragraph.trim().length > 0)
    .join("\n\n");
}

export interface CompletionContract {
  /** Единственный MCP-инструмент стадии. */
  readonly tool: string;
  /** Аргумент вызова; по умолчанию — пустой объект. */
  readonly argument?: string;
  /** Что разрешено исправить перед повторным вызовом. */
  readonly retryScope: string;
  /** Добавляется после контракта: чем стадия заканчивается для агента. */
  readonly afterSuccess?: string;
}

export function completionInstruction(contract: CompletionContract): string {
  const argument = contract.argument ?? "an empty object";
  const afterSuccess =
    contract.afterSuccess == null ? "" : ` ${contract.afterSuccess}`;
  return `Finish by calling the orchestrator MCP tool \`${contract.tool}\` with ${argument}. If it reports an error, fix only ${contract.retryScope} and retry the same tool.${afterSuccess}`;
}
