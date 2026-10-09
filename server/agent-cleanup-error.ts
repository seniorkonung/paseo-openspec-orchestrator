/** Ошибка освобождения ресурсов блокирует следующий этап до повторной очистки. */
export class AgentCleanupError extends AggregateError {
  readonly code = "AGENT_CLEANUP_FAILED";

  constructor(message: string, errors: readonly unknown[] = []) {
    super(errors, message);
    this.name = "AgentCleanupError";
  }
}

/** Срок очистки не зависит от отменённого сигнала workflow. */
export async function withCleanupDeadline<Value>(
  operation: () => Promise<Value>,
  timeoutMs = 20_000,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentCleanupError("Истёк срок очистки ресурсов агента")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
