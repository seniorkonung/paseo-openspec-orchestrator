/** Ошибка освобождения ресурсов блокирует следующий этап до повторной очистки. */
export class AgentCleanupError extends AggregateError {
  readonly code = "AGENT_CLEANUP_FAILED";

  constructor(message: string, errors: readonly unknown[] = []) {
    super(errors, message);
    this.name = "AgentCleanupError";
  }
}

/** Сохраняет вложенные причины, ограничивая размер диагностического сообщения. */
export function cleanupFailureReason(error: unknown, depth = 0): string {
  if (depth < 8 && error instanceof AggregateError && error.errors.length > 0) {
    return cleanupFailureReason(error.errors[0], depth + 1);
  }
  if (depth < 8 && error instanceof Error && error.cause !== undefined) {
    return cleanupFailureReason(error.cause, depth + 1);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export interface CleanupErrorDetails {
  readonly message: string;
  readonly code?: string;
  readonly errors?: readonly CleanupErrorDetails[];
}

export function cleanupErrorDetails(error: unknown, depth = 0): CleanupErrorDetails {
  return {
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    ...(error instanceof Error && "code" in error ? { code: String(error.code) } : {}),
    ...(depth < 4 && error instanceof AggregateError
      ? { errors: error.errors.slice(0, 8).map((nested: unknown) => cleanupErrorDetails(nested, depth + 1)) }
      : depth < 4 && error instanceof Error && error.cause !== undefined
        ? { errors: [cleanupErrorDetails(error.cause, depth + 1)] }
        : {}),
  };
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
