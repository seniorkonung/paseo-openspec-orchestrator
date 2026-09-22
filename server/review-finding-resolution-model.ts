import type { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
  buildAgentPrompt,
} from "./agent-prompt.ts";
import {
  type CompletedFindingPullRequest,
  type ReviewFindingOutcome,
  type ReviewFindingPublicationKind,
} from "./review-finding-publication.ts";
import {
  type ReviewFindingId,
} from "./change-review-report.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";

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

export type ReviewFindingResolutionPlan<Session extends ReviewFindingResolutionSession> =
  | {
      readonly kind: "no-findings";
      readonly reviewPath: string;
      readonly headCommit: string;
    }
  | {
      readonly kind: "finding-required";
      readonly findingId: ReviewFindingId;
      readonly session: Session;
    };

export interface CompletedReviewFindingResolution {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
  readonly outcome: ReviewFindingOutcome;
  readonly pullRequest: CompletedFindingPullRequest;
}

export interface VerifiedReviewFindingResolution {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
  readonly outcome: ReviewFindingOutcome;
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
  readonly findings: readonly { readonly id: ReviewFindingId }[];
  readonly acceptedRisks: readonly {
    readonly originatingFindingId: string;
  }[];
}

export interface ReviewFindingPromptInput {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly branch: string;
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
  readonly publicationAlreadyCompleted: boolean;
}

/** Чем устранение finding одного вида ревью отличается от другого. */
export interface ReviewFindingPromptVariant {
  /** Ревью, из которого взят finding, в родительном падеже английской фразы. */
  readonly reviewName: string;
  /** Skill, который владеет самим устранением и повторным аудитом. */
  readonly skill: string;
  /** MCP-инструмент завершения стадии. */
  readonly toolName: string;
  readonly commitSubject: (findingId: ReviewFindingId) => string;
}

/**
 * Один промпт для обоих видов устранения finding.
 *
 * Скилл владеет самим исправлением, повторным аудитом и валидацией отчёта.
 * Промпт добавляет только то, чего скилл не знает: выбранный finding, одно
 * явное решение пользователя, ровно один commit и контракт завершения.
 */
export function buildFindingResolutionPrompt(
  variant: ReviewFindingPromptVariant,
  input: ReviewFindingPromptInput,
): string {
  const subject = variant.commitSubject(input.findingId);
  const resolved = input.alreadyCommitted || input.publicationAlreadyCompleted;
  const resolutionInstruction = input.publicationAlreadyCompleted
    ? `This is a recovery session: finding \`${input.findingId}\` already has a valid committed resolution and a verified entry in the review pull request. Change nothing: do not invoke the skill, request the user's decision, commit, or push.`
    : input.alreadyCommitted
      ? `This is a recovery session: finding \`${input.findingId}\` is already absent from a valid committed resolution, but its review pull-request entry is missing. Do not invoke the skill, do not request the user's decision again, and do not create or amend a commit; publish the existing commit if needed and derive the Russian summaries from the finding and the committed diff.`
      : `Invoke the \`${variant.skill}\` skill for change \`${input.changeId}\` to analyze only finding \`${input.findingId}\`. Follow the interaction contract before changing artifacts or accepting risk. Do not inspect the agent command catalog first.`;
  const interactionContract = resolved
    ? ""
    : `When nothing is committed yet, follow this contract:

1. Explain the finding in Russian to someone who has never seen it: what is wrong, how it affects the product, and what you recommend. Where the resolution depends on a product, contract, architecture, data, security, privacy, or cost choice, give the real options and trade-offs; for an obvious technical correction, explain why product behavior stays the same.
2. Get one explicit decision from the user about how to resolve this finding before changing any artifact or accepting residual risk. A recommendation is not a decision, and acceptance is never inferred: on acceptance let the skill record it through its own procedure instead of claiming a fix.
3. Let the skill implement that decision for only this finding and keep later findings intact unless current evidence changes them. If the chosen resolution cannot be implemented or requires a materially different decision, explain the blocker instead of silently changing course. Preserve the existing task list exactly, including completion marks: never reopen a completed task or rewrite or delete an existing task. If more implementation is needed, append new unfinished tasks. The resolution holds only when the agreed outcome is durably owned by the OpenSpec artifacts, any remaining implementation is tracked work, and the finding heading is gone from Findings.
4. Validate the resulting artifact changes and report state. Then stage only files inside the change root and create exactly one commit with subject \`${subject}\` without asking for another approval; never amend or add a second commit. Report the changes and validation to the user while continuing through publication and completion without pausing for permission.`;
  const completion = input.publicationAlreadyCompleted
    ? `Finish by calling the orchestrator MCP tool \`${variant.toolName}\` with \`{"mode":"acknowledge-existing"}\`. If it reports an error, follow its feedback and retry the same tool.`
    : `Publish the branch with \`git push --set-upstream origin ${input.branch}\`, then call the orchestrator MCP tool \`${variant.toolName}\` with \`{"mode":"publish","problem":"<краткая проблема>","resolution":"<краткий итог>"}\` without asking for additional permission. Both summaries are truthful single-line Russian text of at most 500 characters; for an accepted risk describe the acceptance and its rationale in \`resolution\`. If it reports an error, follow its feedback and retry the same tool.`;

  return buildAgentPrompt({
    role: `You own the resolution of one finding from ${variant.reviewName}.`,
    communication: "interactive",
    workflowData: {
      changeId: input.changeId,
      findingId: input.findingId,
      branch: input.branch,
      remote: "origin",
      reviewPath: input.reviewRepositoryPath,
      commitSubject: subject,
      alreadyCommitted: input.alreadyCommitted,
      publicationAlreadyCompleted: input.publicationAlreadyCompleted,
    },
    rules: [
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
      "Change only planning artifacts inside the selected change root: never edit implementation code or tests and never invoke Apply.",
    ],
    body: [resolutionInstruction, interactionContract],
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
  readonly publication: {
    readonly kind: ReviewFindingPublicationKind;
    readonly commitSubject: (findingId: ReviewFindingId) => string;
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
