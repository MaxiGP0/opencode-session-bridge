import { requestSignal } from "./wait.ts"
import type { PluginContext, ToolExecuteContext } from "./types.ts"

/**
 * Marker used to let host permission denials escape the tool wrapper. A denied
 * `ctx.permission.assert` must surface as a Tool.Error, never as normal content.
 */
export class PermissionDenied extends Error {
  constructor(readonly cause: unknown) {
    super("Permission denied by the host")
    this.name = "PermissionDenied"
  }
}

export function signalOf(context: ToolExecuteContext): AbortSignal {
  return context.signal ?? new AbortController().signal
}

export function abortError(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted", "AbortError")
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

export async function withRequest<T>(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal)
  const request = requestSignal(signal, timeoutMs)
  try {
    const result = await fn(request.signal)
    // A host abort must never be reported as a successful tool result, even
    // if the underlying client ignored the signal.
    throwIfAborted(signal)
    // A per-request timeout is an ordinary structured error, not a host abort.
    if (request.signal.aborted && !signal.aborted) {
      throw request.signal.reason ?? new DOMException("Request timed out", "TimeoutError")
    }
    return result
  } finally {
    request.cleanup()
  }
}

export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(abortError(signal)))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

/**
 * Evaluates the host's permission rules before a dangerous action. The marker
 * error is rethrown by the tool wrapper so `deny` and rejected `ask` responses
 * are visible to the caller instead of becoming a successful report.
 */
export async function assertPermission(
  ctx: Pick<PluginContext, "permission">,
  context: ToolExecuteContext,
  action: string,
  resources: string[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (typeof ctx.permission.assert !== "function") return
  const source =
    context.messageID && context.id
      ? { type: "tool" as const, messageID: context.messageID, id: context.id }
      : undefined
  try {
    await ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      action,
      resources,
      metadata,
      source,
    })
  } catch (error) {
    throw new PermissionDenied(error)
  }
}
