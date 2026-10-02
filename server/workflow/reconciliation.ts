import type { PendingArtifactSession } from "../change-artifact-creation.ts";
import type { PendingArchiveSession } from "../change-archive-model.ts";
import { changeIdFromBranch } from "../change-branch.ts";
import type { PendingFindingResolutionSession } from "../change-finding-resolution.ts";
import type { PendingChangeInitializationSession } from "../change-initialization.ts";
import { ChangeReviewPublicationError } from "../change-review-publication.ts";
import type { PendingReviewSession } from "../change-review.ts";
import type { PendingTaskExecutionSession } from "../change-task-execution.ts";
import type { PendingImplementationFindingResolutionSession } from "../implementation-finding-resolution.ts";
import type { PendingImplementationReviewSession } from "../implementation-review.ts";
import type { ImplementationRun } from "../implementation-run-model.ts";
import { reanchorImplementationRun } from "../implementation-run-reconciliation.ts";
import {
  adoptImplementationBaseline,
  adoptInitialPlannedPhases,
  adoptPhaseProgress,
  adoptPlanningRun,
} from "../phase-progress-adoption.ts";
import type { PendingPhaseTaskPlanningSession } from "../phase-task-planning.ts";
import {
  PhaseWorkError,
  type PhaseProgress,
  type PhaseTaskScope,
  type PhaseWorkDecision,
  type PhaseWorkService,
} from "../phase-work.ts";
import { planningRunSchema } from "../planning-run-model.ts";
import { RootBranchDeliveryError } from "../root-branch-delivery.ts";
import type { RootBranchOrigin, RootBranchService } from "../root-branch-state.ts";
import type { SessionAssessment } from "../session-assessment.ts";
import { ORCHESTRATOR_LIMITS } from "../../shared/orchestrator.ts";
import { workflowTaskScope } from "./task-scope.ts";
import type {
  WorkflowReconciler,
  WorkflowReconciliation,
  WorkflowState,
  WorkflowStepId,
} from "./types.ts";

/**
 * Оценка pending-сессий этапов. Каждая функция только читает рабочую область и
 * сообщает, можно ли продолжить сессию; исключение означает, что факты
 * прочитать не удалось и сессия остаётся неоценённой.
 */
export interface WorkflowSessionAssessors {
  changeInitialization(
    session: PendingChangeInitializationSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  artifact(
    changeId: string,
    session: PendingArtifactSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  review(session: PendingReviewSession, signal: AbortSignal): Promise<SessionAssessment>;
  findingResolution(
    session: PendingFindingResolutionSession,
    taskScope: PhaseTaskScope,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  implementationFindingResolution(
    session: PendingImplementationFindingResolutionSession,
    taskScope: PhaseTaskScope,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  taskExecution(
    session: PendingTaskExecutionSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  implementationReview(
    run: ImplementationRun,
    session: PendingImplementationReviewSession,
    taskBaseline: PhaseProgress,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  phaseTaskPlanning(
    session: PendingPhaseTaskPlanningSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  archive(session: PendingArchiveSession, signal: AbortSignal): Promise<SessionAssessment>;
}

export interface WorkflowReconciliationDependencies {
  readonly workspaceDirectory: string;
  readonly rootBranch: RootBranchService;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
  readonly sessions: WorkflowSessionAssessors;
}

/** Шаги, которые сами устанавливают исходные условия workflow. */
export const UNRECONCILED_STEPS: ReadonlySet<WorkflowStepId> = new Set([
  "check-agent-profiles",
  "check-git-branch",
  "check-git-worktree",
  "check-mise-toolchain",
]);

/**
 * Шаги, которые планируют работу от опубликованного HEAD корневой ветки.
 * Остальные шаги допускают локальные коммиты: создание артефактов и
 * планирование задач публикует следующий за ними `publish-change`.
 */
export const PUBLISHED_HEAD_STEPS: ReadonlySet<WorkflowStepId> = new Set([
  "prepare-planning-branch",
  "review-change",
  "resolve-review-findings",
  "inspect-phase-work",
  "prepare-phase-planning-branch",
  "prepare-implementation-branch",
  "execute-change-tasks",
  "review-implementation",
  "resolve-implementation-review-findings",
  "archive-change",
  "await-root-merge",
]);

/** Шаги, к которым согласование возвращает workflow по принятому состоянию. */
export const ROUTING_STEPS = {
  taskExecution: "execute-change-tasks",
  reviewFindings: "resolve-review-findings",
  phasePlanning: "plan-phase-tasks",
  phaseInspection: "inspect-phase-work",
} as const satisfies Record<string, WorkflowStepId>;

const UNCHANGED: WorkflowReconciliation = Object.freeze({ kind: "unchanged" });
const SUMMARY_PREFIX = "Принято состояние репозитория: ";

/** Рабочая копия состояния, которую этапы согласования приводят к репозиторию. */
interface Adoption {
  state: WorkflowState;
  next: WorkflowStepId;
  /** Baseline задач implementation run до принятия изменений списка. */
  previousBaseline: PhaseProgress | null;
  readonly notes: string[];
}

/** Поля состояния с pending-сессиями: каждое допускает `null`. */
type PendingSessionField = Extract<keyof WorkflowState, `pending${string}`>;
type SessionOf<Field extends PendingSessionField> = NonNullable<WorkflowState[Field]>;

interface SessionProbe {
  /** Название сессии для истории действий. */
  readonly label: string;
  readonly assess: () => Promise<SessionAssessment> | SessionAssessment;
}

interface PendingSession extends SessionProbe {
  readonly field: PendingSessionField;
}

/**
 * Оценка каждого вида pending-сессии. Таблица обязана покрывать все
 * pending-поля состояния: сессия без оценки осталась бы в состоянии навсегда.
 */
type SessionProbes = {
  readonly [Field in PendingSessionField]: (session: SessionOf<Field>) => SessionProbe;
};

/** Архивация оценивается до чтения задач: её коммит убирает активный change. */
const ARCHIVE_SESSION_FIELDS = ["pendingArchiveSession"] as const satisfies readonly PendingSessionField[];
const STAGE_SESSION_FIELDS = [
  "pendingChangeInitializationSession",
  "pendingPlanningBranchSession",
  "pendingImplementationBranchSession",
  "pendingArtifactSession",
  "pendingReviewSession",
  "pendingFindingResolutionSession",
  "pendingImplementationFindingResolutionSession",
  "pendingTaskExecutionSession",
  "pendingImplementationReviewSession",
  "pendingPhaseTaskPlanningSession",
] as const satisfies readonly PendingSessionField[];

/** Итог оценки pending-сессии для согласования. */
type SessionOutcome =
  /** Сессии нет либо она сброшена как устаревшая: этап планируется заново. */
  | "replanned"
  /** Сессия продолжается и удерживает свой baseline. */
  | "resumable"
  /** Факты прочитать не удалось: состояние менять нельзя. */
  | "unassessed";

/** Остановка согласования: причина и действие, которое должен выполнить пользователь. */
class ReconciliationHalt extends Error {
  readonly summary: string;
  constructor(summary: string, action: string) {
    super(clamp(`${summary}; ${action}`, ORCHESTRATOR_LIMITS.message));
    this.name = "ReconciliationHalt";
    this.summary = clamp(summary, ORCHESTRATOR_LIMITS.actionText);
  }
}

/**
 * Создаёт согласование стандартного OpenSpec workflow.
 *
 * Перед шагом оно приводит сохранённое состояние к репозиторию:
 *
 * 1. принимает список задач, изменённый вне этапа;
 * 2. сбрасывает pending-сессию, которую больше нельзя продолжить;
 * 3. без продолжаемой сессии переносит run на текущую историю и публикует
 *    локальные коммиты fast-forward;
 * 4. возвращает workflow к шагу, который соответствует принятому состоянию.
 *
 * Origin никогда не перезаписывается: расхождение историй останавливает
 * workflow с командой, которую должен выполнить пользователь.
 */
export function createWorkflowReconciler(
  dependencies: WorkflowReconciliationDependencies,
): WorkflowReconciler {
  const { workspaceDirectory, rootBranch, sessions } = dependencies;

  return async ({ signal, stepId, state }) => {
    const { changeBranch } = state;
    if (!changeBranch || UNRECONCILED_STEPS.has(stepId)) return UNCHANGED;
    // Change определяется корневой веткой: до конца инициализации в состоянии
    // его ещё нет, а её сессия уже может устареть.
    const changeId = changeIdFromBranch(changeBranch);
    const position = await rootBranch.inspect(workspaceDirectory, changeBranch, signal);
    // Чужая ветка и незакоммиченные правки — исходные условия шага: о них
    // сообщит он сам, а сверять состояние в таком репозитории нечем.
    if (position.kind === "unavailable") return UNCHANGED;
    const { head, origin } = position;
    const adoption: Adoption = { state, next: stepId, previousBaseline: null, notes: [] };

    try {
      assertOriginFollowsLocalBranch(origin, changeBranch);
      const probes = sessionProbes(adoption, changeId, head, signal);
      let session = await assessPendingSession(adoption, probes, ARCHIVE_SESSION_FIELDS, signal);
      // Архивный коммит переносит change из активного каталога: читать задачи
      // и переносить run во время архивации уже не нужно.
      if (session === "replanned" && !state.archivedChange) {
        const decision = await readTasks(adoption, changeId, signal);
        if (decision) adoptTaskBaselines(adoption, decision);
        session = await assessPendingSession(adoption, probes, STAGE_SESSION_FIELDS, signal);
        if (session === "replanned") {
          await reanchorRuns(adoption, decision, head, signal);
          if (decision) routeToMatchingStep(adoption, decision);
        }
      }
      // Неоценённая сессия может владеть любой частью состояния: принятые
      // изменения отбрасываются целиком, о проблеме сообщит шаг.
      if (session === "unassessed") return UNCHANGED;
      if (
        session === "replanned" &&
        origin.kind === "unpublished" &&
        PUBLISHED_HEAD_STEPS.has(adoption.next)
      ) {
        await publish(changeId, origin, head, signal);
        adoption.notes.push(`опубликовано коммитов: ${origin.commits}`);
      }
    } catch (error) {
      if (error instanceof ReconciliationHalt) {
        return { kind: "halt", summary: error.summary, message: error.message };
      }
      throw error;
    }

    return adoption.notes.length === 0
      ? UNCHANGED
      : {
          kind: "adopted",
          next: adoption.next,
          state: adoption.state,
          summary: summarize(adoption.notes),
        };
  };

  async function readTasks(
    adoption: Adoption,
    changeId: string,
    signal: AbortSignal,
  ): Promise<PhaseWorkDecision | null> {
    const { state } = adoption;
    const tracksTasks =
      state.implementationRun ?? state.planningRun ?? state.initialPlannedPhases ?? state.phaseProgress;
    if (!tracksTasks) return null;
    try {
      return await dependencies.phaseWork.inspect(workspaceDirectory, changeId, null, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof PhaseWorkError)) throw error;
      // Нечитаемый список задач не исправит ни один шаг: workflow должен
      // назвать настоящую причину, а не расхождение с устаревшей сессией.
      throw new ReconciliationHalt(
        error.message,
        "исправьте артефакты change и нажмите «Повторить»",
      );
    }
  }

  /**
   * Оценивает pending-сессию из перечисленных полей; в состоянии их не больше
   * одной. Продолжаемая сессия владеет своим baseline, поэтому run и origin
   * вокруг неё не меняются. Устаревшая сессия сбрасывается.
   */
  async function assessPendingSession(
    adoption: Adoption,
    probes: SessionProbes,
    fields: readonly PendingSessionField[],
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const pending = fields
      .map((field) => pendingSession(adoption.state, probes, field))
      .find((session) => session !== null);
    if (!pending) return "replanned";
    let assessment: SessionAssessment;
    try {
      assessment = await pending.assess();
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("[OpenSpec] Не удалось оценить pending-сессию перед шагом", {
        stepId: adoption.next,
        session: pending.field,
        code: errorCode(error),
      });
      return "unassessed";
    }
    if (assessment.kind === "resumable") return "resumable";
    adoption.state = { ...adoption.state, [pending.field]: null };
    adoption.notes.push(`${pending.label} сброшена (${assessment.reason})`);
    return "replanned";
  }

  /**
   * Оценки сессий читают `adoption.state` в момент вызова: область задач и run
   * берутся из состояния, в котором список задач уже принят.
   */
  function sessionProbes(
    adoption: Adoption,
    changeId: string,
    head: string,
    signal: AbortSignal,
  ): SessionProbes {
    // Сессии проверки корневой ветки хранят только ожидаемый HEAD.
    const expectedHead = (baseline: string): SessionAssessment =>
      baseline === head
        ? { kind: "resumable" }
        : { kind: "stale", reason: "Git HEAD изменился после проверки корневой ветки" };
    const taskScope = (): PhaseTaskScope => workflowTaskScope(adoption.state);
    return {
      pendingChangeInitializationSession: (session) => ({
        label: "сессия инициализации change",
        assess: () => sessions.changeInitialization(session, signal),
      }),
      pendingPlanningBranchSession: (session) => ({
        label: "проверка корневой ветки перед planning",
        assess: () => expectedHead(session.baselineCommit),
      }),
      pendingImplementationBranchSession: (session) => ({
        label: "проверка корневой ветки перед реализацией",
        assess: () => expectedHead(session.rootBaselineCommit),
      }),
      pendingArtifactSession: (session) => ({
        label: `сессия артефакта «${session.artifactId}»`,
        assess: () => sessions.artifact(changeId, session, signal),
      }),
      pendingReviewSession: (session) => ({
        label: "сессия review change",
        assess: () => sessions.review(session, signal),
      }),
      pendingFindingResolutionSession: (session) => ({
        label: `сессия finding «${session.findingId}»`,
        assess: () => sessions.findingResolution(session, taskScope(), signal),
      }),
      pendingImplementationFindingResolutionSession: (session) => ({
        label: `сессия implementation finding «${session.findingId}»`,
        assess: () => sessions.implementationFindingResolution(session, taskScope(), signal),
      }),
      pendingTaskExecutionSession: (session) => ({
        label: `сессия задачи ${session.taskNumber}`,
        assess: () => sessions.taskExecution(session, signal),
      }),
      pendingImplementationReviewSession: (session) => ({
        label: "сессия implementation review",
        assess: () => {
          const { implementationRun, phaseProgress } = adoption.state;
          return implementationRun && phaseProgress
            ? sessions.implementationReview(implementationRun, session, phaseProgress, signal)
            : { kind: "stale", reason: "implementation run больше не сохранён" };
        },
      }),
      pendingPhaseTaskPlanningSession: (session) => ({
        label: `сессия планирования Phase ${session.phaseNumber}`,
        assess: () => sessions.phaseTaskPlanning(session, signal),
      }),
      pendingArchiveSession: (session) => ({
        label: "сессия архивации",
        assess: () => sessions.archive(session, signal),
      }),
    };
  }

  /**
   * Переносит run на текущую историю, когда его не удерживает pending-сессия:
   * следующий этап планируется от фактического HEAD и фактических задач.
   */
  async function reanchorRuns(
    adoption: Adoption,
    decision: PhaseWorkDecision | null,
    head: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { implementationRun, planningRun, phaseProgress } = adoption.state;
    if (implementationRun && phaseProgress && decision) {
      const { batch } = implementationRun;
      // Границы проверенного пакета с историей не сверяются.
      const batchCommits = batch.kind === "reviewed"
        ? []
        : [
            batch.baseCommit,
            ...(batch.kind === "collecting"
              ? batch.tasks.flatMap(({ commit }) => (commit === null ? [] : [commit]))
              : []),
          ];
      const nearest = await rootBranch.nearestAncestors(
        workspaceDirectory,
        [implementationRun.rootBaselineCommit, ...batchCommits],
        head,
        signal,
      );
      const reanchored = reanchorImplementationRun({
        run: implementationRun,
        previousBaseline: adoption.previousBaseline ?? phaseProgress,
        baseline: phaseProgress,
        tasks: decision.snapshot.tasks,
        head,
        nearestAncestor: (commit) => nearest.get(commit) ?? null,
      });
      if (reanchored.notes.length > 0) {
        adoption.state = { ...adoption.state, implementationRun: reanchored.run };
        adoption.notes.push(...reanchored.notes);
      }
    }
    if (planningRun) {
      const nearest = await rootBranch.nearestAncestors(
        workspaceDirectory,
        [planningRun.rootBaselineCommit],
        head,
        signal,
      );
      const rootBaselineCommit = nearest.get(planningRun.rootBaselineCommit) ?? head;
      if (rootBaselineCommit !== planningRun.rootBaselineCommit) {
        adoption.state = {
          ...adoption.state,
          planningRun: planningRunSchema.parse({ ...planningRun, rootBaselineCommit }),
        };
        adoption.notes.push("baseline планирования перенесён на общий предок с текущей историей");
      }
    }
  }

  async function publish(
    changeId: string,
    origin: Extract<RootBranchOrigin, { kind: "unpublished" }>,
    head: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await rootBranch.publish(workspaceDirectory, changeId, origin.remoteHead, head, signal);
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof RootBranchDeliveryError || error instanceof ChangeReviewPublicationError)
      ) {
        throw error;
      }
      throw new ReconciliationHalt(
        `Не удалось опубликовать локальные коммиты: ${error.message}`,
        "исправьте состояние корневого PR или origin и нажмите «Повторить»",
      );
    }
  }
}

function pendingSession<Field extends PendingSessionField>(
  state: WorkflowState,
  probes: SessionProbes,
  field: Field,
): PendingSession | null {
  const session = state[field];
  return session ? { field, ...probes[field](session as SessionOf<Field>) } : null;
}

/**
 * Локальную ветку можно сверять и публиковать, только когда origin остаётся
 * её предком. Иначе продолжение потребовало бы переписать origin или локальную
 * ветку, а это решение принимает пользователь.
 */
function assertOriginFollowsLocalBranch(origin: RootBranchOrigin, changeBranch: string): void {
  switch (origin.kind) {
    case "absent":
    case "synchronized":
    case "unpublished":
      return;
    case "behind":
      throw new ReconciliationHalt(
        `Локальная ветка «${changeBranch}» отстаёт от origin`,
        `получите коммиты origin командой «git pull --ff-only origin ${changeBranch}» и нажмите «Повторить»`,
      );
    case "unfetched":
      throw new ReconciliationHalt(
        `В origin ветки «${changeBranch}» есть коммиты, которых нет локально`,
        `получите их командой «git pull --rebase origin ${changeBranch}» либо, если верна локальная история, опубликуйте её командой «git push --force-with-lease origin ${changeBranch}», затем нажмите «Повторить»`,
      );
    case "diverged":
      throw new ReconciliationHalt(
        `История локальной ветки «${changeBranch}» переписана относительно origin`,
        `оркестратор не перезаписывает origin: опубликуйте локальную историю командой «git push --force-with-lease origin ${changeBranch}» и нажмите «Повторить»`,
      );
  }
}

/**
 * Принимает список задач, который расходится с сохранённым baseline. Нарушение
 * внёс не предстоящий этап, поэтому его нельзя исправить продолжением workflow.
 */
function adoptTaskBaselines(adoption: Adoption, decision: PhaseWorkDecision): void {
  const { state } = adoption;
  const { snapshot } = decision;
  if (state.implementationRun && state.phaseProgress) {
    const run = state.implementationRun;
    const adopted = adoptImplementationBaseline(state.phaseProgress, snapshot, run.phaseNumber);
    if (adopted.violation !== null) {
      adoption.previousBaseline = state.phaseProgress;
      adoption.state = { ...state, phaseProgress: adopted.baseline };
      adoption.notes.push(`принят изменённый список задач (${adopted.violation})`);
    }
    if (!snapshot.tasks.some(({ phaseNumber }) => phaseNumber === run.phaseNumber)) {
      abandonRun(
        adoption,
        snapshot,
        `implementation run Phase ${run.phaseNumber} прекращён: в фазе не осталось задач`,
      );
    }
    return;
  }
  if (state.planningRun) {
    const run = state.planningRun;
    const adopted = adoptPlanningRun(run, snapshot);
    if (adopted.kind === "void") {
      abandonRun(
        adoption,
        snapshot,
        `планирование Phase ${run.phaseNumber} прекращено (${adopted.violation})`,
      );
      return;
    }
    if (adopted.kind === "rebased") {
      adoption.state = {
        ...state,
        planningRun: adopted.run,
        // Сессия планирования проверяется по прежнему baseline run.
        pendingPhaseTaskPlanningSession: null,
      };
      adoption.notes.push(`принят изменённый список задач (${adopted.violation})`);
    }
    const planned = decision.kind === "implementation-required" &&
      decision.phaseNumber === run.phaseNumber;
    const unplanned = decision.kind === "planning-required" &&
      decision.phaseNumber === run.phaseNumber;
    if (unplanned && adoption.next !== ROUTING_STEPS.phasePlanning) {
      // Задачи фазы исчезли после планирования: его нужно выполнить заново.
      adoption.state = clearPendingSessions(adoption.state);
      adoption.next = ROUTING_STEPS.phasePlanning;
      adoption.notes.push(`задачи Phase ${run.phaseNumber} удалены: фаза планируется заново`);
    } else if (!planned && !unplanned) {
      abandonRun(
        adoption,
        snapshot,
        `планирование Phase ${run.phaseNumber} прекращено: задачи change требуют другой работы`,
      );
    }
    return;
  }
  if (state.initialPlannedPhases) {
    const adopted = adoptInitialPlannedPhases(state.initialPlannedPhases, snapshot);
    if (adopted.violation !== null) {
      adoption.state = { ...state, initialPlannedPhases: [...adopted.baseline] };
      adoption.notes.push(`принят изменённый список задач (${adopted.violation})`);
    }
    return;
  }
  if (state.phaseProgress) {
    const adopted = adoptPhaseProgress(state.phaseProgress, snapshot);
    if (adopted.violation !== null) {
      adoption.state = { ...state, phaseProgress: adopted.baseline };
      adoption.notes.push(`принят изменённый список задач (${adopted.violation})`);
    }
  }
}

/**
 * Возвращает workflow к шагу, который соответствует принятому состоянию.
 * Вызывается только без продолжаемой сессии: она удерживает workflow на своём
 * шаге.
 */
function routeToMatchingStep(adoption: Adoption, decision: PhaseWorkDecision): void {
  const { state, next } = adoption;
  const run = state.implementationRun;
  if (next === "review-implementation" && run) {
    if (run.batch.kind === "reviewed") {
      // Review записал результат, но шаг прервался до перехода: повторять его
      // нечем, пакет ждёт устранения findings.
      adoption.next = ROUTING_STEPS.reviewFindings;
      adoption.notes.push("implementation review пакета уже завершён: workflow переходит к его findings");
      return;
    }
    const phaseHasWork = decision.snapshot.tasks.some(
      ({ phaseNumber, done }) => phaseNumber === run.phaseNumber && !done,
    );
    if (phaseHasWork || run.batch.kind === "empty") {
      adoption.next = ROUTING_STEPS.taskExecution;
      adoption.notes.push(
        phaseHasWork
          ? `implementation review отложен: в Phase ${run.phaseNumber} есть незавершённые задачи`
          : "implementation review отложен: в пакете нет завершённых задач",
      );
    }
    return;
  }
  if (next === "archive-change" && decision.kind !== "change-complete") {
    adoption.next = ROUTING_STEPS.phaseInspection;
    adoption.notes.push("архивация отложена: в change появилась незавершённая работа");
    return;
  }
  const target = state.phaseTarget;
  if (
    target &&
    (next === "prepare-phase-planning-branch" || next === "prepare-implementation-branch")
  ) {
    const expected = target.kind === "planning" ? "planning-required" : "implementation-required";
    if (decision.kind !== expected || decision.phaseNumber !== target.phaseNumber) {
      adoption.state = {
        ...state,
        phaseTarget: null,
        pendingPlanningBranchSession: null,
        pendingImplementationBranchSession: null,
      };
      adoption.next = ROUTING_STEPS.phaseInspection;
      adoption.notes.push(`Phase ${target.phaseNumber} больше не является следующей работой`);
    }
  }
}

/** Прекращает run и возвращает workflow к выбору следующей работы по задачам. */
function abandonRun(
  adoption: Adoption,
  snapshot: PhaseWorkDecision["snapshot"],
  note: string,
): void {
  const state = clearPendingSessions(adoption.state);
  adoption.state = {
    ...state,
    implementationRun: null,
    planningRun: null,
    phaseTarget: null,
    phaseProgress: state.phaseProgress && adoptPhaseProgress(state.phaseProgress, snapshot).baseline,
  };
  adoption.next = ROUTING_STEPS.phaseInspection;
  adoption.notes.push(note);
}

function clearPendingSessions(state: WorkflowState): WorkflowState {
  return {
    ...state,
    pendingPlanningBranchSession: null,
    pendingImplementationBranchSession: null,
    pendingReviewSession: null,
    pendingFindingResolutionSession: null,
    pendingImplementationFindingResolutionSession: null,
    pendingTaskExecutionSession: null,
    pendingImplementationReviewSession: null,
    pendingPhaseTaskPlanningSession: null,
  };
}

function summarize(notes: readonly string[]): string {
  return clamp(`${SUMMARY_PREFIX}${notes.join("; ")}`, ORCHESTRATOR_LIMITS.actionText);
}

/** Тексты действий и сообщений ledger ограничены по длине. */
function clamp(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return error instanceof Error ? error.name : "unknown";
}
