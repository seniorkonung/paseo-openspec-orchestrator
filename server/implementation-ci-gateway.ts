import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { githubHostSchema, repositoryNameWithOwnerSchema, type GitHubRemoteIdentity } from "./github-repository-identity.ts";
import { implementationFeedbackItemSchema, MAX_FEEDBACK_BODY_BYTES, MAX_FEEDBACK_ITEMS, MAX_FEEDBACK_TOTAL_BYTES, type ImplementationFeedbackItem } from "./implementation-feedback-gateway.ts";
import { httpsUrlSchema, pullRequestNumberSchema } from "./review-publication-model.ts";

const MAX_CI_CHECKS = MAX_FEEDBACK_ITEMS;
const MAX_CI_ANNOTATIONS = 1_000;
const MAX_SUMMARY_BYTES = 8 * 1_024;
const MAX_TEXT_BYTES = 12 * 1_024;
const MAX_ANNOTATIONS_BYTES = 16 * 1_024;
const MAX_LOG_BYTES = 16 * 1_024;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).strict();
const checkConclusionSchema = z.enum([
  "ACTION_REQUIRED", "CANCELLED", "FAILURE", "NEUTRAL", "SKIPPED",
  "STALE", "STARTUP_FAILURE", "SUCCESS", "TIMED_OUT",
]);
const checkRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(512),
  status: z.enum(["COMPLETED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"]),
  conclusion: checkConclusionSchema.nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  permalink: httpsUrlSchema,
  checkSuite: z.object({
    id: z.string().min(1).max(512),
    workflowRun: z.object({
      url: httpsUrlSchema,
      runAttempt: z.number().int().positive(),
    }).strict().nullable(),
  }).strict(),
}).strict();
const statusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  id: z.string().min(1).max(512),
  context: z.string().min(1).max(512),
  state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
  description: z.string().nullable(),
  targetUrl: z.string().max(2_048).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  creator: z.object({ login: z.string().min(1).max(256) }).nullable(),
}).strict();
const checkSchema = z.discriminatedUnion("__typename", [checkRunSchema, statusContextSchema]);
type Check = z.infer<typeof checkSchema>;
const connectionSchema = z.object({
  nodes: z.array(checkSchema),
  pageInfo: pageInfoSchema,
  totalCount: z.number().int().nonnegative(),
}).strict();
const rollupSchema = z.object({
  id: z.string().min(1).max(512),
  commit: z.object({ oid: commitHashSchema }).strict(),
  contexts: connectionSchema,
}).strict();
const pullRequestSchema = z.object({
  headRefOid: commitHashSchema,
  statusCheckRollup: rollupSchema.nullable(),
  potentialMergeCommit: z.object({
    oid: commitHashSchema,
    statusCheckRollup: rollupSchema.nullable(),
  }).strict().nullable(),
}).strict();
const rootSchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: pullRequestSchema.nullable() }).strict(),
  }).strict(),
}).strict();

const CONTEXT_FIELDS = `nodes{__typename ... on CheckRun{id name status conclusion startedAt completedAt permalink checkSuite{id workflowRun{url runAttempt}}} ... on StatusContext{id context state description targetUrl updatedAt creator{login}}} pageInfo{hasNextPage endCursor} totalCount`;
const INITIAL_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid statusCheckRollup{id commit{oid} contexts(first:100){${CONTEXT_FIELDS}}} potentialMergeCommit{oid statusCheckRollup{id commit{oid} contexts(first:100){${CONTEXT_FIELDS}}}}}}}`;
const PAGE_QUERY = `query($id:ID!,$after:String!){node(id:$id){... on StatusCheckRollup{id commit{oid} contexts(first:100,after:$after){${CONTEXT_FIELDS}}}}}`;
const VERIFY_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid statusCheckRollup{id contexts(first:1){totalCount}} potentialMergeCommit{oid statusCheckRollup{id contexts(first:1){totalCount}}}}}}`;
const ANNOTATION_FIELDS = "annotationLevel path location{start{line} end{line}} title message rawDetails";
const DETAIL_QUERY = `query($id:ID!,$after:String){node(id:$id){... on CheckRun{id summary text annotations(first:100,after:$after){nodes{${ANNOTATION_FIELDS}} pageInfo{hasNextPage endCursor} totalCount}}}}`;

const annotationSchema = z.object({
  annotationLevel: z.enum(["FAILURE", "NOTICE", "WARNING"]),
  path: z.string(),
  location: z.object({
    start: z.object({ line: z.number().int().positive() }).strict(),
    end: z.object({ line: z.number().int().positive() }).strict(),
  }).strict(),
  title: z.string().nullable(),
  message: z.string(),
  rawDetails: z.string().nullable(),
}).strict();
const detailSchema = z.object({
  id: z.string().min(1).max(512),
  summary: z.string().nullable(),
  text: z.string().nullable(),
  annotations: z.object({
    nodes: z.array(annotationSchema),
    pageInfo: pageInfoSchema,
    totalCount: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();

export interface ImplementationCiInspection {
  readonly newFailures: readonly ImplementationFeedbackItem[];
  readonly failed: readonly string[];
  readonly pending: readonly string[];
  readonly rerunRequired: readonly string[];
}

export class ImplementationCiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationCiError";
  }
}

export async function readImplementationPullRequestCi(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repositoryInput: GitHubRemoteIdentity,
  pullRequestNumberInput: number,
  expectedHeadInput: string,
  processedFingerprints: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ImplementationCiInspection> {
  const repository = {
    host: githubHostSchema.parse(repositoryInput.host),
    nameWithOwner: repositoryNameWithOwnerSchema.parse(repositoryInput.nameWithOwner),
  };
  const number = pullRequestNumberSchema.parse(pullRequestNumberInput);
  const expectedHead = commitHashSchema.parse(expectedHeadInput);
  const [owner, name] = repository.nameWithOwner.split("/");
  if (!owner || !name) throw new ImplementationCiError("Некорректное имя GitHub-репозитория");
  const first = parseInitial(await graphql(command, workspaceDirectory, repository, INITIAL_QUERY, { owner, name, number }, signal));
  if (first.headRefOid !== expectedHead) throw new ImplementationCiError("Head implementation PR изменился во время проверки CI");

  const mergeRollup = first.potentialMergeCommit?.statusCheckRollup;
  const source = mergeRollup && mergeRollup.contexts.totalCount > 0 ? "merge" : "head";
  const rollup = source === "merge" ? mergeRollup : first.statusCheckRollup;
  const selectedOid = source === "merge" ? first.potentialMergeCommit?.oid : expectedHead;
  if (!selectedOid || (rollup && rollup.commit.oid !== selectedOid)) {
    throw new ImplementationCiError("CI rollup не соответствует commit pull request");
  }

  const checks: Check[] = [];
  if (rollup) {
    if (rollup.contexts.totalCount > MAX_CI_CHECKS) {
      throw new ImplementationCiError("Pull request содержит слишком много CI-проверок");
    }
    checks.push(...rollup.contexts.nodes);
    const seenCursors = new Set<string>();
    let cursor = nextCursor(rollup.contexts.pageInfo, seenCursors);
    while (cursor) {
      if (checks.length > MAX_CI_CHECKS) throw new ImplementationCiError("Pull request содержит слишком много CI-проверок");
      const page = parsePage(await graphql(command, workspaceDirectory, repository, PAGE_QUERY, { id: rollup.id, after: cursor }, signal));
      if (page.id !== rollup.id || page.commit.oid !== selectedOid || page.contexts.totalCount !== rollup.contexts.totalCount) {
        throw new ImplementationCiError("CI rollup изменился во время пагинации");
      }
      checks.push(...page.contexts.nodes);
      cursor = nextCursor(page.contexts.pageInfo, seenCursors);
    }
    if (checks.length !== rollup.contexts.totalCount || checks.length > MAX_CI_CHECKS) {
      throw new ImplementationCiError("Не удалось полностью прочитать CI-проверки pull request");
    }
    if (new Set(checks.map((check) => check.id)).size !== checks.length) {
      throw new ImplementationCiError("GitHub вернул дублированные CI-проверки");
    }
  }

  const verified = parseVerify(await graphql(command, workspaceDirectory, repository, VERIFY_QUERY, { owner, name, number }, signal));
  const verifiedMerge = verified.potentialMergeCommit?.statusCheckRollup;
  const verifiedSource = verifiedMerge && verifiedMerge.contexts.totalCount > 0 ? "merge" : "head";
  const verifiedRollup = verifiedSource === "merge" ? verifiedMerge : verified.statusCheckRollup;
  if (verified.headRefOid !== expectedHead || verifiedSource !== source ||
      (verifiedSource === "merge" && verified.potentialMergeCommit?.oid !== selectedOid) ||
      (verifiedRollup?.id ?? null) !== (rollup?.id ?? null) ||
      (verifiedRollup?.contexts.totalCount ?? 0) !== (rollup?.contexts.totalCount ?? 0)) {
    throw new ImplementationCiError("CI-проверки или head PR изменились во время чтения");
  }

  const current = selectLatest(checks);
  const pending: string[] = [];
  const failed: string[] = [];
  const rerunRequired: string[] = [];
  const newFailures: ImplementationFeedbackItem[] = [];
  const failedLogCache = new Map<string, Promise<string>>();
  let totalBytes = 0;
  for (const check of current) {
    const name = check.__typename === "CheckRun" ? check.name : check.context;
    if (check.__typename === "CheckRun") {
      if (check.status !== "COMPLETED") { pending.push(name); continue; }
      if (check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED") continue;
      if (check.conclusion === "CANCELLED" || check.conclusion === "STALE") { rerunRequired.push(name); continue; }
      if (!check.conclusion || !check.completedAt) throw new ImplementationCiError("Завершённый check run не содержит результата и времени");
      failed.push(name);
      const fingerprint = fingerprintFor(selectedOid, check.id, check.completedAt, check.conclusion);
      if (processedFingerprints.has(fingerprint)) continue;
      const detail = await readCheckDetail(command, workspaceDirectory, repository, check.id, signal);
      const workflowRun = check.checkSuite.workflowRun;
      let logs = "";
      if (workflowRun) {
        const logKey = `${workflowRun.url}:${workflowRun.runAttempt}`;
        let cached = failedLogCache.get(logKey);
        if (!cached) {
          cached = readFailedLogs(command, workspaceDirectory, repository, selectedOid, workflowRun, signal);
          failedLogCache.set(logKey, cached);
        }
        logs = await cached;
      }
      const body = serializeEvidence({
        summary: trimBytes(detail.summary ?? "", MAX_SUMMARY_BYTES),
        text: trimBytes(detail.text ?? "", MAX_TEXT_BYTES),
        annotations: trimBytes(JSON.stringify(detail.annotations), MAX_ANNOTATIONS_BYTES),
        failedLogs: trimBytes(logs, MAX_LOG_BYTES),
      });
      const item = implementationFeedbackItemSchema.parse({
        source: "ci-check", nodeId: check.id, updatedAt: check.completedAt,
        body, fingerprint, checkName: name, commitOid: selectedOid,
        conclusion: check.conclusion, url: check.permalink,
      });
      totalBytes += Buffer.byteLength(body, "utf8");
      if (totalBytes > MAX_FEEDBACK_TOTAL_BYTES) throw new ImplementationCiError("CI feedback превышает общий лимит");
      newFailures.push(item);
    } else {
      if (check.state === "PENDING" || check.state === "EXPECTED") { pending.push(name); continue; }
      if (check.state === "SUCCESS") continue;
      failed.push(name);
      const fingerprint = fingerprintFor(selectedOid, check.id, check.updatedAt, check.state);
      if (processedFingerprints.has(fingerprint)) continue;
      const body = JSON.stringify({ description: trimBytes(check.description ?? "", MAX_TEXT_BYTES) });
      const item = implementationFeedbackItemSchema.parse({
        source: "ci-check", nodeId: check.id, updatedAt: check.updatedAt,
        body, fingerprint, checkName: name, commitOid: selectedOid,
        conclusion: check.state,
        url: safeCheckUrl(check.targetUrl) ?? `https://${repository.host}/${repository.nameWithOwner}/pull/${number}/checks`,
      });
      totalBytes += Buffer.byteLength(body, "utf8");
      if (totalBytes > MAX_FEEDBACK_TOTAL_BYTES) throw new ImplementationCiError("CI feedback превышает общий лимит");
      newFailures.push(item);
    }
  }
  return { newFailures, failed, pending, rerunRequired };
}

function selectLatest(checks: readonly Check[]): Check[] {
  const latest = new Map<string, Check>();
  for (const check of checks) {
    const key = check.__typename === "CheckRun"
      ? `run:${check.checkSuite.id}:${check.name}`
      : `status:${check.creator?.login ?? "unknown"}:${check.context}`;
    const previous = latest.get(key);
    const timestamp = check.__typename === "CheckRun" ? check.startedAt ?? check.completedAt : check.updatedAt;
    const previousTimestamp = previous?.__typename === "CheckRun" ? previous.startedAt ?? previous.completedAt : previous?.updatedAt;
    if (previous?.__typename === "CheckRun" && previous.status !== "COMPLETED" && !previousTimestamp) continue;
    if (!previous || (timestamp && (!previousTimestamp || Date.parse(timestamp) >= Date.parse(previousTimestamp))) ||
        (check.__typename === "CheckRun" && check.status !== "COMPLETED" && !timestamp)) latest.set(key, check);
  }
  return [...latest.values()];
}

function fingerprintFor(commitOid: string, id: string, updatedAt: string, outcome: string): string {
  return createHash("sha256").update(JSON.stringify(["ci-check", commitOid, id, updatedAt, outcome])).digest("hex");
}

async function readCheckDetail(command: BoundedCommandRunner, cwd: string, repository: GitHubRemoteIdentity, id: string, signal?: AbortSignal) {
  const annotations: z.infer<typeof annotationSchema>[] = [];
  let summary: string | null = null;
  let details: string | null = null;
  let readFirstPage = false;
  let after: string | null = null;
  let expectedAnnotations: number | null = null;
  const cursors = new Set<string>();
  do {
    const value = await graphql(command, cwd, repository, DETAIL_QUERY, { id, ...(after ? { after } : {}) }, signal);
    let detail: z.infer<typeof detailSchema>;
    try {
      detail = detailSchema.parse(z.object({ data: z.object({ node: z.unknown() }).strict() }).strict().parse(value).data.node);
    } catch {
      throw new ImplementationCiError("GitHub вернул невалидные детали CI-проверки");
    }
    if (detail.id !== id || (readFirstPage && (summary !== detail.summary || details !== detail.text))) {
      throw new ImplementationCiError("Детали CI-проверки изменились во время чтения");
    }
    readFirstPage = true;
    summary = detail.summary;
    details = detail.text;
    if (detail.annotations) {
      if (expectedAnnotations !== null && expectedAnnotations !== detail.annotations.totalCount) {
        throw new ImplementationCiError("Число CI annotations изменилось во время чтения");
      }
      expectedAnnotations = detail.annotations.totalCount;
      if (expectedAnnotations > MAX_CI_ANNOTATIONS) throw new ImplementationCiError("Слишком много CI annotations");
      annotations.push(...detail.annotations.nodes);
      if (annotations.length > MAX_CI_ANNOTATIONS) throw new ImplementationCiError("Слишком много CI annotations");
      after = nextCursor(detail.annotations.pageInfo, cursors);
    } else {
      after = null;
    }
  } while (after);
  if (expectedAnnotations !== null && annotations.length !== expectedAnnotations) {
    throw new ImplementationCiError("Не удалось полностью прочитать CI annotations");
  }
  return { summary, text: details, annotations };
}

async function readFailedLogs(
  command: BoundedCommandRunner,
  cwd: string,
  repository: GitHubRemoteIdentity,
  commitOid: string,
  workflowRun: { url: string; runAttempt: number } | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!workflowRun) return "";
  const runId = actionsRunId(workflowRun.url, repository);
  if (!runId) return "";
  try {
    const metadataResult = await command("gh", ["run", "view", runId, "--repo", repositoryArgument(repository), "--json", "headSha,attempt"], { cwd, signal });
    const metadata = z.object({ headSha: commitHashSchema, attempt: z.number().int().positive() }).strict().parse(JSON.parse(metadataResult.stdout));
    if (metadata.headSha !== commitOid || metadata.attempt !== workflowRun.runAttempt) return "";
    const logs = await command("gh", ["run", "view", runId, "--repo", repositoryArgument(repository), "--attempt", String(metadata.attempt), "--log-failed"], { cwd, signal, maxBuffer: 128 * 1_024 });
    return logs.stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
}

function actionsRunId(raw: string, repository: GitHubRemoteIdentity): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const [owner, name] = repository.nameWithOwner.split("/");
  const path = url.pathname.split("/");
  if (url.protocol !== "https:" || url.hostname !== repository.host || url.port ||
      url.username || url.password || url.search || url.hash ||
      path.length !== 6 ||
      path[1]?.toLowerCase() !== owner?.toLowerCase() ||
      path[2]?.toLowerCase() !== name?.toLowerCase() ||
      path[3] !== "actions" || path[4] !== "runs" ||
      !/^\d{1,20}$/u.test(path[5] ?? "")) return null;
  return path[5]!;
}

function trimBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "\n[усечено]";
  const target = limit - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= target) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + suffix;
}

function serializeEvidence(input: Record<"summary" | "text" | "annotations" | "failedLogs", string>): string {
  const evidence = { ...input };
  let body = JSON.stringify(evidence);
  while (Buffer.byteLength(body, "utf8") > MAX_FEEDBACK_BODY_BYTES) {
    const largest = (Object.keys(evidence) as Array<keyof typeof evidence>)
      .sort((left, right) => Buffer.byteLength(evidence[right], "utf8") - Buffer.byteLength(evidence[left], "utf8"))[0];
    if (!largest || !evidence[largest]) throw new ImplementationCiError("CI evidence превышает лимит feedback");
    evidence[largest] = trimBytes(evidence[largest], Math.floor(Buffer.byteLength(evidence[largest], "utf8") / 2));
    body = JSON.stringify(evidence);
  }
  return body;
}

function safeCheckUrl(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = httpsUrlSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseInitial(value: unknown): z.infer<typeof pullRequestSchema> {
  try {
    const pullRequest = rootSchema.parse(value).data.repository.pullRequest;
    if (!pullRequest) throw new Error("PR отсутствует");
    return pullRequest;
  } catch { throw new ImplementationCiError("GitHub вернул невалидный CI rollup PR"); }
}

function parsePage(value: unknown): z.infer<typeof rollupSchema> {
  try {
    return rollupSchema.parse(z.object({ data: z.object({ node: z.unknown() }).strict() }).strict().parse(value).data.node);
  } catch { throw new ImplementationCiError("GitHub вернул невалидную страницу CI rollup"); }
}

function parseVerify(value: unknown): {
  headRefOid: string;
  statusCheckRollup: { id: string; contexts: { totalCount: number } } | null;
  potentialMergeCommit: { oid: string; statusCheckRollup: { id: string; contexts: { totalCount: number } } | null } | null;
} {
  const briefRollup = z.object({ id: z.string().min(1).max(512), contexts: z.object({ totalCount: z.number().int().nonnegative() }).strict() }).strict();
  try {
    const root = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({
      headRefOid: commitHashSchema,
      statusCheckRollup: briefRollup.nullable(),
      potentialMergeCommit: z.object({ oid: commitHashSchema, statusCheckRollup: briefRollup.nullable() }).strict().nullable(),
    }).strict().nullable() }).strict() }).strict() }).strict().parse(value);
    if (!root.data.repository.pullRequest) throw new Error("PR отсутствует");
    return root.data.repository.pullRequest;
  } catch { throw new ImplementationCiError("GitHub вернул невалидную повторную проверку CI"); }
}

function nextCursor(page: z.infer<typeof pageInfoSchema>, seen: Set<string>): string | null {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || seen.has(page.endCursor) || seen.size >= MAX_CI_CHECKS) {
    throw new ImplementationCiError("GitHub вернул неполную или зацикленную пагинацию CI");
  }
  seen.add(page.endCursor);
  return page.endCursor;
}

async function graphql(command: BoundedCommandRunner, cwd: string, repository: GitHubRemoteIdentity, query: string, variables: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
  const args = ["api", "graphql", "--hostname", repository.host, "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${String(value)}`);
  try {
    const result = await command("gh", args, { cwd, signal });
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ImplementationCiError("Не удалось прочитать CI через GitHub GraphQL");
  }
}

function repositoryArgument(repository: GitHubRemoteIdentity): string {
  return repository.host === "github.com" ? repository.nameWithOwner : `${repository.host}/${repository.nameWithOwner}`;
}
