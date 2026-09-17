# Paseo OpenSpec Orchestrator

`paseo-openspec-orchestrator` is a [Paseo](https://github.com/getpaseo/paseo)
plugin that adds orchestration for an OpenSpec-driven development workflow. It
provides the runtime and user interface for executing a resumable workflow in a
Paseo workspace, observing its progress, and recovering it across plugin
restarts.

The orchestration foundation is implemented, but the intended end-to-end
OpenSpec workflow is still under development. Treat this repository as an
evolving workflow engine and integration layer rather than a finished automation
pipeline. This README describes the stable high-level architecture; the source
code and tests remain the authority for detailed behavior.

## What the plugin owns

The plugin is responsible for:

- exposing an OpenSpec orchestrator panel and workspace-aware composer entry
  points in Paseo;
- controlling workflow lifecycle transitions such as start, pause, resume,
  retry, and state reset;
- recording the current action and completed action history for each workspace;
- persisting workflow state and checkpoints so execution can recover after a
  restart;
- guiding the user through an explicit choice of the active OpenSpec change and
  persisting that choice only after the change exists in Git history;
- inspecting the selected change's schema-defined planning graph and creating
  one approved, separately committed artifact per agent session until planning
  is complete;
- publishing the completed planning branch to `origin` and creating or
  reconciling one change-owned integration pull request into `main`;
- creating a dependent `<change-branch>-review` branch and Ready pull request
  into the published change branch, then reviewing all artifacts there and
  recording the findings in a committed and pushed `review.md`;
- resolving active review findings one at a time through separate approved,
  committed, and pushed planning-artifact changes until none remain;
- resolving active implementation-review findings one at a time, either by
  assigning durable planning ownership or by recording an explicitly accepted
  residual risk;
- delivering optional workflow notifications through ntfy;
- delegating interactive workflow steps to Paseo agents through scoped MCP
  tools.

A workspace is considered OpenSpec-enabled when it contains
`openspec/config.yaml` at its root. The plugin uses that check to decide where
to expose its composer shortcut.

## Core concepts

| Concept | Meaning in this repository |
| --- | --- |
| **Workflow** | A directed graph of typed steps executed for one Paseo workspace. Transitions name the next step explicitly, so workflows may branch or loop. |
| **Step** | An isolated asynchronous operation that either continues to another step, completes the workflow, or halts with a recoverable failure. |
| **Ledger** | The durable per-workspace record of lifecycle state, current action, action history, selected OpenSpec change, and the internal checkpoint. |
| **Checkpoint** | The persisted next-step identifier and typed workflow state used to resume execution after a plugin restart. |

## Architecture

The client and server halves communicate through typed RPC contracts defined in
`shared/`:

```text
Paseo workspace panel and composer shortcut
                  |
                  | typed RPC + long polling
                  v
         OrchestratorController
                  |
                  v
       OpenSpecOrchestratorEngine
          |                 |
          v                 v
   workflow step graph   reporter / ledger
          |                 |
          v                 v
  Git, agents, MCP,     persisted state and
  and notifications       UI snapshots
```

The main boundaries are:

- `index.client.tsx` and `client/` register the workspace panel, notification
  settings, composer shortcut, and client-side state synchronization.
- `index.server.ts`, `shared/`, and `server/orchestrator-controller.ts` register
  RPC handlers, validate their inputs and outputs, resolve Paseo workspaces, and
  enforce revision-aware commands.
- `server/openspec-orchestrator-engine.ts` owns workflow execution, lifecycle
  transitions, pause and retry behavior, checkpoint recovery, and automatic
  completion or retry notifications.
- `server/workflow/` contains the typed workflow model, the step registry, and
  the step implementations. Steps live in `server/workflow/steps/` and are
  registered in `server/workflow/steps/index.ts`.
- `server/orchestrator-ledger.ts` maintains the public snapshot and internal
  checkpoint for each workspace. It stores data beneath
  `$PASEO_HOME/plugin-data/paseo-openspec-orchestrator/` (or `~/.paseo` when
  `PASEO_HOME` is unset).
- `server/orchestrator-notifications.ts` and related modules keep optional ntfy
  delivery outside step business logic. Notification failures are logged but do
  not fail the workflow itself.
- `server/orchestrator-mcp-tool-host.ts` provides the scoped local MCP server
  used to attach orchestrator-owned tools to Paseo agents. The default workflow
  exposes only `set_change` to a change-selection agent and only
  `complete_artifact` to each artifact-creation agent, only
  `complete_change_publication` to the publication agent, and only
  `complete_change_review` to the review agent. Each finding-resolution agent
  receives only its matching `complete_review_finding` or
  `complete_implementation_review_finding` tool. A tool from one session is not
  shared with another session.
- `server/change-artifact-creation.ts` is the boundary around OpenSpec planning
  status, repository path validation, per-artifact Git verification, agent
  sessions, and the `complete_artifact` MCP contract.
- `server/change-publication.ts` owns the GitHub publication seam: it validates
  `origin`, GitHub CLI access, the remote commit and pull-request metadata while
  a workspace-local agent performs the push and PR create/edit operations.
- `server/change-review.ts` owns the review agent session and review-commit
  verification. `server/change-review-publication.ts` owns the immutable
  parent/child branch target, the GitHub PR boundary, accumulated finding
  outcomes, and restart reconciliation. Finding agents never invoke `gh`.
- `server/change-review-report.ts` and
  `server/implementation-review-report.ts` validate their versioned report
  contracts fail closed. `server/review-finding-resolution.ts` owns the shared
  finding-resolution lifecycle, Git verification, scoped MCP, notification,
  and restart-recovery invariants; the two format-specific adapters own report
  parsing, prompts, tool names, and commit subjects.

The shared Zod schemas are runtime boundaries as well as TypeScript contracts.
Persisted data, RPC payloads, workflow state, and tool results must be validated
before they enter trusted orchestration code.

## Default workflow

The workflow first verifies all required Paseo agent profiles, the Git branch,
a clean worktree, and the workspace mise toolchain. Each required profile
must explicitly define a provider, model, mode, and thinking option; the
orchestrator does not discover or infer missing launch settings. The toolchain
check requires `mise` on the plugin process `PATH`; its current required-tool
set contains an active, installed `npm:@fission-ai/openspec` entry declared by
a mise configuration inside the workspace. It checks availability rather than
a specific tool version and never installs a missing tool automatically.

After the checks, a `Low Sandbox` agent is added to the same Paseo workspace,
where it lists the active repo-local OpenSpec changes and asks the user to select
one or create a new scaffold. The agent and the scoped `set_change` tool run
OpenSpec as `mise exec --no-deps -- openspec ...` from that workspace. A newly
created change must be committed before the agent can select it. The tool reads
the actual `changeRoot` from `openspec status --json`, validates its workspace
and repository boundaries, repository cleanliness, and presence in `HEAD`
before recording the choice.

The selection step then reads the schema-defined artifact graph from
`openspec status --json`. If planning is already complete, the workflow checks
`openspec instructions apply --json` and advances directly to publication.
Otherwise it enters the `create-change-artifacts` step. That step loops back to
itself, always choosing the first `ready` artifact in OpenSpec's dependency
order, and advances to publication after the final artifact; it does not assume
that an artifact is named `tasks` or that the repository uses the default
schema. The OpenSpec JSON contracts and ordering rules come from the
[OpenSpec agent contract](https://github.com/Fission-AI/OpenSpec/blob/main/docs/agent-contract.md).

Each loop iteration rereads Paseo profiles and starts one idle `Ultra Sandbox`
agent in the current workspace. The orchestrator checks the live command catalog
before sending work, so a missing `openspec-continue-change` skill fails closed.
The agent invokes that skill once, creates only the expected artifact, shows it
to the user, and waits for explicit approval. This follows the skill's
[one-artifact contract](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-continue-change/SKILL.md).
After approval, the agent commits only the concrete paths reported by OpenSpec
and calls `complete_artifact`.

The orchestrator does not enable automatic archiving or call an archive API.
Completing, canceling, or failing a workflow step leaves the agent and its
workspace available until the user closes them in Paseo.

The completion tool independently requires a clean worktree, exactly one commit
after the saved baseline, and no changed paths outside the expected artifact.
It disables the agent's final ntfy notification and clears the pending session
checkpoint before acknowledging success. A restart before that acknowledgement
resumes the same artifact; a restart after it advances from the durable cleared
checkpoint. Agent placement and live command discovery use the documented
[Paseo workspace agent](https://paseo.sh/docs/sdk/workspaces#start-an-agent-in-a-workspace)
and [agent command catalog](https://paseo.sh/docs/sdk/agents#list-the-commands-a-session-loaded)
APIs.

Once planning is complete, both the already-complete selection path and the
artifact loop enter `publish-change`. The step revalidates the selected change,
the saved non-`main` branch, apply readiness, and a clean worktree before it
starts a fresh `Medium Sandbox` agent. The workspace must have an `origin`
GitHub remote with a `main` branch, and `gh` must be installed and authenticated
for that host; `gh` is a host prerequisite like Git and is not managed by the
workspace mise toolchain.

The agent reads every completed planning artifact, pushes the current branch to
`origin` without force, and owns exactly one open integration pull request for
that branch. It fully regenerates the stable Russian title and body from the
change artifacts. An existing open PR is retargeted to `main` and keeps its
Draft/Ready state; otherwise the agent creates a new Draft PR, ignoring closed
or merged history. The scoped `complete_change_publication` tool independently
checks the clean worktree, local and remote HEADs, repository, base/head refs,
Draft policy, title, and body before advancing to `review-change`. The agent
starts with `ntfy=true`, and ending an individual turn does not complete or fail
the step: the notification label and MCP scope remain active until the tool
succeeds. A failed tool check returns actionable feedback to the agent and may
be retried in the same session. A restart safely reconciles the already pushed
branch or PR instead of creating a duplicate.

The `review-change` step treats `WorkflowState.branch` as the active tip of the
pull-request chain. Before any mutation it requires a clean worktree, the saved
parent branch as the current branch, identical local and `origin` parent HEADs,
and exactly one open parent pull request into `main`. It also rejects any local
branch, remote branch, or historical pull request that already occupies the
derived `<parent>-review` name. The durable pending session records the change,
both branch refs, baseline commit, GitHub repository identity, and parent PR.
An existing `review.md` never skips this stage: every review session must
produce one new review commit.

The review session may span any number of agent turns and user replies. Ending
one turn is not a workflow failure: the step waits for the scoped
`complete_change_review` tool while `ntfy=true` keeps user intervention visible.
Findings do not block completion and are not fixed in this step. The agent
creates the child branch strictly at the saved baseline, pushes it before the
review, invokes `openspec-review-change`, creates exactly one review commit,
pushes again, and creates one Ready PR from the child into the parent. Existing
`review.md` may be updated, but no other pre-existing planning file may change.
The completion tool independently checks the parent immutability, child
ancestry and commit, changed paths, exact remote HEAD, repository, Ready state,
base/head refs, title, body, and absence of a fork. Only the successful durable
workflow transition changes the active branch to the child and clears the
pending session. A restart reconciles a local branch, initial push, completed
review commit, or already-created PR without duplicating effects.

Finding-resolution steps therefore commit and push on the review branch. Merge
the review PR into the change branch first; only then merge the change PR into
`main`. The successful review continues to `resolve-review-findings`. Before reading an
agent profile, that step obtains the actual `changeRoot` from OpenSpec and
parses a tracked ordinary `review.md` as strict UTF-8 format version 1 (up to
1 MiB and 256 active findings). Active `F<n>` entries come only from the
`Findings` section and retain report order; `AR<n>` entries in `Accepted risks`
are resolved outcomes. Malformed or unsupported reports fail closed with
actionable feedback. No active findings advances directly to
`resolve-implementation-review-findings`.

Otherwise the step durably saves the first finding and baseline commit, rereads
the `High Sandbox` profile, and starts one workspace-local agent with
`ntfy=true`. The prompt tells the agent to invoke `openspec-review-change` for
the exact change and finding without first inspecting the command catalog. The
agent explains the finding to a user with no assumed context. Product or
contract choices include options and trade-offs; an obvious technical
correction includes a concise explanation that product behavior does not
change. The user must explicitly approve the artifact change or risk acceptance
and, after re-review, separately approve the commit and push.

Each successful iteration creates exactly one
`docs(openspec): resolve <F-id> review finding` commit and pushes the current
branch to `origin`. The agent does not inspect or edit GitHub. It calls the sole
`complete_review_finding` tool with `mode: "publish"` and concise Russian
`problem` and `resolution` lines. The tool independently reparses the report,
derives either `resolved` or `accepted-risk` from the accepted-risk origin,
checks the branch, clean worktree, baseline ancestry, one exact-subject commit,
the `review.md` diff, change-root path boundary, and exact local/remote HEAD.

The same tool resolves `origin` to a GitHub repository, requires exactly one
open Ready non-fork review PR with the expected base, head, title, and remote
OID, then appends the outcome to an orchestrator-managed section without
changing existing body content or earlier outcomes. It writes the body through
a protected temporary file, rereads GitHub, and verifies the exact body and
metadata before disabling `ntfy` and clearing the pending session. The marker
includes review kind, finding ID, and baseline commit, so a retry cannot create
a duplicate and ordinary and implementation `F1` remain distinct. A checkpoint
failure restores `ntfy=true`.

Remaining findings loop back through the same step, one agent per finding.
Recovery keeps the selected ID and baseline: a valid existing commit skips the
skill and approvals and only publishes the summary; if the verified PR entry
already exists, the agent calls `mode: "acknowledge-existing"` without repeating
GitHub work.

`resolve-implementation-review-findings` then applies the same one-finding-per-
agent lifecycle to the canonical `implementation-review.md`. The absence of
that file during initial planning is a normal empty result and completes the
workflow without reading an agent profile. Once a finding has been selected,
deleting the report is an error. A present report must be an ordinary,
non-symlink file inside the actual OpenSpec `changeRoot`, no larger than 1 MiB,
valid UTF-8, and fully conformant to OpenSpec Implementation Review format
version 1. The parser returns active `F<n>` entries in report order, excludes
accepted `AR<n>` risks, and limits active findings to 256.

For the first active finding, the step durably records the change, branch,
finding ID, and baseline commit, rereads `High Sandbox`, and starts a
workspace-local agent with `ntfy=true`. The prompt directly requires
`openspec-review-implementation` for the exact change and finding; the
orchestrator neither checks nor discovers that skill. The user first approves
the proposed planning remediation or explicit risk acceptance, then separately
approves the final result before commit and push. The agent may update only
planning/tracked-work artifacts and `implementation-review.md`, not
implementation or test code. Accepted residual risk moves from `F<n>` to
`AR<n>`.

Each successful iteration creates exactly one
`docs(openspec): resolve <F-id> implementation finding` commit (or the stable
length fallback), pushes the current branch to `origin` without force or tags,
and calls only `complete_implementation_review_finding` with the same publish or
acknowledgement contract. The scoped tool reparses the report, requires the
selected ID to be absent from all active findings, derives accepted-risk status
from `Originating finding`, and enforces a tracked report, clean tree without
untracked files, the saved branch, baseline ancestry, one exact-subject commit,
report inclusion in the diff, change-root path boundaries, exact local/remote
HEAD, and the same verified accumulated review-PR publication. Failed checks
return actionable feedback and keep `ntfy=true`; checkpoint failure restores
it. Success returns the outcome and verified PR number and URL, disables the
label, atomically clears the pending session, and either loops for the next
report-ordered finding or completes the workflow. A restart preserves the
selected ID and baseline and uses the same idempotent recovery modes.

Implementation code for the selected change remains outside the current
workflow endpoint; both finding resolvers are restricted to planning artifacts
and their canonical report under the change root.

## Extending the workflow

Detailed instructions for defining state, implementing a step, registering its
transitions, and handling cancellation are in
[`server/workflow/README.md`](server/workflow/README.md).

At a high level, a new step belongs in `server/workflow/steps/`, implements the
typed step contract from `server/workflow/types.ts`, and is added to the central
step registry. Any state that must survive a restart must also be represented in
the workflow state schema. Steps that perform external or mutating work must be
idempotent or be able to detect an already completed result, because execution
may resume after a process restart. Retry re-enters the failed step from its
durably persisted checkpoint instead of resetting the workflow to its first
step; only an explicit state reset or a new run after completion starts over.

## Development

The project targets Node.js 22 and requires Paseo 0.8.0 or newer. The repository
includes a `mise.toml` for installing the expected toolchain.

```sh
mise install
npm ci
npm run typecheck
npm test
```

Use this README for repository-level orientation. For exact contracts and
behavior, consult the shared schemas, the relevant implementation, and the test
suite together.
