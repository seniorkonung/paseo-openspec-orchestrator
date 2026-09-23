import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const CHANGE_BRANCH_PATTERN = /^change\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const CHANGE_BRANCH_MESSAGE = "Git-ветка должна иметь формат change/<change-id>";

export type ChangeBranch = `change/${string}`;
export type PlanningBranch = ChangeBranch;
export type ImplementationBranch = ChangeBranch;

// Эти схемы входят в MCP outputSchema: transform здесь запрещён.
export const changeBranchSchema = z.string().min(1).max(512)
  .regex(CHANGE_BRANCH_PATTERN, { message: CHANGE_BRANCH_MESSAGE, abort: true })
  .refine(isChangeBranch, { message: CHANGE_BRANCH_MESSAGE });
export const planningBranchSchema = changeBranchSchema;
export const implementationBranchSchema = changeBranchSchema;

function isChangeBranch(branch: string): branch is ChangeBranch {
  const changeId = CHANGE_BRANCH_PATTERN.exec(branch)?.[1];
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  return parsed.success && parsed.data === changeId;
}

export class ChangeBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeBranchError";
  }
}

export function parseChangeBranch(branch: string): ChangeBranch {
  const parsed = changeBranchSchema.safeParse(branch);
  if (!parsed.success) throw new ChangeBranchError(CHANGE_BRANCH_MESSAGE);
  return parsed.data;
}

export function changeIdFromBranch(branch: string): string {
  return openSpecChangeIdSchema.parse(parseChangeBranch(branch).slice("change/".length));
}

export function changeBranchFor(changeId: string): ChangeBranch {
  return changeBranchSchema.parse(`change/${openSpecChangeIdSchema.parse(changeId)}`);
}

export const planningBranchFor = changeBranchFor;
export const initialPlanningBranchFor = changeBranchFor;
export function phasePlanningBranchFor(changeId: string, phaseNumber: number): PlanningBranch {
  positiveIndex(phaseNumber);
  return changeBranchFor(changeId);
}

export const implementationBranchFor = changeBranchFor;
export function implementationBranchForRun(
  changeId: string,
  phaseNumber: number,
  runNumber: number,
): ImplementationBranch {
  positiveIndex(phaseNumber);
  positiveIndex(runNumber);
  return changeBranchFor(changeId);
}

function positiveIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChangeBranchError("Номер фазы или запуска должен быть положительным целым");
  }
  return value;
}

export function assertImplementationBranchFor(branch: string, changeId: string): ImplementationBranch {
  const expected = changeBranchFor(changeId);
  if (branch !== expected) throw new ChangeBranchError(`Git-ветка не соответствует change «${changeId}»`);
  return expected;
}

export function assertPlanningBranchFor(branch: string, changeId: string): PlanningBranch {
  const expected = changeBranchFor(changeId);
  if (branch !== expected) throw new ChangeBranchError(`Git-ветка не соответствует change «${changeId}»`);
  return expected;
}
