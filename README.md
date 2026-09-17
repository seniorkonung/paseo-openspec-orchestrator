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
  `complete_artifact` to each artifact-creation agent. A tool from one session
  is not shared with another session.
- `server/change-artifact-creation.ts` is the boundary around OpenSpec planning
  status, repository path validation, per-artifact Git verification, agent
  sessions, and the `complete_artifact` MCP contract.

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

After the checks, a `Medium Sandbox` agent is added to the same Paseo workspace,
where it lists the active repo-local OpenSpec changes and asks the user to select
one or create a new scaffold. The agent and the scoped `set_change` tool run
OpenSpec as `mise exec --no-deps -- openspec ...` from that workspace. A newly
created change must be committed before the agent can select it. The tool reads
the actual `changeRoot` from `openspec status --json`, validates its workspace
and repository boundaries, repository cleanliness, and presence in `HEAD`
before recording the choice.

The selection step then reads the schema-defined artifact graph from
`openspec status --json`. If planning is already complete, the workflow checks
`openspec instructions apply --json` and finishes. Otherwise it enters the
`create-change-artifacts` step. That step loops back to itself, always choosing
the first `ready` artifact in OpenSpec's dependency order; it does not assume
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

The completion tool independently requires a clean worktree, exactly one commit
after the saved baseline, and no changed paths outside the expected artifact.
It disables the agent's final ntfy notification and clears the pending session
checkpoint before acknowledging success. A restart before that acknowledgement
resumes the same artifact; a restart after it advances from the durable cleared
checkpoint. Agent placement and live command discovery use the documented
[Paseo workspace agent](https://paseo.sh/docs/sdk/workspaces#start-an-agent-in-a-workspace)
and [agent command catalog](https://paseo.sh/docs/sdk/agents#list-the-commands-a-session-loaded)
APIs. Implementation work remains outside the current workflow endpoint.

## Extending the workflow

Detailed instructions for defining state, implementing a step, registering its
transitions, and handling cancellation are in
[`server/workflow/README.md`](server/workflow/README.md).

At a high level, a new step belongs in `server/workflow/steps/`, implements the
typed step contract from `server/workflow/types.ts`, and is added to the central
step registry. Any state that must survive a restart must also be represented in
the workflow state schema. Steps that perform external or mutating work must be
idempotent or be able to detect an already completed result, because execution
may resume from a checkpoint or restart after a retry.

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
