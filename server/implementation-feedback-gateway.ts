import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import type { GitHubRemoteIdentity } from "./github-repository-identity.ts";
import { feedbackFingerprintSchema } from "./implementation-run-model.ts";
import { httpsUrlSchema } from "./review-publication-model.ts";

export const MAX_FEEDBACK_ITEMS = 1_000;
export const MAX_FEEDBACK_BODY_BYTES = 64 * 1_024;
export const MAX_FEEDBACK_TOTAL_BYTES = 4 * 1_024 * 1_024;

const commentFeedbackItemSchema = z
  .object({
    source: z.enum(["comment", "review", "review-thread-comment"]),
    nodeId: z.string().trim().min(1).max(512),
    threadNodeId: z.string().trim().min(1).max(512).optional(),
    updatedAt: z.string().datetime({ offset: true }),
    body: z.string().min(1).max(MAX_FEEDBACK_BODY_BYTES),
    fingerprint: feedbackFingerprintSchema,
  })
  .strict();

const ciFeedbackItemSchema = z
  .object({
    source: z.literal("ci-check"),
    nodeId: z.string().trim().min(1).max(512),
    updatedAt: z.string().datetime({ offset: true }),
    body: z.string().min(1).max(MAX_FEEDBACK_BODY_BYTES),
    fingerprint: feedbackFingerprintSchema,
    checkName: z.string().trim().min(1).max(512),
    commitOid: z.string().regex(/^[0-9a-f]{40}$/u),
    conclusion: z.enum(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]),
    url: httpsUrlSchema,
  })
  .strict();

export const implementationFeedbackItemSchema = z
  .discriminatedUnion("source", [commentFeedbackItemSchema, ciFeedbackItemSchema])
  .superRefine((item, context) => {
    if (Buffer.byteLength(item.body, "utf8") > MAX_FEEDBACK_BODY_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: `Body PR feedback превышает ${MAX_FEEDBACK_BODY_BYTES} байт`,
      });
    }
  });

export type ImplementationFeedbackItem = z.infer<
  typeof implementationFeedbackItemSchema
>;

const pageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  })
  .strict();

const commentSchema = z
  .object({
    id: z.string().min(1).max(512),
    updatedAt: z.string().datetime({ offset: true }),
    body: z.string(),
    isMinimized: z.boolean(),
  })
  .strict();

const reviewSchema = z
  .object({
    id: z.string().min(1).max(512),
    updatedAt: z.string().datetime({ offset: true }),
    body: z.string(),
    state: z.enum([
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
      "DISMISSED",
      "PENDING",
    ]),
  })
  .strict();

const commentsPageSchema = z
  .object({ nodes: z.array(commentSchema), pageInfo: pageInfoSchema })
  .strict();
const reviewsPageSchema = z
  .object({ nodes: z.array(reviewSchema), pageInfo: pageInfoSchema })
  .strict();
const threadSchema = z
  .object({
    id: z.string().min(1).max(512),
    isResolved: z.boolean(),
    comments: commentsPageSchema,
  })
  .strict();
const threadsPageSchema = z
  .object({ nodes: z.array(threadSchema), pageInfo: pageInfoSchema })
  .strict();

const COMMENTS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$after){nodes{id updatedAt body isMinimized} pageInfo{hasNextPage endCursor}}}}}`;
const REVIEWS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:100,after:$after){nodes{id updatedAt body state} pageInfo{hasNextPage endCursor}}}}}`;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:100){nodes{id updatedAt body isMinimized} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
const THREAD_COMMENTS_QUERY = `query($thread:ID!,$after:String){node(id:$thread){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id updatedAt body isMinimized} pageInfo{hasNextPage endCursor}}}}}`;

export class ImplementationFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationFeedbackError";
  }
}

export async function readImplementationPullRequestFeedback(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: GitHubRemoteIdentity,
  pullRequestNumber: number,
  signal?: AbortSignal,
): Promise<readonly ImplementationFeedbackItem[]> {
  const [owner, name, extra] = repository.nameWithOwner.split("/");
  if (!owner || !name || extra !== undefined) {
    throw new ImplementationFeedbackError("Некорректное имя GitHub-репозитория");
  }
  const items: ImplementationFeedbackItem[] = [];
  let observedNodes = 0;
  let totalBytes = 0;

  const account = (
    source: z.infer<typeof commentFeedbackItemSchema>["source"],
    node: z.infer<typeof commentSchema> | z.infer<typeof reviewSchema>,
    threadNodeId?: string,
  ) => {
    observedNodes += 1;
    if (observedNodes > MAX_FEEDBACK_ITEMS) {
      throw new ImplementationFeedbackError(
        `Pull request содержит больше ${MAX_FEEDBACK_ITEMS} элементов feedback`,
      );
    }
    const body = node.body.trim();
    if (!body || ("isMinimized" in node && node.isMinimized)) return;
    if (source === "review" && "state" in node && node.state === "PENDING") return;
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_FEEDBACK_BODY_BYTES) {
      throw new ImplementationFeedbackError(
        `Элемент PR feedback превышает ${MAX_FEEDBACK_BODY_BYTES} байт`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_FEEDBACK_TOTAL_BYTES) {
      throw new ImplementationFeedbackError(
        `Суммарный PR feedback превышает ${MAX_FEEDBACK_TOTAL_BYTES} байт`,
      );
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([source, node.id, node.updatedAt, body, threadNodeId ?? null]))
      .digest("hex");
    items.push(implementationFeedbackItemSchema.parse({
      source,
      nodeId: node.id,
      ...(threadNodeId ? { threadNodeId } : {}),
      updatedAt: node.updatedAt,
      body,
      fingerprint,
    }));
  };

  for await (const node of readConnection(
    command,
    workspaceDirectory,
    repository,
    { owner, name, number: pullRequestNumber },
    COMMENTS_QUERY,
    commentsPageSchema,
    "comments",
    signal,
  )) {
    account("comment", node);
  }
  for await (const node of readConnection(
    command,
    workspaceDirectory,
    repository,
    { owner, name, number: pullRequestNumber },
    REVIEWS_QUERY,
    reviewsPageSchema,
    "reviews",
    signal,
  )) {
    account("review", node);
  }

  let after: string | null = null;
  const threadCursors = new Set<string>();
  do {
    const raw = await graphql(command, workspaceDirectory, repository, THREADS_QUERY, {
      owner,
      name,
      number: pullRequestNumber,
      ...(after ? { after } : {}),
    }, signal);
    const page = parsePullRequestConnection(raw, "reviewThreads", threadsPageSchema);
    for (const thread of page.nodes) {
      observedNodes += 1;
      if (observedNodes > MAX_FEEDBACK_ITEMS) {
        throw new ImplementationFeedbackError(
          `Pull request содержит больше ${MAX_FEEDBACK_ITEMS} элементов feedback`,
        );
      }
      if (!thread.isResolved) {
        for (const comment of thread.comments.nodes) {
          account("review-thread-comment", comment, thread.id);
        }
        const commentCursors = new Set<string>();
        let commentsAfter = nextCursor(thread.comments.pageInfo, commentCursors);
        while (commentsAfter) {
          const commentsRaw = await graphql(
            command,
            workspaceDirectory,
            repository,
            THREAD_COMMENTS_QUERY,
            { thread: thread.id, after: commentsAfter },
            signal,
          );
          const comments = parseThreadComments(commentsRaw);
          for (const comment of comments.nodes) {
            account("review-thread-comment", comment, thread.id);
          }
          commentsAfter = nextCursor(comments.pageInfo, commentCursors);
        }
      }
    }
    after = nextCursor(page.pageInfo, threadCursors);
  } while (after);

  const fingerprints = items.map(({ fingerprint }) => fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new ImplementationFeedbackError("GitHub вернул дублированный PR feedback");
  }
  return Object.freeze(items);
}

async function* readConnection<T extends { readonly id: string }>(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: GitHubRemoteIdentity,
  variables: Record<string, string | number>,
  query: string,
  schema: z.ZodType<{ nodes: T[]; pageInfo: z.infer<typeof pageInfoSchema> }>,
  field: "comments" | "reviews",
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    const raw = await graphql(command, workspaceDirectory, repository, query, {
      ...variables,
      ...(after ? { after } : {}),
    }, signal);
    const page = parsePullRequestConnection(raw, field, schema);
    for (const node of page.nodes) yield node;
    after = nextCursor(page.pageInfo, cursors);
  } while (after);
}

async function graphql(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: GitHubRemoteIdentity,
  query: string,
  variables: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<unknown> {
  const arguments_ = ["api", "graphql", "--hostname", repository.host, "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    arguments_.push("-F", `${name}=${String(value)}`);
  }
  try {
    const result = await command("gh", arguments_, { cwd: workspaceDirectory, signal });
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ImplementationFeedbackError(
      "Не удалось полностью прочитать PR feedback через GitHub GraphQL",
    );
  }
}

function parsePullRequestConnection<T>(
  value: unknown,
  field: "comments" | "reviews" | "reviewThreads",
  schema: z.ZodType<T>,
): T {
  try {
    const root = z
      .object({
        data: z.object({
          repository: z.object({ pullRequest: z.record(z.string(), z.unknown()).nullable() }).strict(),
        }).strict(),
      })
      .strict()
      .parse(value);
    const pullRequest = root.data.repository.pullRequest;
    if (!pullRequest) throw new Error("PR отсутствует");
    return schema.parse(pullRequest[field]);
  } catch {
    throw new ImplementationFeedbackError("GitHub вернул невалидный GraphQL-ответ");
  }
}

function parseThreadComments(value: unknown): z.infer<typeof commentsPageSchema> {
  try {
    return z
      .object({
        data: z.object({
          node: z.object({ comments: commentsPageSchema }).strict().nullable(),
        }).strict(),
      })
      .strict()
      .parse(value).data.node?.comments ?? (() => {
        throw new Error("Thread отсутствует");
      })();
  } catch {
    throw new ImplementationFeedbackError(
      "GitHub вернул невалидную страницу review thread comments",
    );
  }
}

function nextCursor(
  pageInfo: z.infer<typeof pageInfoSchema>,
  observed: Set<string>,
): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) {
    throw new ImplementationFeedbackError(
      "GitHub сообщил о следующей странице без cursor",
    );
  }
  if (observed.has(pageInfo.endCursor) || observed.size >= MAX_FEEDBACK_ITEMS) {
    throw new ImplementationFeedbackError(
      "GitHub вернул зацикленную или чрезмерную пагинацию PR feedback",
    );
  }
  observed.add(pageInfo.endCursor);
  return pageInfo.endCursor;
}
