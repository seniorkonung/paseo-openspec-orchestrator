export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export interface SerializedExecutor {
  <Value>(operation: () => Promise<Value>): Promise<Value>;
}

export function abortError(): Error {
  const error = new Error("Операция отменена");
  error.name = "AbortError";
  return error;
}

export function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function waitForPromise<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function combineAbortSignals(
  first: AbortSignal,
  second: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", abort);
      second.removeEventListener("abort", abort);
    },
  };
}

export function createSerializedExecutor(): SerializedExecutor {
  let queue: Promise<void> = Promise.resolve();
  return <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
