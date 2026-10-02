# Paseo OpenSpec Orchestrator

`paseo-openspec-orchestrator` is a [Paseo](https://github.com/getpaseo/paseo)
plugin that runs a resumable OpenSpec development workflow inside a Paseo
workspace. It provides lifecycle controls, durable progress, recovery after
plugin restarts, scoped agent sessions, and reconciliation with changes the
user makes in the repository while the workflow is in progress.

The source code and tests are the authority for detailed behavior.

## Workflow at a glance

The exact branch `change/<change-id>` identifies the OpenSpec change and is
the only branch used by the workflow. The orchestrator creates or reuses one
root pull request from that branch to `main`. It remains Draft while work is
in progress. Planning artifacts, phase tasks, implementation, review reports,
and finding resolutions are committed to the same branch. The orchestrator
publishes each verified commit range without force pushing or automatically merging
the pull request.

```text
main
  ^
  | one root PR: Draft during work, Ready after all checks, manual merge
change/<id>
  | scaffold and planning artifact commits
  | initial OpenSpec review and finding resolutions
  | for each phase: task planning, task commits, bounded reviews, resolutions
  | final spec synchronization and archive commits
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
| **Reconciliation** | Before every step, the checkpoint is brought in line with the repository. |

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
stage's verified commit range as a fast-forward: origin may point to any
ancestor of the verified head, and the exact root PR must still be open and
Draft. Origin is never rewritten. The GitHub REST mutation
gateway owns PR title and body updates. The generated summary and finding
outcomes occupy managed body sections so later updates preserve other text.

The repository is the source of truth; the checkpoint records the workflow
position and the baselines that verify one agent stage. Before every step,
`server/workflow/reconciliation.ts` compares the checkpoint with the
repository and adopts what the user changed outside a stage instead of
halting. See [Reconciliation with the repository](#reconciliation-with-the-repository).

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
A missing scaffold receives a bounded commit and push, followed by a Draft
root PR to `main`. An existing matching root PR is reused.

### Planning and reviews

Planning artifacts are created in OpenSpec dependency order, with at least one
approved commit per agent session. A publication agent reads the finished artifacts and
drafts a Russian root PR title and description. The orchestrator verifies and
pushes the commits, then updates the managed summary section without changing
Draft/Ready state.

An OpenSpec review agent may correct code and artifacts according to its review
skill, then commits the added or updated `review.md` together with all stage
changes. Remaining findings are resolved one at a time after an explicit user
decision. The orchestrator verifies and pushes each commit range and records
finding outcomes in the managed findings section of the same root PR.

The phase inspector reads bounded `plan.md` headings and OpenSpec task
snapshots. A phase without tasks enters focused task planning. Its agent adds
only incomplete tasks for that phase, followed by publication, OpenSpec review,
finding resolution, and validation of preserved task history. The task-planning
agent itself may change only task artifacts; its subsequent review may also
correct code and other artifacts. The next phase decision is made directly on
the root branch.

The orchestrator executes the incomplete tasks of a phase one at a time,
strictly in file order; it does not read dependencies or ordering notes. Until
a phase starts running, planning-stage reviews and finding resolutions
therefore insert, reorder, and renumber its incomplete tasks so that file order
is execution order. Completed tasks always stay unchanged.

Only focused task planning fills a phase that has no tasks. Every review and
finding-resolution agent is told which phases it may extend, and its
completion tool rejects other task additions before any commit is published.
Before the initial OpenSpec review, the orchestrator records which phases
already have tasks. Until the first phase inspection, reviews and findings may
add tasks only to those phases. During task planning of a phase, they may add
tasks only to that phase. Work that belongs to a phase without tasks is
described in that phase of `plan.md`.

### Implementation

Each implementation run covers one phase. Tasks execute sequentially with one
High agent and at least one commit per task. A nonempty batch is reviewed over
its commit range from the batch baseline to the reviewed head. The range
includes every commit of each task and every commit the user added in between;
a task completed outside a task session joins the batch without a commit
boundary. The review agent may correct code and artifacts, verifies those
corrections in the same session, and commits them with the added or updated
`implementation-review.md`. The review range of a running review session stays
fixed. Both review reports are checked for remaining findings; remediation may
add new incomplete tasks, which form another independently reviewed batch.
Review preserves known task IDs, numbers, descriptions, and order; completed
tasks stay complete and new tasks start incomplete.

New tasks belong to the run's phase. When follow-up work needs its own phase,
the agent inserts a new phase right after the current one in `plan.md`, gives
it a number greater than every existing phase number, and fills it with tasks.
The orchestrator runs that phase after the current one. Implementation reviews
and findings never add tasks to other existing phases, so a phase without
tasks is still planned by the orchestrator. The orchestrator checks this rule
again before it saves the run's task progress.

Agents do not push task, review, or finding commits themselves. Their scoped
MCP completion tools verify the stage contract, then the orchestrator
publishes the commits to `change/<id>`. A stage needs at least one new commit;
additional commits and their messages do not gate completion. Recovery accepts a verified
local commit range before push and an already published range before checkpoint, without
repeating the agent's work. An interrupted implementation review with correction
commits but no added or updated report resumes its review work; a verified report
with corrections is reused before or after push. The existing root PR is the
only pull request associated with every stage.

After all phases and review findings are complete, one High agent invokes the
`openspec-archive-change` skill. It synchronizes every delta spec with the main
specs, moves the unchanged change directory into the dated archive, and creates
one or more verified commits on the root branch. Incomplete artifacts or tasks and a
failed spec sync stop this stage. The orchestrator publishes the archive commits
to the Draft root PR and can recover after an interrupted move, commit, or push.

### Final root PR gate

When every phase has tasks and all tasks are complete, the orchestrator checks
the active change once more before archiving. A previously Ready PR returns to
Draft for the archive commit. After publication, the final gate checks the
archived tree and the exact PR head, moves the PR to Ready, then waits for
manual merge and Retry. It no longer reads tasks from the archived change.
Commits added after the archive commit and a history rewritten before the
merge are accepted while the change stays in the archive. A closed unmerged PR
stops the workflow. A PR already merged before the archive commit also stops:
its history cannot be changed retroactively.

## Reconciliation with the repository

The user may change the repository on purpose while the workflow is in
progress: add commits, rewrite commits, or restructure the task list. Such a
change must never leave the workflow in a state that only editing the ledger
can fix. Before every step the orchestrator therefore reconciles the
checkpoint with the repository and records what it adopted as its own action
in the history:

- **Unpublished commits.** When origin is an ancestor of the local branch, the
  commits are published as a fast-forward before a step that plans from the
  published head.
- **Task list.** A task list that no longer continues the saved baseline is
  adopted as the new baseline. Reordered, renumbered, reworded, added, removed,
  reopened, and manually completed tasks are taken from the repository.
- **Pending session.** A session stays resumable while its stage can still be
  completed by it: the stage has not started, was interrupted with unfinished
  agent work, or its result already verifies. A session that can never be
  completed is dropped and its stage is planned again from the current head.
  That is the case when its baseline left the history or when commits the
  stage cannot accept appeared after the baseline.
- **Run anchors.** Without a resumable session, an open implementation batch
  is extended to the current head, keeps the tasks completed since its
  baseline, and moves a baseline that left the history to the nearest common
  ancestor. Commits made outside task sessions stay inside the next review
  range. A reviewed batch is the record of its review and is left as is: it
  only waits for its findings, and the next batch starts from the head they
  end on.
- **Routing.** When the adopted state calls for different work, the workflow
  moves to the step that matches it, for example from review back to task
  execution after a task was reopened, or from an interrupted review step to
  the findings of a batch whose review had already been saved.
- **Archive.** When the change is already in the archive but the archive
  session cannot verify its commit range, because the history was rewritten or
  commits outside the stage landed in it, the archive is adopted from the
  repository without an agent and the workflow moves to the final gate.

Two guarantees do not change. A running stage is still verified strictly
against its own baseline by its completion tool, so an agent cannot widen its
contract. And origin is never rewritten: when the local branch is behind
origin or its history was rewritten, the workflow stops and names the command
to run (`git pull --ff-only` or `git push --force-with-lease`); Retry then
adopts the result. Uncommitted changes and a foreign branch stop the step with
the same kind of message.

Commits added between the reviewed head of a batch and the start of the next
batch, that is while the batch is being reviewed and its findings are being
resolved, are adopted but belong to no implementation review range. The same
already holds for the corrections the review agent commits itself.

A stage that is stuck because the repository changed under it ends when the
plugin is reloaded; the next Start reconciles and plans the stage again.

## Recovery and development

Stages that create commits save a pending session before agent work.
Recovery verifies files, commit ranges, refs, pushes, PR identity, and managed PR
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
