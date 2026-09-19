# Paseo OpenSpec Orchestrator

`paseo-openspec-orchestrator` is a [Paseo](https://github.com/getpaseo/paseo)
plugin that runs a resumable OpenSpec development workflow inside a Paseo
workspace. It provides lifecycle controls, durable progress, recovery after
plugin restarts, and scoped agent sessions for the interactive stages.

The workflow is production-oriented but still evolving. The source code and
tests are the authority for detailed behavior.

## What the plugin owns

The plugin:

- exposes an orchestrator panel and workspace-aware composer entry points;
- persists lifecycle state, action history, and workflow checkpoints;
- derives the OpenSpec change from an exact `change/<change-id>` Git branch;
- creates a missing change with the non-interactive OpenSpec JSON contract,
  commits its scaffold, pushes the root branch, and creates a Draft root PR to
  `main`;
- creates `planning/<change-id>/initial` for the initial artifacts and
  `planning/<change-id>/phase-N` for tasks of exactly one later phase;
- updates the root PR description from completed planning artifacts through an
  orchestrator-owned REST gateway while preserving its existing Draft/Ready state;
- creates one Ready PR from each planning branch to `change/<change-id>` and
  waits for its manual merge;
- scans bounded `plan.md` phase headings, snapshots OpenSpec tasks, and chooses
  the earliest phase that needs planning or implementation without validating
  the rest of the plan's Markdown structure;
- creates a collision-free `implementation/<change-id>/phase-N/run-M` for one
  phase, with a durable monotonic run number;
- executes only that phase's unfinished tasks sequentially, with one agent
  session and one Conventional Commit per task;
- reviews each new batch of task commits, resolves both review reports, audits
  untrusted PR feedback, and re-enters the task cycle until it is clean;
- creates and reuses one Draft implementation PR, promotes it to Ready only
  after a clean cycle, and waits for its manual merge;
- repeats inspection after every child PR merge and completes only after all
  phases are done and the exact root PR is merged;
- delivers optional ntfy notifications;
- gives every interactive agent only its stage-specific MCP completion tool.

A workspace is OpenSpec-enabled when `openspec/config.yaml` exists at its root.

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Root branch** | Immutable workflow identity `change/<change-id>`. Stored as `changeBranch`. |
| **Active branch** | The branch currently used by planning, review, remediation, or tasks. Stored as `activeBranch`. |
| **Workflow** | A directed graph of typed steps with explicit transitions. |
| **Ledger** | The durable per-workspace lifecycle, history, public change, and internal checkpoint. |
| **Checkpoint** | The next step and validated workflow state used for retry and restart recovery. |

## Branch and PR graph

```text
main
  ^
  | Draft or existing-state root PR
change/<id>                         immutable during planning
  ^
  | Ready planning PR; manually merged
planning/<id>/initial               artifacts + review + finding fixes

For each phase N:

planning/<id>/phase-N
  | optional Ready task-planning PR
  v
change/<id>                         guarded fetch + fast-forward baseline
  ^
  | one implementation PR (Draft while cycling, then Ready)
implementation/<id>/phase-N/run-M  tasks and remediation for Phase N only

change/<id> -- root PR (Draft while work remains; Ready when complete) --> main
```

Task branches and per-task PRs are not created. Each implementation PR is
bounded to one phase. After every child PR merge, the local root is updated only
by guarded fetch and fast-forward, then `plan.md` and OpenSpec tasks are
re-inspected. The root PR remains manual and is the final merge gate.

## Architecture

```text
Paseo panel / composer
        |
        | typed RPC + long polling
        v
OrchestratorController
        |
        v
OpenSpec workflow assembly
        |
        v
OpenSpecOrchestratorEngine ---- reporter / ledger
        |
        v
Git, OpenSpec, GitHub CLI, scoped agents and MCP tools
```

The main boundaries are:

- `shared/`, `index.server.ts`, and `index.client.tsx` define the validated RPC
  and UI integration surface. The RPC contract is intentionally independent of
  branch-management details.
- `server/workflow/steps/index.ts` is the workflow composition root. Each step
  receives a smaller consumer-owned dependency contract.
- `server/openspec-orchestrator-engine.ts` handles lifecycle commands, explicit
  transitions, retry, pause, checkpoint recovery, and completion reporting.
- `server/agent-prompt.ts` composes every agent prompt from one role sentence,
  the stage parameters as explicitly untrusted JSON, the shared safety and scope
  rules, the stage contract, and one completion contract. A stage prompt states
  only what the invoked skill cannot know.
- `server/workflow/types.ts` defines durable state. Checkpoint version 5 stores
  known phase numbers, task fingerprints, planning and implementation runs, the
  monotonic run counter, root PR identity, and at most one pending
  external-effect session.
- `server/orchestrator-ledger.ts` persists data below
  `$PASEO_HOME/plugin-data/paseo-openspec-orchestrator/`. Checkpoints older than
  version 5 are not migrated. Their ledger remains read-only and available for
  explicit state clearing.
- `server/change-branch.ts` validates the root, planning, and implementation
  namespaces.
- `server/change-initialization.ts` owns `list/new/status --json`, scaffold
  commit recovery, root push, and root PR reconciliation.
- `server/planning-branch.ts` owns collision-free creation of the planning
  branch from the durable root baseline.
- `server/phase-work.ts` owns bounded phase-heading extraction from `plan.md`,
  task reconciliation, task fingerprints, and the typed phase decision.
- `server/phase-task-planning.ts` owns the Ultra
  `openspec-update-change` session and exact task-only commit verification.
- `server/root-pull-request.ts` owns guarded root synchronization and the final
  Draft/Ready/merged gate.
- `server/change-publication.ts` reads planning artifacts through an agent and
  pushes the planning branch; the orchestrator then replaces the title/body of
  the existing root PR without changing its Draft/Ready state.
- `server/github-pull-request-mutation.ts` is the single boundary for changing
  PR fields. It validates the target and payload, uses the REST update endpoint,
  and keeps agents and production paths away from `gh pr edit`.
- `server/change-review.ts` and `server/change-review-publication.ts` create one
  review commit on the planning branch and reconcile its Ready PR into the root
  branch.
- `server/review-finding-publication.ts` appends deterministic finding outcomes
  to that same planning PR.
- `server/planning-merge.ts` validates the PR state and performs the guarded
  return to the root branch.
- task modules own one independently verified task commit per iteration on the
  current phase implementation branch.
- implementation review, publication, feedback, and merge modules own the exact
  batch range, single Draft/Ready PR, bounded GraphQL feedback ingress, and
  guarded return to the root branch across GitHub merge, squash, and rebase
  strategies.

External JSON, Git refs, paths, repository identities, PR metadata, persisted
state, RPC payloads, and MCP inputs are validated before entering trusted code.
Commands are executed as argument arrays; repository text is never evaluated as
shell syntax.

## Default workflow

### Preflight and root initialization

The workflow first validates required Paseo profiles, the current branch, a
clean worktree, and the workspace mise toolchain. A run is accepted only from
the exact branch `change/<kebab-case-id>`. `main`, detached HEAD, arbitrary
feature branches, `planning/<id>`, and names with additional path segments halt
before OpenSpec or GitHub mutations.

The change ID is the branch suffix; no agent or UI chooses it. Initialization
uses the official machine-readable OpenSpec commands through
`mise exec --no-deps -- openspec`:

- `list --json` determines whether the change already exists;
- `new change <id> --json` creates only a missing scaffold;
- `status --change <id> --json` resolves the actual repo-local change root.

For a new change, every changed and staged path must remain inside that actual
root. The orchestrator creates one `docs(openspec): add <id> change` commit (or
the bounded fallback subject), pushes without force, and creates a Draft PR from
`change/<id>` to `main`. An existing open root PR is reused and retargeted to
`main` if required without changing Draft/Ready state. Recovery reconciles each
effect instead of repeating it.

### Planning and publication

Before the first artifact the orchestrator creates `planning/<id>/initial` exactly at
the saved root baseline. Outside recovery, any local ref, remote ref, or
historical PR with that head is a collision.

Artifacts are created in OpenSpec dependency order, one approved commit per
agent session. Completed planning is validated with `instructions apply
--json`. A Medium publication agent then reads the artifacts, drafts the
title and body, and pushes `planning/<id>/initial`. Its MCP completion passes
only that content; the orchestrator selects the saved root PR, updates it through
the shared REST gateway, and reads it back before accepting publication. The
agent does not invoke GitHub CLI, push the root branch, or create another root PR.

### Review, findings, and planning merge

Review stays on `planning/<id>/initial`. The review agent writes or materially updates
`review.md`, creates exactly one review commit, pushes it, and creates one Ready
PR from `planning/<id>/initial` to `change/<id>`. It never creates a `*-review` branch.

Before the planning merge, only `review.md` findings are resolved, one at a
time, on the planning branch. Their completion tools verify the report, commit,
remote head, Ready planning PR, and deterministic PR-body entry. Implementation
review does not run before implementation exists.

When findings are exhausted, the merge gate behaves as follows:

- `OPEN`: halt recoverably and instruct the user to merge the planning PR and
  press Retry;
- `CLOSED`: fail because the PR was closed without merge;
- `MERGED`: checkpoint the verified repository, refs, PR number, and planning
  head; require a clean tree; fetch the saved root branch; switch back to it;
  require the GitHub merge-result commit to be contained in the fetched root;
  and update it only with `git merge --ff-only` to that origin head. This
  supports merge commits, squash merges, and rebase merges without equating the
  source planning SHA with the post-merge root SHA.

The orchestrator revalidates the OpenSpec change after the switch and enters a
shared phase inspector. It reads bounded, regular, in-root `plan.md` and scans
recognizable `## Phase N...` heading lines while ignoring all other content and
silently deduplicating phase numbers. It maps tasks to phases by the first
segment of their `N.*` number. Missing tasks route to phase planning; unfinished
tasks route to implementation; only a fully planned and completed change reaches
the root gate.

For a phase without tasks, `planning/<id>/phase-N` is created from the current
root baseline. An Ultra agent is instructed directly to invoke
`openspec-update-change` for only that phase. One commit may append incomplete
`N.*` tasks while preserving the old task list as an exact prefix and leaving
`plan.md` and code unchanged. Publication and a focused
`openspec-review-change` follow; both finding resolvers run in order, with a
missing report or no recognizable `F<n>` finding headings treated as a no-op.
Review report structure is not validated. The final validation enforces the
preserved task history and target phase and rejects changes outside the task
files and two review reports before the manual planning merge.

### Implementation cycle and merge gate

`execute-change-tasks` selects the first unfinished task of the selected phase.
Before it starts, the orchestrator creates
`implementation/<id>/phase-N/run-M` exactly at the updated root baseline after
rejecting local refs, remote refs, and historical PRs with that head. The
durable `M` only increases. Each iteration gets one
High agent, one Conventional Commit, and one push; the agent cannot create a
branch or PR and does not receive PR metadata through `complete_change_task`.
Completion checks root immutability, repository identity, the exact task-state
transition, changed paths, commit count and subject, ancestry, and remote head.

When all current tasks are done, the collected non-empty batch is reviewed by
a High agent over its exact `base..head`. The report is the only file in
one review commit; the orchestrator does not validate its Markdown schema or
repeat the agent's coverage assessment. The first successful review creates one
Draft PR from the current implementation run to
`change/<id>`; later cycles reuse it. Its managed Russian summary is updated
without replacing user-authored text or the managed finding-results section.

After every batch review, the orchestrator scans only `F<n>` heading lines from
`review.md` first and `implementation-review.md` second, on the Draft
implementation PR. Other report content is ignored. An originating `F<n>`
reference inside an accepted-risk entry is read only to preserve the published
resolution outcome.
The batch baseline is then reset at the current head and task execution starts
again, so remediation can add tracked tasks and each new batch receives its own
bounded review.

With no tasks or findings, the orchestrator reads all ordinary PR comments,
non-empty submitted review summaries, and unresolved review-thread comments
through paginated GitHub GraphQL. Bodies are bounded untrusted JSON data. A
High feedback agent has no GitHub responsibility and may add a finding
only after independently proving it against the fixed cumulative implementation
range.
Processed fingerprints include GraphQL node ID and `updatedAt`, so edits are
audited again while rejected feedback is not repeatedly reviewed.

A clean Draft PR is atomically promoted to Ready and checked again for racing
feedback. The Ready gate halts until Retry. Retry gives merge status priority,
returns the PR to Draft when new feedback exists, halts again when it remains
open and clean, and rejects a closed unmerged PR. After merge, the same PR and
final implementation head are verified. The GitHub-reported merge-result commit
must be contained in the fetched `change/<id>` head, so merge commits, squash
merges, and rebase merges are accepted without assuming that the source commit
SHA survives. The local root is then updated with `git merge --ff-only
FETCH_HEAD`. The run is cleared and the shared phase inspector executes again
instead of completing the workflow.

When every phase has tasks and all tasks are done, the exact non-fork root PR
`change/<id> -> main` is promoted to Ready. The orchestrator repeats the root
head and phase/task checks to close races, then halts for manual merge. Retry
repeats the same guarded synchronization and inspection. An open PR waits, a
closed unmerged PR fails, and a merged PR with the exact final head is the only
successful terminal state. A root merge while work remains fails closed.

## Recovery and operations

Every mutating stage stores a pending version 5 session before external effects.
Recovery accepts only known intermediate states and verifies already-created
commits, pushes, refs, and PRs. It never force-pushes, resets, reopens a closed
PR, or silently switches from an unrelated branch.

Ending an agent turn does not end its workflow step. The MCP scope and
`ntfy=true` remain active until the completion tool succeeds or the run is
cancelled. The “Clear state” command removes history and the checkpoint; the
next run must again start from `change/<id>`.

## Extending the workflow

Detailed instructions for defining state, implementing a step, registering its
transitions, and handling cancellation are in
[`server/workflow/README.md`](server/workflow/README.md).

A new step belongs in `server/workflow/steps/`, implements the typed contract
from `server/workflow/types.ts`, and is registered in the central composition
root. State that must survive a restart must also be represented in the Zod
workflow state schema. External effects must be idempotent or explicitly
reconcilable.

## Development

The project targets Node.js 22 and requires Paseo 0.8.0 or newer. The repository
includes `mise.toml` for the expected toolchain.

```sh
mise install
npm ci
npm run typecheck
npm test
```

Use this README for repository-level orientation. For exact contracts and
behavior, read the schemas, implementation, and tests together.
