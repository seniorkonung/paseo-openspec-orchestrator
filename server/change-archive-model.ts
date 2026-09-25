import { z } from "zod";
import { changeBranchFor, changeBranchSchema } from "./change-branch.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { rootPullRequestIdentitySchema } from "./root-pull-request.ts";

const repositoryPathSchema = z.string().min(1).max(8_192).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "Путь архива должен находиться внутри репозитория",
);

export const pendingArchiveSessionSchema = z.object({
  changeId: openSpecChangeIdSchema,
  branch: changeBranchSchema,
  baselineCommit: commitHashSchema,
  sourcePath: repositoryPathSchema,
  archivePath: repositoryPathSchema,
  deltaSpecPaths: z.array(repositoryPathSchema).max(512).default([]),
  rootPullRequest: rootPullRequestIdentitySchema,
}).strict().superRefine((session, context) => {
  if (session.branch !== changeBranchFor(session.changeId) ||
      session.rootPullRequest.changeBranch !== session.branch) {
    context.addIssue({ code: "custom", path: ["branch"], message: "Архивация относится к другой change-ветке" });
  }
  const source = session.sourcePath.split("/");
  const archiveName = session.archivePath.split("/").at(-1) ?? "";
  const expectedName = /^\d{4}-\d{2}-\d{2}-/u.test(session.changeId)
    ? session.changeId
    : `${archiveName.slice(0, 10)}-${session.changeId}`;
  if (source.at(-1) !== session.changeId || source.at(-2) !== "changes" ||
      session.archivePath !== [
        ...source.slice(0, -1), "archive", archiveName,
      ].join("/") ||
      !/^\d{4}-\d{2}-\d{2}-/u.test(archiveName) || archiveName !== expectedName) {
    context.addIssue({ code: "custom", path: ["archivePath"], message: "Путь архива не соответствует выбранному change" });
  }
});

export type PendingArchiveSession = z.infer<typeof pendingArchiveSessionSchema>;

export const archivedChangeSchema = z.object({
  session: pendingArchiveSessionSchema,
  commit: commitHashSchema,
}).strict();

export type ArchivedChange = z.infer<typeof archivedChangeSchema>;

export class ChangeArchiveError extends Error {
  constructor(message: string) { super(message); this.name = "ChangeArchiveError"; }
}
