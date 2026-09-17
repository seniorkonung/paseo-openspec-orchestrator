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
- delivering optional workflow notifications through ntfy;
- providing infrastructure for future workflow steps that delegate work to
  Paseo agents through scoped MCP tools.

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
  used to attach orchestrator-owned tools to Paseo agents. It is infrastructure
  for agent-driven workflow steps and is not yet part of the default workflow.

The shared Zod schemas are runtime boundaries as well as TypeScript contracts.
Persisted data, RPC payloads, workflow state, and tool results must be validated
before they enter trusted orchestration code.

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
