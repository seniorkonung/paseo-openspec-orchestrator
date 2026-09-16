import { randomUUID } from "node:crypto";
import {
  agentLinkSchema,
  currentActionSchema,
  lifecycleSchema,
  orchestratorChangeSchema,
  type AgentLink,
  type CurrentAction,
  type OrchestratorChange,
  type OrchestratorLifecycle,
} from "../shared/orchestrator.ts";
import { OrchestratorLedger } from "./orchestrator-ledger.ts";

export interface BeginActionInput {
  text: string;
  links?: AgentLink[];
}

export interface UpdateActionInput {
  text?: string;
  links?: AgentLink[];
}

export interface ActionHandle {
  readonly id: string;
  update(input: UpdateActionInput): void;
  succeed(): void;
  fail(): void;
  cancel(): void;
}

export interface OrchestratorReporterOptions {
  now?: () => Date;
  createId?: () => string;
}

export class OrchestratorReporter {
  readonly #ledger: OrchestratorLedger;
  readonly #workspaceId: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(
    ledger: OrchestratorLedger,
    workspaceId: string,
    options: OrchestratorReporterOptions = {},
  ) {
    this.#ledger = ledger;
    this.#workspaceId = workspaceId;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  setChange(change: OrchestratorChange | null): void {
    const validatedChange = change === null ? null : orchestratorChangeSchema.parse(change);
    this.#ledger.update(this.#workspaceId, (projection) => ({
      ...projection,
      change: validatedChange,
    }));
  }

  setLifecycle(lifecycle: OrchestratorLifecycle): void {
    const validatedLifecycle = lifecycleSchema.parse(lifecycle);
    this.#ledger.update(this.#workspaceId, (projection) => ({
      ...projection,
      lifecycle: validatedLifecycle,
    }));
  }

  beginAction(input: BeginActionInput): ActionHandle {
    const action = currentActionSchema.parse({
      id: this.#createId(),
      text: input.text,
      startedAt: this.#now().toISOString(),
      links: (input.links ?? []).map((link) => agentLinkSchema.parse(link)),
    });

    this.#ledger.update(this.#workspaceId, (projection) => {
      if (projection.currentAction) {
        throw new Error("Нельзя начать новое действие, пока текущее не завершено");
      }
      return { ...projection, currentAction: action };
    });

    return new LedgerActionHandle(
      this.#ledger,
      this.#workspaceId,
      action,
      this.#now,
    );
  }

  async runAction<T>(input: BeginActionInput, operation: () => Promise<T>): Promise<T> {
    const handle = this.beginAction(input);
    try {
      const result = await operation();
      handle.succeed();
      return result;
    } catch (error) {
      handle.fail();
      throw error;
    }
  }
}

class LedgerActionHandle implements ActionHandle {
  readonly id: string;
  readonly #ledger: OrchestratorLedger;
  readonly #workspaceId: string;
  readonly #startedAt: string;
  readonly #now: () => Date;
  #finished = false;

  constructor(
    ledger: OrchestratorLedger,
    workspaceId: string,
    action: CurrentAction,
    now: () => Date,
  ) {
    this.id = action.id;
    this.#ledger = ledger;
    this.#workspaceId = workspaceId;
    this.#startedAt = action.startedAt;
    this.#now = now;
  }

  update(input: UpdateActionInput): void {
    this.#assertOpen();
    this.#ledger.update(this.#workspaceId, (projection) => {
      const current = this.#requireCurrent(projection.currentAction);
      return {
        ...projection,
        currentAction: currentActionSchema.parse({
          ...current,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.links === undefined ? {} : { links: input.links }),
        }),
      };
    });
  }

  succeed(): void {
    this.#finish("succeeded");
  }

  fail(): void {
    this.#finish("failed");
  }

  cancel(): void {
    this.#finish("cancelled");
  }

  #finish(outcome: "succeeded" | "failed" | "cancelled"): void {
    this.#assertOpen();
    this.#ledger.update(this.#workspaceId, (projection) => {
      const current = this.#requireCurrent(projection.currentAction);
      const finishedAt = new Date(
        Math.max(this.#now().getTime(), Date.parse(this.#startedAt)),
      ).toISOString();
      return {
        ...projection,
        currentAction: null,
        history: [...projection.history, { ...current, finishedAt, outcome }],
      };
    });
    this.#finished = true;
  }

  #assertOpen(): void {
    if (this.#finished) {
      throw new Error("Действие уже завершено");
    }
  }

  #requireCurrent(currentAction: CurrentAction | null): CurrentAction {
    if (!currentAction || currentAction.id !== this.id) {
      throw new Error("Текущее действие больше не принадлежит этому handle");
    }
    return currentAction;
  }
}

export function createOrchestratorReporter(
  ledger: OrchestratorLedger,
  workspaceId: string,
  options?: OrchestratorReporterOptions,
): OrchestratorReporter {
  return new OrchestratorReporter(ledger, workspaceId, options);
}

export async function runAction<T>(
  reporter: OrchestratorReporter,
  input: BeginActionInput,
  operation: () => Promise<T>,
): Promise<T> {
  return reporter.runAction(input, operation);
}
