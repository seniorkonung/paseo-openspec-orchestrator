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
    const taskPhases = new Set(run.baselineProgress.tasks.map(({ number }) =>
      Number(number.split(".")[0]),
    ));
    const phaseIndex = run.baselineProgress.phases.findIndex(
      ({ number }) => number === run.phaseNumber,
    );
    const earlierPhases = run.baselineProgress.phases.slice(0, phaseIndex);
    const targetAndLaterPhases = new Set(
      run.baselineProgress.phases.slice(phaseIndex).map(({ number }) => number),
    );
    if (
      phaseIndex < 0 ||
      run.baselineProgress.tasks.some(({ done }) => !done) ||
      earlierPhases.some(({ number }) => !taskPhases.has(number)) ||
      [...taskPhases].some((number) => targetAndLaterPhases.has(number))
    ) {
      context.addIssue({
        code: "custom",
        path: ["baselineProgress"],
        message: "Baseline planning-run не соответствует первой фазе без задач",
      });
    }
  });

export type PlanningRun = z.infer<typeof planningRunSchema>;
