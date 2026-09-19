import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  assertPlanningBranchFor,
  changeBranchFor,
  changeBranchSchema,
  phasePlanningBranchFor,
  planningBranchSchema,
} from "./change-branch.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { phaseProgressSchema } from "./phase-work.ts";

export const planningRunSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    planningBranch: planningBranchSchema,
    phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    rootBaselineCommit: commitHashSchema,
    baselineProgress: phaseProgressSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.changeBranch !== changeBranchFor(run.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая ветка planning-run не соответствует change",
      });
    }
    try {
      assertPlanningBranchFor(run.planningBranch, run.changeId);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["planningBranch"],
        message: "Planning-ветка planning-run не соответствует change",
      });
    }
    if (run.planningBranch !== phasePlanningBranchFor(run.changeId, run.phaseNumber)) {
      context.addIssue({
        code: "custom",
        path: ["planningBranch"],
        message: "Planning-ветка не соответствует целевой фазе",
      });
    }
    const taskPhases = run.baselineProgress.tasks.map(({ number }) =>
      Number(number.split(".")[0]),
    );
    if (
      !run.baselineProgress.phases.some(({ number }) => number === run.phaseNumber) ||
      run.baselineProgress.tasks.some(({ done }) => !done) ||
      taskPhases.some((number) => number >= run.phaseNumber) ||
      Array.from({ length: run.phaseNumber - 1 }, (_, index) => index + 1)
        .some((number) => !taskPhases.includes(number))
    ) {
      context.addIssue({
        code: "custom",
        path: ["baselineProgress"],
        message: "Baseline planning-run не соответствует первой фазе без задач",
      });
    }
  });

export type PlanningRun = z.infer<typeof planningRunSchema>;
