import type { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
  buildAgentPrompt,
  taskScopeRule,
  taskScopeWorkflowData,
  type TaskScopePromptInput,
} from "./agent-prompt.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchSchema } from "./change-branch.ts";
import {
  MAX_CHANGE_REVIEW_FINDINGS,
  reviewFindingIdSchema,
  type ReviewFindingId,
} from "./change-review-report.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";
import type {
  ExecutableFindingDecisionRecord,
  FindingDecision,
} from "./review-finding-decision-model.ts";
import {
  type CompletedFindingPullRequest,
  type ReviewFindingOutcome,
  type ReviewFindingPublicationKind,
} from "./review-finding-publication.ts";

export const findingResolutionBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Имя Git-ветки содержит небезопасные символы",
  )
  .refine(
    (value) =>
      value !== "@" &&
      value !== "main" &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для устранения finding требуется безопасное имя non-main Git-ветки",
  );

export interface ReviewFindingResolutionSession {
  readonly changeId: string;
  readonly branch: string;
  readonly findingId: ReviewFindingId;
  readonly baselineCommit: string;
}

/**
 * Сессия решений: пользователь решает сразу все открытые findings отчёта.
 * Решения записываются в файл рядом с отчётом и исполняются автономно.
 */
export const pendingFindingDecisionSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    branch: changeBranchSchema,
    findingIds: z
      .array(reviewFindingIdSchema)
      .min(1)
      .max(MAX_CHANGE_REVIEW_FINDINGS)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "ID findings в сессии решений не должны повторяться",
      ),
    baselineCommit: commitHashSchema,
  })
  .strict();

export type PendingFindingDecisionSession = z.output<
  typeof pendingFindingDecisionSessionSchema
>;

/** Сохранённая работа шага findings: сессия решений либо исполнение одной finding. */
export type FindingWork<Session extends ReviewFindingResolutionSession> =
  | { readonly kind: "decisions"; readonly session: PendingFindingDecisionSession }
  | { readonly kind: "resolution"; readonly session: Session };

export type ReviewFindingResolutionPlan<Session extends ReviewFindingResolutionSession> =
  | {
      readonly kind: "no-findings";
      readonly reviewPath: string;
      readonly headCommit: string;
    }
  | {
      readonly kind: "decisions-required";
      readonly session: PendingFindingDecisionSession;
    }
  | {
      readonly kind: "finding-required";
      readonly findingId: ReviewFindingId;
      readonly session: Session;
    };

/**
 * Итог сессии исполнения: finding закрыта по решению пользователя либо
 * решение нельзя исполнить как согласовано, и нужно новое решение.
 */
export type FindingResolutionOutcome = ReviewFindingOutcome | "blocked";

interface FindingResolutionBase {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
}

export type CompletedReviewFindingResolution =
  | (FindingResolutionBase & {
      readonly outcome: ReviewFindingOutcome;
      readonly pullRequest: CompletedFindingPullRequest;
    })
  | (FindingResolutionBase & {
      readonly outcome: "blocked";
      readonly reason: string;
    });

export type VerifiedReviewFindingResolution =
  | (FindingResolutionBase & { readonly outcome: ReviewFindingOutcome })
  | (FindingResolutionBase & { readonly outcome: "blocked"; readonly reason: string });

/** Решения, записанные и опубликованные сессией решений. */
export interface RecordedFindingDecisions {
  readonly changeId: string;
  readonly commit: string;
  readonly decisions: readonly ExecutableFindingDecisionRecord[];
}

export interface FindingResolutionContext extends RepoLocalChangePaths {
  readonly changeId: string;
  readonly reviewPath: string;
  readonly reviewRepositoryPath: string;
}

export interface ReviewFindingReportLocation {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath: typeof lstat;
  readonly resolveRealPath: typeof realpath;
}

export interface ActiveReviewFindingReport {
  readonly findings: readonly {
    readonly id: ReviewFindingId;
    readonly heading: string;
  }[];
  readonly acceptedRisks: readonly {
    readonly originatingFindingId: string;
  }[];
}

/** Что уже сделано в восстанавливаемой сессии исполнения. */
export type FindingResolutionRecovery =
  | { readonly kind: "none" }
  /** Finding закрыта проверенным коммитом, но её итога ещё нет в PR. */
  | { readonly kind: "committed" }
  /** Итог finding уже опубликован в корневом PR. */
  | { readonly kind: "published" };

export interface ReviewFindingPromptInput {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  /** Коммит, в котором записано исполняемое решение. */
  readonly baselineCommit: string;
  readonly findingHeading: string;
  readonly decision: FindingDecision;
  readonly branch: string;
  readonly reviewRepositoryPath: string;
  readonly decisionsRepositoryPath: string;
  readonly recovery: FindingResolutionRecovery;
  /** Фазы, в которые устранение может добавлять задачи. */
  readonly taskScope: TaskScopePromptInput;
}

export interface FindingDecisionPromptInput {
  readonly changeId: string;
  readonly branch: string;
  readonly findingIds: readonly ReviewFindingId[];
  /** Препятствия, из-за которых прежние решения не удалось исполнить. */
  readonly blockers: Readonly<Record<string, string>>;
  readonly reviewRepositoryPath: string;
  readonly decisionsRepositoryPath: string;
  /** Фазы, в которые исполнение решений может добавлять задачи. */
  readonly taskScope: TaskScopePromptInput;
}

/** Чем устранение finding одного вида ревью отличается от другого. */
export interface ReviewFindingPromptVariant {
  /** Ревью, из которого взят finding, в родительном падеже английской фразы. */
  readonly reviewName: string;
  /** Skill, который владеет самим устранением и повторным аудитом. */
  readonly skill: string;
  /** MCP-инструмент завершения стадии. */
  readonly toolName: string;
}

const RESOLUTION_RULES = [
  OPENSPEC_CLI_RULE,
  NO_GITHUB_RULE,
  FIXED_BRANCH_RULE,
  "Do not push. The orchestrator verifies and publishes every commit to the existing root Draft pull request.",
  STAGE_SCOPE_RULE,
] as const;

/**
 * Промпт сессии решений для обоих видов ревью.
 *
 * Агент сначала без пользователя перепроверяет все findings и готовит
 * варианты, затем один раз собирает явные решения. Файлы он не меняет:
 * решения записывает и коммитит оркестратор через MCP-инструмент.
 */
export function buildFindingDecisionPrompt(
  variant: ReviewFindingPromptVariant,
  input: FindingDecisionPromptInput,
): string {
  const blockerNote = Object.keys(input.blockers).length > 0
    ? " For findings listed in `blockers`, an earlier session could not carry out the previous decision: explain that blocker and get a new decision."
    : "";
  return buildAgentPrompt({
    role: `You collect the user's decisions on all open findings from ${variant.reviewName} in one sitting, so that later autonomous sessions can carry them out without the user.`,
    communication: "interactive",
    verification: { kind: "no-code" },
    workflowData: {
      changeId: input.changeId,
      branch: input.branch,
      reviewPath: input.reviewRepositoryPath,
      decisionsPath: input.decisionsRepositoryPath,
      findingIds: input.findingIds,
      blockers: input.blockers,
      ...taskScopeWorkflowData(input.taskScope),
    },
    rules: [
      ...RESOLUTION_RULES,
      "Change no file and create no commit: the orchestrator records the decisions in `decisionsPath`, commits, and publishes them. Never invoke Apply.",
    ],
    body: [
      `Prepare before involving the user. Read the review report, the change artifacts, and the \`${variant.skill}\` skill's guidance on findings, remediation, and residual-risk acceptance, but do not run its remediation or acceptance procedures: separate sessions run them later. For every finding in \`findingIds\`, recheck its evidence against the repository, then identify findings that share a root cause, would conflict, or change the same artifact. Do all of this without asking the user anything.${blockerNote}`,
      "Then present every finding to the user in Russian in one message, grouping related findings. Explain each one to someone who has never seen it: what is wrong, how it affects the product, and what you recommend. Where the resolution depends on a product, contract, architecture, data, security, privacy, or cost choice, give the real options and trade-offs; for an obvious technical correction, explain why product behavior stays the same.",
      `Get one explicit decision for every finding: remediate it in a stated way, or accept its residual risk. A recommendation is not a decision; the user may explicitly adopt your recommendations, also for several findings at once, but never infer a decision from silence. Residual-risk acceptance needs the user's explicit acceptance of that specific finding together with its rationale, scope and assumptions, and reopening conditions; you may propose them for the user to confirm. Settle conflicts between decisions with the user. Later remediation must respect this task rule, so do not agree to a remediation that breaks it: ${taskScopeRule(input.taskScope)}`,
      "An autonomous session that cannot ask the user carries out each decision later, so write every decision self-contained: the agreed outcome, the chosen option, its constraints, and the artifacts expected to change. Write each field in Russian as one line of at most 2000 characters.",
    ],
    completion: `When every finding in \`findingIds\` has an explicit decision, call the orchestrator MCP tool \`${variant.toolName}\` with \`{"decisions":[{"findingId":"F1","kind":"remediate","instruction":"<как устранить>"},{"findingId":"F2","kind":"accept-risk","rationale":"<обоснование>","scope":"<границы и допущения>","reopenWhen":"<когда пересмотреть>"}]}\`, covering exactly those findings. If it reports an error, fix only the decisions and retry the same tool. After it succeeds, tell the user that the decisions are recorded and stop: do not start resolving findings.`,
  });
}

/**
 * Промпт автономного исполнения одного решения для обоих видов ревью.
 *
 * Скилл владеет самим исправлением, повторным аудитом и валидацией отчёта.
 * Промпт добавляет только то, чего скилл не знает: записанное решение
 * пользователя, путь при препятствии и контракт завершения.
 */
export function buildFindingResolutionPrompt(
  variant: ReviewFindingPromptVariant,
  input: ReviewFindingPromptInput,
): string {
  // Во время implementation run список задач неизменен. При планировании
  // сохраняются только завершённые задачи: новые встают в порядке выполнения.
  const taskListRule = input.taskScope.kind === "implementation"
    ? "Preserve the existing task list exactly, including completion marks: never reopen a completed task or rewrite or delete an existing task. If more implementation is needed, append new unfinished tasks."
    : "Preserve every completed task exactly, including its completion mark: never reopen a completed task or rewrite or delete it. If more implementation is needed, add new unfinished tasks.";
  const finding = `\`${input.findingId}\``;
  const skillRequest = input.decision.kind === "remediate"
    ? `to address only finding ${finding} as the recorded decision states, passing that decision to the skill as the settled human decision`
    : `to accept only finding ${finding} as residual risk with the recorded rationale, scope and assumptions, and reopening conditions, citing the decision entry in \`decisionsPath\` at commit \`${input.baselineCommit}\` as the acceptance authority, because this resolution deletes that entry`;
  const body = (() => {
    switch (input.recovery.kind) {
      case "published":
        return [
          `This is a recovery session: finding ${finding} already has a valid committed resolution and a verified entry in the root pull request. Change nothing: do not invoke the skill, commit, or push.`,
        ];
      case "committed":
        return [
          `This is a recovery session: finding ${finding} is already absent from a valid committed resolution, but its root pull-request entry is missing. Do not invoke the skill and do not create or amend a commit; let the orchestrator publish the existing commit if needed and derive the Russian summaries from the finding, the decision, and the committed diff.`,
        ];
      case "none":
        return [
          `The user already decided this finding in an earlier decision session: \`decision\` in the workflow data is that explicit decision, and the entry under the heading \`${input.findingHeading}\` in \`decisionsPath\` is its durable record. It is also the user's confirmation of every planning write that carries it out. Do not ask the user for a decision or an approval.`,
          `First check that the decision can be carried out as agreed. If it cannot, it would need a materially different decision, or the skill needs a choice the decision does not settle, do not improvise: report the blocker through the completion tool, and the orchestrator returns the finding to the user. The blocker is recorded only on an unchanged branch, so do not commit anything for a blocked finding; if you find the blocker after editing files, first discard your own uncommitted edits with \`git restore\` and delete the files you created.`,
          `Otherwise invoke the \`${variant.skill}\` skill for change \`${input.changeId}\` ${skillRequest}. Do not inspect the agent command catalog first. Let the skill resolve only this finding and keep later findings intact unless current evidence changes them. Never accept residual risk for a finding the user decided to remediate; if current evidence disproves the finding, let the skill remove it as inapplicable. ${taskListRule} ${taskScopeRule(input.taskScope)} The resolution holds only when the agreed outcome is durably owned by the OpenSpec artifacts, any remaining implementation is tracked work, and the finding heading is gone from Findings.`,
          `In the same change, delete this finding's whole section, from its \`## \` heading up to the next one, from \`decisionsPath\`. If the resolution also removed other findings from Findings, delete their sections too; change nothing else in that file. Validate the changed OpenSpec artifacts, related documentation, and report state. Then commit only the changed artifacts of the selected change, the decisions file, and the related repository documentation in at least one commit without asking for approval.`,
        ];
    }
  })();
  const completion = (() => {
    switch (input.recovery.kind) {
      case "published":
        return `Finish by calling the orchestrator MCP tool \`${variant.toolName}\` with \`{"mode":"acknowledge-existing"}\`. If it reports an error, follow its feedback and retry the same tool.`;
      case "committed":
        return `Call the orchestrator MCP tool \`${variant.toolName}\` with \`{"mode":"publish","problem":"<краткая проблема>","resolution":"<краткий итог>"}\`. Both summaries are truthful single-line Russian text of at most 500 characters. If it reports an error, follow its feedback and retry the same tool.`;
      case "none":
        return `Once the resolution is committed, call the orchestrator MCP tool \`${variant.toolName}\` with \`{"mode":"publish","problem":"<краткая проблема>","resolution":"<краткий итог>"}\`; the orchestrator publishes the verified commits to the root branch and records the result in its pull request. For an accepted risk, describe the acceptance and its rationale in \`resolution\`. If the decision cannot be carried out, call it instead with \`{"mode":"blocked","reason":"<препятствие и что нужно решить>"}\` without committing anything. Every summary and reason is truthful single-line Russian text of at most 500 characters. If the tool reports an error, follow its feedback and retry the same tool.`;
    }
  })();

  return buildAgentPrompt({
    role: `You carry out the user's recorded decision on one finding from ${variant.reviewName}.`,
    communication: "blocker-only",
    verification: { kind: "no-code" },
    workflowData: {
      changeId: input.changeId,
      findingId: input.findingId,
      findingHeading: input.findingHeading,
      decision: input.decision,
      decisionCommit: input.baselineCommit,
      branch: input.branch,
      remote: "origin",
      reviewPath: input.reviewRepositoryPath,
      decisionsPath: input.decisionsRepositoryPath,
      recovery: input.recovery.kind,
      ...taskScopeWorkflowData(input.taskScope),
    },
    rules: [
      ...RESOLUTION_RULES,
      "Change only planning artifacts inside the selected change root and related repository documentation outside the selected change root (ADRs, README files, domain documents, and guides), only as needed for the recorded decision on this finding. All changed files must stay inside the Git root; never edit implementation code, tests, or configuration and never invoke Apply.",
      "Record requirement changes in the selected change's delta specs; never edit `openspec/specs` directly. The orchestrator synchronizes the main specs when archiving the change.",
    ],
    body,
    completion,
  });
}

export interface ReviewFindingResolutionBehavior<
  Session extends ReviewFindingResolutionSession,
> {
  readonly sessionSchema: z.ZodType<Session>;
  readonly report: {
    readonly fileName: string;
    readonly missingMeansNoFindings: boolean;
    readonly read: (
      location: ReviewFindingReportLocation,
      signal?: AbortSignal,
    ) => Promise<ActiveReviewFindingReport>;
  };
  readonly agent: {
    readonly toolName: string;
    readonly toolDescription: string;
    readonly title: (findingId: ReviewFindingId) => string;
    readonly logLabel: string;
    readonly completionLabel: string;
    readonly prompt: (input: ReviewFindingPromptInput) => string;
  };
  readonly decisions: {
    readonly toolName: string;
    readonly toolDescription: string;
    readonly title: string;
    readonly logLabel: string;
    /** Сообщение коммита с решениями пользователя. */
    readonly commitSubject: string;
    /** Сообщение коммита, который возвращает finding к решению пользователя. */
    readonly blockedCommitSubject: (findingId: ReviewFindingId) => string;
    readonly prompt: (input: FindingDecisionPromptInput) => string;
  };
  readonly publication: {
    readonly kind: ReviewFindingPublicationKind;
  };
}

export class ReviewFindingResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewFindingResolutionError";
  }
}

export function parseFindingResolutionBranch(branch: string): string {
  const parsed = findingResolutionBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ReviewFindingResolutionError(
      "Для устранения finding требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}
