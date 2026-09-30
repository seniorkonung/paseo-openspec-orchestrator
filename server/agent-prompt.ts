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

/** Границы одной стадии: агент не расширяет workflow. */
export const STAGE_SCOPE_RULE =
  "Stay inside this stage: never spawn or archive agents, workspaces, or changes, and never invoke another workflow.";

/** Фазы, которые этап может пополнять задачами; структурно совместимо с PhaseTaskScope. */
export type TaskScopePromptInput =
  | { readonly kind: "initial-planning"; readonly plannedPhases: readonly number[] }
  | { readonly kind: "phase-planning" | "implementation"; readonly phaseNumber: number };

const UNPLANNED_PHASE_RULE =
  "The orchestrator plans every phase that has no tasks: never add tasks to such a phase, and capture work that belongs there in that phase of plan.md instead.";

/** Правило добавления задач: фазы без задач планирует только оркестратор. */
export function taskScopeRule(scope: TaskScopePromptInput): string {
  switch (scope.kind) {
    case "initial-planning":
      return scope.plannedPhases.length === 0
        ? `No phase has tasks yet, so do not add tasks. ${UNPLANNED_PHASE_RULE}`
        : `Add new tasks only to phases that already have tasks: ${scope.plannedPhases.map((phase) => `Phase ${phase}`).join(", ")}. ${UNPLANNED_PHASE_RULE}`;
    case "phase-planning":
      return `Add new tasks only to Phase ${scope.phaseNumber}. ${UNPLANNED_PHASE_RULE}`;
    case "implementation": {
      const phase = scope.phaseNumber;
      return `Add new tasks only to Phase ${phase} or to a new phase of your own, and append every new task after all existing tasks. Number new Phase ${phase} tasks as ${phase}.<next free number>. Never add tasks to another existing phase. ${UNPLANNED_PHASE_RULE} When the agreed follow-up needs a phase of its own, insert its heading in plan.md right after Phase ${phase} with a number greater than every existing phase number, keep every existing phase number unchanged, and number its tasks with that new phase number.`;
    }
  }
}

/** Данные области задач для workflow data промпта. */
export function taskScopeWorkflowData(
  scope: TaskScopePromptInput,
): Readonly<Record<string, unknown>> {
  return scope.kind === "initial-planning"
    ? { plannedPhases: scope.plannedPhases }
    : { phaseNumber: scope.phaseNumber };
}

export interface AgentPromptSpec {
  /** Одно предложение о зоне ответственности агента. */
  readonly role: string;
  readonly communication: AgentCommunicationMode;
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
    spec.rules.join(" "),
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
