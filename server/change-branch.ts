import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const MAX_BRANCH_LENGTH = 512;

export const changeBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .transform((branch, context) => {
    const match = /^change\/([^/]+)$/u.exec(branch);
    const changeId = match?.[1];
    const parsedChangeId = openSpecChangeIdSchema.safeParse(changeId);
    if (!parsedChangeId.success || changeId !== parsedChangeId.data) {
      context.addIssue({
        code: "custom",
        message: "Корневая Git-ветка должна иметь формат change/<change-id>",
      });
      return z.NEVER;
    }
    return `change/${parsedChangeId.data}` as const;
  });

export const planningBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .transform((branch, context) => {
    const match = /^planning\/([^/]+)$/u.exec(branch);
    const changeId = match?.[1];
    const parsedChangeId = openSpecChangeIdSchema.safeParse(changeId);
    if (!parsedChangeId.success || changeId !== parsedChangeId.data) {
      context.addIssue({
        code: "custom",
        message: "Planning-ветка должна иметь формат planning/<change-id>",
      });
      return z.NEVER;
    }
    return `planning/${parsedChangeId.data}` as const;
  });

export type ChangeBranch = z.output<typeof changeBranchSchema>;
export type PlanningBranch = z.output<typeof planningBranchSchema>;

export class ChangeBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeBranchError";
  }
}

export function parseChangeBranch(branch: string): ChangeBranch {
  const parsed = changeBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ChangeBranchError(
      "Корневая Git-ветка должна иметь формат change/<change-id>",
    );
  }
  return parsed.data;
}

export function changeIdFromBranch(branch: string): string {
  return openSpecChangeIdSchema.parse(parseChangeBranch(branch).slice("change/".length));
}

export function changeBranchFor(changeId: string): ChangeBranch {
  return changeBranchSchema.parse(`change/${openSpecChangeIdSchema.parse(changeId)}`);
}

export function planningBranchFor(changeId: string): PlanningBranch {
  return planningBranchSchema.parse(`planning/${openSpecChangeIdSchema.parse(changeId)}`);
}

export function assertPlanningBranchFor(
  branch: string,
  changeId: string,
): PlanningBranch {
  const parsed = planningBranchSchema.safeParse(branch);
  const expected = planningBranchFor(changeId);
  if (!parsed.success || parsed.data !== expected) {
    throw new ChangeBranchError(
      `Для change «${openSpecChangeIdSchema.parse(changeId)}» требуется planning-ветка «${expected}»`,
    );
  }
  return parsed.data;
}
