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
    const match = /^planning\/([^/]+)\/(initial|phase-([1-9][0-9]*))$/u.exec(branch);
    const changeId = match?.[1];
    const parsedChangeId = openSpecChangeIdSchema.safeParse(changeId);
    const phaseNumber = match?.[3] === undefined ? null : Number(match[3]);
    if (
      !parsedChangeId.success ||
      changeId !== parsedChangeId.data ||
      (phaseNumber !== null && !Number.isSafeInteger(phaseNumber))
    ) {
      context.addIssue({
        code: "custom",
        message: "Planning-ветка должна иметь формат planning/<change-id>/initial или planning/<change-id>/phase-N",
      });
      return z.NEVER;
    }
    return branch as PlanningBranch;
  });

export const implementationBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .transform((branch, context) => {
    const match = /^implementation\/([^/]+)\/phase-([1-9][0-9]*)\/run-([1-9][0-9]*)$/u.exec(branch);
    const changeId = match?.[1];
    const parsedChangeId = openSpecChangeIdSchema.safeParse(changeId);
    const phaseNumber = Number(match?.[2]);
    const runNumber = Number(match?.[3]);
    if (
      !parsedChangeId.success ||
      changeId !== parsedChangeId.data ||
      !Number.isSafeInteger(phaseNumber) ||
      !Number.isSafeInteger(runNumber)
    ) {
      context.addIssue({
        code: "custom",
        message: "Implementation-ветка должна иметь формат implementation/<change-id>/phase-N/run-M",
      });
      return z.NEVER;
    }
    return branch as ImplementationBranch;
  });

export type ChangeBranch = z.output<typeof changeBranchSchema>;
export type PlanningBranch =
  | `planning/${string}/initial`
  | `planning/${string}/phase-${number}`;
export type ImplementationBranch = `implementation/${string}/phase-${number}/run-${number}`;

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
  const match = /^planning\/([^/]+)\/(initial|phase-([1-9][0-9]*))$/u.exec(parsed);
  if (!match?.[1]) throw new ChangeBranchError("Некорректная planning-ветка");
  if (match[2] === "initial") return { kind: "initial", changeId: match[1] };
  return { kind: "phase", changeId: match[1], phaseNumber: Number(match[3]) };
}

export function parseImplementationBranch(branch: string): ParsedImplementationBranch {
  const parsed = implementationBranchSchema.parse(branch);
  const match = /^implementation\/([^/]+)\/phase-([1-9][0-9]*)\/run-([1-9][0-9]*)$/u.exec(parsed);
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
