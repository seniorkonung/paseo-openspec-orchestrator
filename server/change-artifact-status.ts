import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  ChangeArtifactCreationError,
  artifactPathValueSchema,
  openSpecArtifactIdSchema,
  parseChangeId,
  schemaNameSchema,
  type ChangeArtifactDecision,
  type ChangeArtifactPlan,
} from "./change-artifact-model.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { resolveRepoLocalChangePaths } from "./repo-local-change.ts";

const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_OUTPUTS = 512;

const artifactPathSchema = z
  .object({
    outputPath: artifactPathValueSchema,
    resolvedOutputPath: artifactPathValueSchema,
    existingOutputPaths: z.array(artifactPathValueSchema).max(MAX_ARTIFACT_OUTPUTS),
  })
  .strict();

export const artifactStatusSchema = z
  .object({
    id: openSpecArtifactIdSchema,
    outputPath: artifactPathValueSchema,
    status: z.enum(["done", "skipped", "ready", "blocked"]),
    requires: z.array(openSpecArtifactIdSchema).max(MAX_ARTIFACTS),
    missingDeps: z.array(openSpecArtifactIdSchema).max(MAX_ARTIFACTS).optional(),
  })
  .strict();

const openSpecStatusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    schemaName: schemaNameSchema,
    changeRoot: artifactPathValueSchema,
    artifactPaths: z.record(openSpecArtifactIdSchema, artifactPathSchema),
    isPlanningComplete: z.boolean(),
    isComplete: z.boolean(),
    applyRequires: z.array(openSpecArtifactIdSchema).max(MAX_ARTIFACTS),
    artifacts: z.array(artifactStatusSchema).min(1).max(MAX_ARTIFACTS),
    actionContext: z
      .object({
        mode: z.literal("repo-local"),
        sourceOfTruth: z.literal("repo"),
      })
      .loose(),
  })
  .loose();

const applyInstructionsSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    schemaName: schemaNameSchema,
    state: z.enum(["blocked", "ready", "all_done"]),
    missingArtifacts: z.array(openSpecArtifactIdSchema).max(MAX_ARTIFACTS).optional(),
    missingPrerequisites: z.array(openSpecArtifactIdSchema).max(MAX_ARTIFACTS).optional(),
  })
  .loose();

interface InspectedArtifactPath {
  readonly existingOutputPaths: readonly string[];
}

export interface InspectedOpenSpecStatus {
  readonly changeName: string;
  readonly schemaName: string;
  readonly gitRoot: string;
  readonly changeRoot: string;
  readonly isPlanningComplete: boolean;
  readonly applyRequires: readonly string[];
  readonly artifacts: ReadonlyMap<string, z.output<typeof artifactStatusSchema>>;
  readonly artifactOrder: readonly string[];
  readonly artifactPaths: ReadonlyMap<string, InspectedArtifactPath>;
}

export interface ChangeArtifactStatusGateway {
  read(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<InspectedOpenSpecStatus>;
  inspect(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<ChangeArtifactDecision>;
  verifyApply(
    workspaceDirectory: string,
    changeId: string,
    schemaName: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ChangeArtifactStatusGatewayOptions {
  readonly command: BoundedCommandRunner;
  readonly resolveRealPath?: typeof realpath;
}

export function createChangeArtifactStatusGateway(
  options: ChangeArtifactStatusGatewayOptions,
): ChangeArtifactStatusGateway {
  const { command } = options;
  const resolveRealPath = options.resolveRealPath ?? realpath;

  const read = async (
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<InspectedOpenSpecStatus> => {
    const normalizedChangeId = parseChangeId(changeId);
    let stdout: string;
    try {
      ({ stdout } = await runWorkspaceMiseCommand(
        command,
        workspaceDirectory,
        "openspec",
        ["status", "--change", normalizedChangeId, "--json"],
        signal,
      ));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChangeArtifactCreationError(
        `Не удалось прочитать состояние OpenSpec change «${normalizedChangeId}»`,
      );
    }

    let status: z.output<typeof openSpecStatusSchema>;
    try {
      status = openSpecStatusSchema.parse(JSON.parse(stdout) as unknown);
    } catch {
      throw new ChangeArtifactCreationError(
        `OpenSpec вернул некорректный статус change «${normalizedChangeId}»`,
      );
    }
    if (status.changeName !== normalizedChangeId) {
      throw new ChangeArtifactCreationError(
        `OpenSpec вернул другой change вместо «${normalizedChangeId}»`,
      );
    }
    validateStatusGraph(status, normalizedChangeId);

    let changeRoot: string;
    let gitRoot: string;
    try {
      ({ changeRoot, gitRoot } = await resolveRepoLocalChangePaths({
        command,
        workspaceDirectory,
        reportedChangeRoot: status.changeRoot,
        signal,
        resolveRealPath,
      }));
    } catch (error) {
      if (error instanceof ChangeArtifactCreationError || signal?.aborted) throw error;
      throw new ChangeArtifactCreationError(
        `Не удалось безопасно определить каталог change «${normalizedChangeId}»`,
      );
    }

    const artifactPaths = new Map<string, InspectedArtifactPath>();
    const outputPathOwner = new Map<string, string>();
    for (const artifact of status.artifacts) {
      const paths = status.artifactPaths[artifact.id];
      if (!paths || paths.outputPath !== artifact.outputPath) {
        throw new ChangeArtifactCreationError(
          `OpenSpec вернул несогласованные пути артефакта «${artifact.id}»`,
        );
      }
      assertLexicallyContainedPath(changeRoot, paths.resolvedOutputPath, artifact.id);
      const existingOutputPaths: string[] = [];
      for (const outputPath of paths.existingOutputPaths) {
        try {
          const candidate = isAbsolute(outputPath)
            ? outputPath
            : resolve(changeRoot, outputPath);
          const concretePath = await resolveRealPath(candidate);
          if (!(await stat(concretePath)).isFile()) {
            throw new Error("Путь артефакта не является файлом");
          }
          assertContainedPath(changeRoot, concretePath, `Артефакт «${artifact.id}»`);
          assertContainedPath(gitRoot, concretePath, `Артефакт «${artifact.id}»`);
          const previousOwner = outputPathOwner.get(concretePath);
          if (previousOwner) {
            throw new ChangeArtifactCreationError(
              `Артефакты «${previousOwner}» и «${artifact.id}» ссылаются на один файл`,
            );
          }
          outputPathOwner.set(concretePath, artifact.id);
          existingOutputPaths.push(concretePath);
        } catch (error) {
          if (error instanceof ChangeArtifactCreationError || signal?.aborted) throw error;
          throw new ChangeArtifactCreationError(
            `Не удалось проверить путь артефакта «${artifact.id}»`,
          );
        }
      }
      if (new Set(existingOutputPaths).size !== existingOutputPaths.length) {
        throw new ChangeArtifactCreationError(
          `OpenSpec вернул повторяющиеся пути артефакта «${artifact.id}»`,
        );
      }
      artifactPaths.set(
        artifact.id,
        Object.freeze({
          existingOutputPaths: Object.freeze(existingOutputPaths),
        }),
      );
    }

    return {
      changeName: normalizedChangeId,
      schemaName: status.schemaName,
      gitRoot,
      changeRoot,
      isPlanningComplete: status.isPlanningComplete,
      applyRequires: Object.freeze([...status.applyRequires]),
      artifacts: new Map(status.artifacts.map((artifact) => [artifact.id, artifact])),
      artifactOrder: Object.freeze(status.artifacts.map(({ id }) => id)),
      artifactPaths,
    };
  };

  return {
    read,

    async inspect(workspaceDirectory, changeId, signal) {
      try {
        return planArtifactStatus(await read(workspaceDirectory, changeId, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ChangeArtifactCreationError) {
          return { kind: "inconsistent", message: error.message };
        }
        throw error;
      }
    },

    async verifyApply(workspaceDirectory, changeId, schemaName, signal) {
      const normalizedChangeId = parseChangeId(changeId);
      let stdout: string;
      try {
        ({ stdout } = await runWorkspaceMiseCommand(
          command,
          workspaceDirectory,
          "openspec",
          ["instructions", "apply", "--change", normalizedChangeId, "--json"],
          signal,
        ));
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ChangeArtifactCreationError(
          `Не удалось проверить готовность change «${normalizedChangeId}» к apply`,
        );
      }

      let instructions: z.output<typeof applyInstructionsSchema>;
      try {
        instructions = applyInstructionsSchema.parse(JSON.parse(stdout) as unknown);
      } catch {
        throw new ChangeArtifactCreationError(
          `OpenSpec вернул некорректные инструкции apply для change «${normalizedChangeId}»`,
        );
      }
      if (
        instructions.changeName !== normalizedChangeId ||
        instructions.schemaName !== schemaName
      ) {
        throw new ChangeArtifactCreationError(
          "OpenSpec вернул инструкции apply для другого change или schema",
        );
      }
      if (instructions.state === "blocked") {
        const missing = [
          ...(instructions.missingPrerequisites ?? []),
          ...(instructions.missingArtifacts ?? []),
        ];
        const detail = [...new Set(missing)].join(", ");
        throw new ChangeArtifactCreationError(
          detail
            ? `Apply заблокирован недостающими артефактами: ${detail}`
            : "Apply остаётся заблокирован после создания всех planning-артефактов",
        );
      }
    },
  };
}

export function planArtifactStatus(
  status: InspectedOpenSpecStatus,
): ChangeArtifactPlan {
  if (status.isPlanningComplete) {
    return { kind: "complete", schemaName: status.schemaName };
  }
  const next = firstReadyArtifact(status);
  if (!next) {
    throw new ChangeArtifactCreationError(
      `Change «${status.changeName}» не завершён, но OpenSpec не предлагает доступный артефакт`,
    );
  }
  return {
    kind: "next-artifact",
    schemaName: status.schemaName,
    artifactId: next.id,
  };
}

function validateStatusGraph(
  status: z.output<typeof openSpecStatusSchema>,
  changeId: string,
): void {
  if (status.isPlanningComplete !== status.isComplete) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул противоречивую готовность change «${changeId}»`,
    );
  }
  const ids = status.artifacts.map(({ id }) => id);
  const known = new Set(ids);
  const position = new Map(ids.map((id, index) => [id, index]));
  const artifactById = new Map(status.artifacts.map((artifact) => [artifact.id, artifact]));
  if (known.size !== ids.length) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул повторяющиеся артефакты change «${changeId}»`,
    );
  }
  if (
    Object.keys(status.artifactPaths).length !== ids.length ||
    Object.keys(status.artifactPaths).some((id) => !known.has(id))
  ) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул неполную карту путей change «${changeId}»`,
    );
  }
  const outputPathCount = Object.values(status.artifactPaths).reduce(
    (count, paths) => count + paths.existingOutputPaths.length,
    0,
  );
  if (outputPathCount > MAX_ARTIFACT_OUTPUTS) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул слишком много файлов артефактов change «${changeId}»`,
    );
  }
  for (const artifact of status.artifacts) {
    if (new Set(artifact.requires).size !== artifact.requires.length) {
      throw new ChangeArtifactCreationError(
        `Артефакт «${artifact.id}» содержит повторяющиеся зависимости`,
      );
    }
    if (artifact.requires.some((id) => !known.has(id) || id === artifact.id)) {
      throw new ChangeArtifactCreationError(
        `Артефакт «${artifact.id}» содержит неизвестную зависимость`,
      );
    }
    if (
      artifact.requires.some(
        (id) => (position.get(id) ?? Number.POSITIVE_INFINITY) >= (position.get(artifact.id) ?? -1),
      )
    ) {
      throw new ChangeArtifactCreationError(
        `Артефакты change «${changeId}» расположены не в порядке зависимостей`,
      );
    }
    const missingDependencies = artifact.requires.filter((id) => {
      const dependencyStatus = artifactById.get(id)?.status;
      return dependencyStatus !== "done" && dependencyStatus !== "skipped";
    });
    if (artifact.status === "blocked") {
      if (
        missingDependencies.length === 0 ||
        !sameItems(artifact.missingDeps ?? [], missingDependencies)
      ) {
        throw new ChangeArtifactCreationError(
          `Артефакт «${artifact.id}» содержит несогласованные missingDeps`,
        );
      }
    } else if (artifact.missingDeps !== undefined || missingDependencies.length > 0) {
      throw new ChangeArtifactCreationError(
        `Статус артефакта «${artifact.id}» не соответствует его зависимостям`,
      );
    }
  }
  if (
    new Set(status.applyRequires).size !== status.applyRequires.length ||
    status.applyRequires.some((id) => !known.has(id))
  ) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул неизвестное требование apply для change «${changeId}»`,
    );
  }
  const allSatisfied = status.artifacts.every(({ status: artifactStatus }) =>
    artifactStatus === "done" || artifactStatus === "skipped",
  );
  if (allSatisfied !== status.isPlanningComplete) {
    throw new ChangeArtifactCreationError(
      `OpenSpec вернул несогласованные статусы артефактов change «${changeId}»`,
    );
  }
}

function firstReadyArtifact(
  status: InspectedOpenSpecStatus,
): z.output<typeof artifactStatusSchema> | null {
  for (const artifactId of status.artifactOrder) {
    const artifact = status.artifacts.get(artifactId);
    if (artifact?.status === "ready") return artifact;
  }
  return null;
}

function sameItems(first: readonly string[], second: readonly string[]): boolean {
  return (
    first.length === second.length &&
    first.every((item, index) => item === second[index])
  );
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  const path = relative(root, candidate);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new ChangeArtifactCreationError(`${label} находится за пределами допустимого каталога`);
  }
}

function assertLexicallyContainedPath(
  changeRoot: string,
  reportedPath: string,
  artifactId: string,
): void {
  const candidate = isAbsolute(reportedPath)
    ? reportedPath
    : resolve(changeRoot, reportedPath);
  const path = relative(changeRoot, candidate);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new ChangeArtifactCreationError(
      `Путь артефакта «${artifactId}» находится за пределами change`,
    );
  }
}
