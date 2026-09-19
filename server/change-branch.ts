import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const MAX_BRANCH_LENGTH = 512;
const CHANGE_BRANCH_PATTERN = /^change\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const PLANNING_BRANCH_PATTERN =
  /^planning\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(initial|phase-([1-9][0-9]*))$/u;
const IMPLEMENTATION_BRANCH_PATTERN =
  /^implementation\/([a-z0-9]+(?:-[a-z0-9]+)*)\/phase-([1-9][0-9]*)\/run-([1-9][0-9]*)$/u;

const CHANGE_BRANCH_MESSAGE =
  "Корневая Git-ветка должна иметь формат change/<change-id>";
const PLANNING_BRANCH_MESSAGE =
  "Planning-ветка должна иметь формат planning/<change-id>/initial или planning/<change-id>/phase-N";
const IMPLEMENTATION_BRANCH_MESSAGE =
  "Implementation-ветка должна иметь формат implementation/<change-id>/phase-N/run-M";

export type ChangeBranch = `change/${string}`;
export type PlanningBranch =
  | `planning/${string}/initial`
  | `planning/${string}/phase-${number}`;
export type ImplementationBranch = `implementation/${string}/phase-${number}/run-${number}`;

// Эти схемы входят в MCP outputSchema: transform здесь запрещён, потому что
// tools/list должен преобразовать их в JSON Schema.
export const changeBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(CHANGE_BRANCH_PATTERN, { message: CHANGE_BRANCH_MESSAGE, abort: true })
  .refine(isChangeBranch, { message: CHANGE_BRANCH_MESSAGE });

export const planningBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(PLANNING_BRANCH_PATTERN, {
    message: PLANNING_BRANCH_MESSAGE,
    abort: true,
  })
  .refine(isPlanningBranch, { message: PLANNING_BRANCH_MESSAGE });

export const implementationBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(IMPLEMENTATION_BRANCH_PATTERN, {
    message: IMPLEMENTATION_BRANCH_MESSAGE,
    abort: true,
  })
  .refine(isImplementationBranch, { message: IMPLEMENTATION_BRANCH_MESSAGE });

function isChangeBranch(branch: string): branch is ChangeBranch {
  const changeId = CHANGE_BRANCH_PATTERN.exec(branch)?.[1];
  return isCanonicalChangeId(changeId);
}

function isPlanningBranch(branch: string): branch is PlanningBranch {
  const match = PLANNING_BRANCH_PATTERN.exec(branch);
  const phaseNumber = match?.[3] === undefined ? null : Number(match[3]);
  return (
    isCanonicalChangeId(match?.[1]) &&
    (phaseNumber === null || Number.isSafeInteger(phaseNumber))
  );
}

function isImplementationBranch(branch: string): branch is ImplementationBranch {
  const match = IMPLEMENTATION_BRANCH_PATTERN.exec(branch);
  return (
    isCanonicalChangeId(match?.[1]) &&
    Number.isSafeInteger(Number(match?.[2])) &&
    Number.isSafeInteger(Number(match?.[3]))
  );
}

function isCanonicalChangeId(changeId: string | undefined): boolean {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  return parsed.success && changeId === parsed.data;
}

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
  return initialPlanningBranchFor(changeId);
}

export function initialPlanningBranchFor(changeId: string): PlanningBranch {
  return planningBranchSchema.parse(
    `planning/${openSpecChangeIdSchema.parse(changeId)}/initial`,
  );
}

export function phasePlanningBranchFor(
  changeId: string,
  phaseNumber: number,
): PlanningBranch {
  return planningBranchSchema.parse(
    `planning/${openSpecChangeIdSchema.parse(changeId)}/phase-${positiveIndex(phaseNumber)}`,
  );
}

export function implementationBranchFor(changeId: string): ImplementationBranch {
  return implementationBranchForRun(changeId, 1, 1);
}

export function implementationBranchForRun(
  changeId: string,
  phaseNumber: number,
  runNumber: number,
): ImplementationBranch {
  return implementationBranchSchema.parse(
    `implementation/${openSpecChangeIdSchema.parse(changeId)}/phase-${positiveIndex(phaseNumber)}/run-${positiveIndex(runNumber)}`,
  );
}

export type ParsedPlanningBranch =
  | { readonly kind: "initial"; readonly changeId: string }
  | { readonly kind: "phase"; readonly changeId: string; readonly phaseNumber: number };

export type ParsedImplementationBranch = {
  readonly kind: "phase";
  readonly changeId: string;
  readonly phaseNumber: number;
  readonly runNumber: number;
};

export function parsePlanningBranch(branch: string): ParsedPlanningBranch {
  const parsed = planningBranchSchema.parse(branch);
  const match = PLANNING_BRANCH_PATTERN.exec(parsed);
  if (!match?.[1]) throw new ChangeBranchError("Некорректная planning-ветка");
  if (match[2] === "initial") return { kind: "initial", changeId: match[1] };
  return { kind: "phase", changeId: match[1], phaseNumber: Number(match[3]) };
}

export function parseImplementationBranch(branch: string): ParsedImplementationBranch {
  const parsed = implementationBranchSchema.parse(branch);
  const match = IMPLEMENTATION_BRANCH_PATTERN.exec(parsed);
  if (!match?.[1]) throw new ChangeBranchError("Некорректная implementation-ветка");
  if (!match[2] || !match[3]) throw new ChangeBranchError("Некорректная implementation-ветка");
  return {
    kind: "phase",
    changeId: match[1],
    phaseNumber: Number(match[2]),
    runNumber: Number(match[3]),
  };
}

function positiveIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChangeBranchError("Номер фазы или запуска должен быть положительным целым");
  }
  return value;
}

export function assertImplementationBranchFor(
  branch: string,
  changeId: string,
): ImplementationBranch {
  const parsed = implementationBranchSchema.safeParse(branch);
  const normalizedChangeId = openSpecChangeIdSchema.parse(changeId);
  if (
    !parsed.success ||
    parseImplementationBranch(parsed.data).changeId !== normalizedChangeId
  ) {
    throw new ChangeBranchError(
      `Implementation-ветка не соответствует change «${normalizedChangeId}»`,
    );
  }
  return parsed.data;
}

export function assertPlanningBranchFor(
  branch: string,
  changeId: string,
): PlanningBranch {
  const parsed = planningBranchSchema.safeParse(branch);
  const normalizedChangeId = openSpecChangeIdSchema.parse(changeId);
  if (!parsed.success || parsePlanningBranch(parsed.data).changeId !== normalizedChangeId) {
    throw new ChangeBranchError(
      `Planning-ветка не соответствует change «${normalizedChangeId}»`,
    );
  }
  return parsed.data;
}
