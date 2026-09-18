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
- creates `planning/<change-id>` from the saved root baseline and keeps all
  artifacts, review output, and finding remediations on that branch;
- updates the root PR description from completed planning artifacts while
  preserving its existing Draft/Ready state;
- creates one Ready PR from `planning/<change-id>` to `change/<change-id>` and
  waits for its manual merge;
- returns to the saved root branch through fetch and fast-forward before
  executing OpenSpec implementation tasks;
- executes unfinished tasks one at a time on stacked task branches and PRs;
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
planning/<id>                       artifacts + review + finding fixes

After the planning PR is merged:

main
  ^
  | root PR
change/<id>                         fast-forwarded from origin
  ^
  | first task PR
<id>-task-1
  ^
  | next task PR
<id>-task-2 ...
```

Task PRs are merged from the last task back toward `change/<id>`. The root PR is
merged to `main` after the task stack has been integrated.

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
- `server/workflow/types.ts` defines durable state. Checkpoint version 3 stores
  `changeBranch` separately from `activeBranch` and allows only one pending
  external-effect session at a time.
- `server/orchestrator-ledger.ts` persists data below
  `$PASEO_HOME/plugin-data/paseo-openspec-orchestrator/`. A version 2 checkpoint
  is not migrated because it cannot reconstruct the root branch safely. Its
  ledger remains read-only and available for explicit state clearing.
- `server/change-branch.ts` validates the root and planning namespaces.
- `server/change-initialization.ts` owns `list/new/status --json`, scaffold
  commit recovery, root push, and root PR reconciliation.
- `server/planning-branch.ts` owns collision-free creation of the planning
  branch from the durable root baseline.
- `server/change-publication.ts` reads planning artifacts through an agent,
  pushes the planning branch, and replaces the title/body of the existing root
  PR without changing its Draft/Ready state.
- `server/change-review.ts` and `server/change-review-publication.ts` create one
  review commit on the planning branch and reconcile its Ready PR into the root
  branch.
- `server/review-finding-publication.ts` appends deterministic finding outcomes
  to that same planning PR.
- `server/planning-merge.ts` validates the PR state and performs the guarded
  return to the root branch.
- task modules own one independently verified task commit and Ready PR per
  iteration.

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

Before the first artifact the orchestrator creates `planning/<id>` exactly at
the saved root baseline. Outside recovery, any local ref, remote ref, or
historical PR with that head is a collision.

Artifacts are created in OpenSpec dependency order, one approved commit per
agent session. Completed planning is validated with `instructions apply
--json`. A Medium Sandbox publication agent then reads the artifacts, pushes
`planning/<id>`, and replaces the title and body of the existing root PR. It
does not push the root branch or create another root PR.

### Review, findings, and planning merge

Review stays on `planning/<id>`. The review agent writes or materially updates
`review.md`, creates exactly one review commit, pushes it, and creates one Ready
PR from `planning/<id>` to `change/<id>`. It never creates a `*-review` branch.

Review and implementation-review findings are resolved one at a time through
additional commits on the same planning branch. Their completion tools verify
the report, commit, remote head, Ready planning PR, and deterministic PR-body
entry. A retry can acknowledge an already published outcome without duplicating
it.

When findings are exhausted, the merge gate behaves as follows:

- `OPEN`: halt recoverably and instruct the user to merge the planning PR and
  press Retry;
- `CLOSED`: fail because the PR was closed without merge;
- `MERGED`: checkpoint the verified repository, refs, PR number, and planning
  head; require a clean tree; fetch the saved root branch; switch back to it;
  and update it only with `git merge --ff-only` to the fetched origin head.

The orchestrator revalidates the OpenSpec change after the switch and records
the root as the active branch before starting tasks.

### Implementation tasks

`execute-change-tasks` selects the first unfinished task returned by OpenSpec.
The first task is based on the updated `change/<id>` root; every later task is
based on the previous task branch. Each iteration gets one High Sandbox agent,
one conventional commit, one push, and one Ready non-fork PR. Completion checks
parent immutability, task-state changes, local/remote heads, commit count and
subject, and exact GitHub metadata before advancing the stack.

## Recovery and operations

Every mutating stage stores a pending version 3 session before external effects.
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
