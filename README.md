# Paseo OpenSpec Orchestrator

`paseo-openspec-orchestrator` is a [Paseo](https://github.com/getpaseo/paseo)
plugin that runs a resumable OpenSpec development workflow inside a Paseo
workspace. It provides lifecycle controls, durable progress, recovery after
plugin restarts, and scoped agent sessions.

The source code and tests are the authority for detailed behavior.

## Workflow at a glance

The exact branch `change/<change-id>` identifies the OpenSpec change and is
the only branch used by the workflow. The orchestrator creates or reuses one
root pull request from that branch to `main`. It remains Draft while work is
in progress. Planning artifacts, phase tasks, implementation, review reports,
and finding resolutions are committed to the same branch. The orchestrator
publishes each verified commit without force pushing or automatically merging
the pull request.

```text
main
  ^
  | one root PR: Draft during work, Ready after all checks, manual merge
change/<id>
  | scaffold and planning artifact commits
  | initial OpenSpec review and finding resolutions
  | for each phase: task planning, task commits, bounded reviews, resolutions
```

The workflow stops at the final root PR until the user merges it and presses
Retry. It does not create planning, implementation, review, or per-task pull
requests. Pull request comments and submitted reviews are not ingested as
workflow input.

Agents still request the decisions required by their stage prompts and skills.
In particular, planning artifact approval and decisions about review findings
remain interactive. The orchestrator itself no longer adds a manual merge gate
between planning and implementation stages.

## Core concepts and architecture

| Concept | Meaning |
| --- | --- |
| **Root branch** | Workflow identity `change/<change-id>`; every stage uses it. |
| **Workflow** | A directed graph of typed steps with explicit transitions. |
| **Ledger** | Durable per-workspace lifecycle, history, public change, and checkpoint. |
| **Checkpoint** | Next step and validated state used for retry and restart recovery. |
| **Run baseline** | Saved commit anchoring one planning phase or implementation review range. |

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

The UI and RPC integration lives in `shared/`, `index.server.ts`, and
`index.client.tsx`. The workflow composition root is
`server/workflow/steps/index.ts`; the engine owns transitions, pause, Retry,
and checkpoint recovery. Each stage receives a small dependency contract.
The workflow state in `server/workflow/types.ts` is validated before it is
persisted. Checkpoint version 6 supports the single-branch workflow. Earlier
checkpoints are not migrated: their ledger is preserved read-only until
explicit state clearing. Complete active version 5 changes with the previous
plugin before upgrading, or restart them manually.

The root PR service validates repository identity, branch, base, head, Draft
state, and final merge state. `server/root-branch-delivery.ts` publishes a
stage's verified commit only when the remote head is the saved baseline or
the already published commit, and the exact root PR is still open and Draft.
Unexpected branch movement halts the workflow. The GitHub REST mutation
gateway owns PR title and body updates. The generated summary and finding
outcomes occupy managed body sections so later updates preserve other text.

External JSON, Git refs, paths, repository identities, PR metadata, persisted
state, RPC payloads, and MCP inputs are validated before entering trusted
code. Commands are executed as argument arrays; repository text is never
evaluated as shell syntax.

## Default workflow

### Preflight and initialization

The workflow checks the required Paseo profiles, the exact
`change/<kebab-case-id>` branch, a clean worktree, and the workspace mise
toolchain. The change ID comes from the branch, not from an agent or the UI.
Initialization uses `mise exec --no-deps -- openspec` with machine-readable
`list --json`, `new change <id> --json`, and `status --change <id> --json`.
A missing scaffold receives one bounded commit and push, followed by a Draft
root PR to `main`. An existing matching root PR is reused.

### Planning and reviews

Planning artifacts are created in OpenSpec dependency order, one approved
commit per agent session. A publication agent reads the finished artifacts and
drafts a Russian root PR title and description. The orchestrator verifies and
pushes the commits, then updates the managed summary section without changing
Draft/Ready state.

An OpenSpec review agent creates one review commit. Findings from `review.md`
are resolved one at a time after an explicit user decision. The orchestrator
verifies and pushes each commit and records its outcome in the managed findings
section of the same root PR.

The phase inspector reads bounded `plan.md` headings and OpenSpec task
snapshots. A phase without tasks enters focused task planning. Its agent adds
only incomplete tasks for that phase, followed by publication, OpenSpec review,
finding resolution, and validation of changed paths and preserved task
history. The next phase decision is made directly on the root branch.

### Implementation

Each implementation run covers one phase. Tasks execute sequentially with one
High agent and one Conventional Commit per task. A nonempty batch of task
commits is reviewed over its exact saved commit range. The report is a separate
commit in `implementation-review.md`. Both review reports are checked for
findings; remediation may add new incomplete tasks, which form another
independently reviewed batch.

Agents do not push task, review, or finding commits themselves. Their scoped
MCP completion tools verify the stage contract, then the orchestrator
publishes the commit to `change/<id>`. Recovery accepts a verified local
commit before push and an already published commit before checkpoint, without
repeating the agent's work. The existing root PR is the only pull request
associated with every stage.

### Final root PR gate

When every phase has tasks and all tasks are complete, the root PR moves to
Ready. The orchestrator repeats phase, task, and PR head checks to close races,
then waits for manual merge and Retry. A closed unmerged PR fails. A merge
while work remains fails closed. Only a merged PR with the exact final head
and completed phase work ends the workflow. New work found on Retry returns
the PR to Draft and resumes the relevant phase.

## Recovery and development

Stages that create commits save a pending session before agent work.
Recovery verifies files, commits, refs, pushes, PR identity, and managed PR
body entries. It never force pushes, resets, reopens a closed PR, or silently
switches branches. Ending an agent turn does not end its stage; the scoped MCP
completion tool must succeed or the run must be cancelled.

A workspace is OpenSpec-enabled when `openspec/config.yaml` exists at its
root. Detailed instructions for adding a workflow step are in
[`server/workflow/README.md`](server/workflow/README.md).

The project targets Node.js 22 and Paseo 0.8.0 or newer:

```sh
mise install
npm ci
npm run typecheck
npm test
```
