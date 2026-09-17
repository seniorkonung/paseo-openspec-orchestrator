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
- reviewing all artifacts of the published change, recording the findings in a
  committed and pushed `review.md`, and preserving an interactive agent session
  when the review needs user input;
- resolving active review findings one at a time through separate approved,
  committed, and pushed planning-artifact changes until none remain;
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
  receives only `complete_review_finding`. A tool from one session is not shared
  with another session.
- `server/change-artifact-creation.ts` is the boundary around OpenSpec planning
  status, repository path validation, per-artifact Git verification, agent
  sessions, and the `complete_artifact` MCP contract.
- `server/change-publication.ts` owns the GitHub publication seam: it validates
  `origin`, GitHub CLI access, the remote commit and pull-request metadata while
  a workspace-local agent performs the push and PR create/edit operations.
- `server/change-review.ts` owns review recovery, safe `review.md` detection,
  the review agent session, and independent verification of the resulting Git
  commit and remote branch.
- `server/change-review-report.ts` validates the versioned `review.md` contract
  fail closed, while `server/change-finding-resolution.ts` owns finding
  selection, the interactive resolution session, Git verification, scoped MCP,
  and restart recovery.

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
Draft policy, title, and body before advancing to `review-change`. A restart
safely reconciles the already pushed branch or PR instead of creating a
duplicate.

The `review-change` step resolves `review.md` against the actual
`changeRoot` reported by OpenSpec. A non-empty ordinary file can skip the agent
only when it is tracked by the current `HEAD`, the worktree is clean, the saved
branch is active, and `origin` contains that exact `HEAD`. Otherwise the step
saves the branch and baseline commit, rereads the `Ultra Sandbox` profile, and
immediately creates a workspace-local agent with `ntfy=true` and a prompt to
invoke `openspec-review-change` for the complete change ID. The orchestrator
does not inspect the agent's skill catalog; skill discovery belongs to the
agent environment.

The review session may span any number of agent turns and user replies. Ending
one turn is not a workflow failure: the step waits for the scoped
`complete_change_review` tool while `ntfy=true` keeps user intervention visible.
Findings do not block completion and are not fixed in this step. The agent adds
only new review files under the change root, creates exactly one review commit,
and pushes the branch without force. The completion tool independently checks
the file, worktree, saved branch and baseline, commit count and subject, changed
paths, and remote `HEAD`. It then disables `ntfy` and atomically clears the
pending review session. A restart reuses the saved baseline; if the review
commit already exists, the recovery agent only finishes publication and the
completion handshake instead of reviewing or committing again.

Both review outcomes continue to `resolve-review-findings`. Before reading an
agent profile, that step obtains the actual `changeRoot` from OpenSpec and
parses a tracked ordinary `review.md` as strict UTF-8 format version 1 (up to
1 MiB and 256 active findings). Active `F<n>` entries come only from the
`Findings` section and retain report order; `AR<n>` entries in `Accepted risks`
are resolved outcomes. Malformed or unsupported reports fail closed with
actionable feedback. No active findings completes the workflow immediately.

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
`docs(openspec): resolve <F-id> review finding` commit, pushes the current branch
to `origin`, and calls the sole `complete_review_finding {}` tool. The tool
independently reparses the report, requires the selected ID to be absent,
checks the branch, clean worktree, baseline ancestry, one exact-subject commit,
the `review.md` diff, change-root path boundary, and exact local/remote HEAD. It
then disables `ntfy` and atomically clears the pending session; a checkpoint
failure restores `ntfy=true`. Remaining findings loop back through the same
step, one agent per finding. Recovery keeps the selected ID and baseline, and a
valid existing commit is only pushed and acknowledged rather than recreated.

Implementation code for the selected change remains outside the current
workflow endpoint; finding resolution is restricted to planning artifacts and
`review.md` under its change root.

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
