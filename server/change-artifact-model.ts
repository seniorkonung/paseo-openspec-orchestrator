import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PATH_LENGTH = 8_192;
const FALLBACK_COMMIT_SUBJECT = "docs(openspec): add planning artifact";

export const openSpecArtifactIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Artifact ID содержит недопустимые символы",
  );

export const schemaNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Schema name содержит недопустимые символы",
  );

export const artifactPathValueSchema = z.string().trim().min(1).max(MAX_PATH_LENGTH);
export const commitHashSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export interface PendingArtifactSession {
  readonly artifactId: string;
  readonly schemaName: string;
  readonly baselineCommit: string;
}

export const pendingArtifactSessionSchema = z
  .object({
    artifactId: openSpecArtifactIdSchema,
    schemaName: schemaNameSchema,
    baselineCommit: commitHashSchema,
  })
  .strict();

export type ChangeArtifactPlan =
  | {
      readonly kind: "complete";
      readonly schemaName: string;
    }
  | {
      readonly kind: "next-artifact";
      readonly schemaName: string;
      readonly artifactId: string;
    };

export type ChangeArtifactDecision =
  | ChangeArtifactPlan
  | {
      readonly kind: "inconsistent";
      readonly message: string;
    };

export class ChangeArtifactCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeArtifactCreationError";
  }
}

export function parseChangeId(changeId: string): string {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  if (!parsed.success) {
    throw new ChangeArtifactCreationError("Change ID должен быть в kebab-case");
  }
  return parsed.data;
}

export function artifactCommitSubject(artifactId: string): string {
  const detailed = `docs(openspec): add ${artifactId} artifact`;
  return detailed.length <= 71 ? detailed : FALLBACK_COMMIT_SUBJECT;
}
