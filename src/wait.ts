import { formatError } from "./format.ts"
import type {
  MessageLike,
  PermissionLike,
  ProgressInfo,
  SessionEventLike,
  TurnResult,
  TurnState,
  WaitContext,
} from "./types.ts"

const EVENT_TYPES = [
  "session.idle",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
] as const

const MAX_CONSECUTIVE_ERRORS = 5
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 500
const DEFAULT_MAX_POLL_MS = 2_000
const DEFAULT_PERMISSION_POLL_MS = 1_500
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000

export type WaitOptions = {
  sessionID: string
  anchorID?: string
  promptText?: string
  admittedAt?: number
  timeoutMs: number
  signal?: AbortSignal
  initialMessages?: MessageLike[]
  initialFetchCount?: number
  requireAnchor?: boolean
  promptMessageID?: string
  pollIntervalMs?: number
  maxPollIntervalMs?: number
  permissionPollMs?: number
  requestTimeoutMs?: number
  progressIntervalMs?: number
  onProgress?: (info: ProgressInfo) => void
}

export type RequestSignal = {
  signal: AbortSignal
  cleanup: () => void
}

/**
 * Combines a parent signal with a per-request timeout. The timer and listener
 * are always cleaned up by the caller.
 */
export function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): RequestSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener("abort", onAbort, { once: true })
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new DOMException("Request timed out", "TimeoutError"))
        }, timeoutMs)
      : undefined

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

/**
 * Cancellable sleep. Resolves true when the time elapsed, false when the
 * signal was aborted. No timer survives a resolution.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(false)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function settleWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

async function fetchContext(
  ctx: WaitContext,
  sessionID: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<MessageLike[]> {
  const request = requestSignal(signal, timeoutMs)
  try {
    return await ctx.session.context({ sessionID }, { signal: request.signal })
  } finally {
    request.cleanup()
  }
}

async function listPermissions(
  ctx: WaitContext,
  sessionID: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PermissionLike[]> {
  const request = requestSignal(signal, timeoutMs)
  try {
    return await ctx.permission.list({ sessionID }, { signal: request.signal })
  } finally {
    request.cleanup()
  }
}

type Evaluation = {
  done: boolean
  startIndex: number
  idle?: MessageLike
  anchorFound: boolean
}

function isRelevant(message: MessageLike | undefined): boolean {
  return message?.type === "user" || message?.type === "assistant" || message?.type === "compaction"
}

function evaluateTurn(messages: MessageLike[], options: WaitOptions): Evaluation {
  const requireAnchor = options.requireAnchor ?? Boolean(options.anchorID)
  let anchorIndex = options.anchorID
    ? messages.findIndex((message) => message.id === options.anchorID)
    : -1

  if (anchorIndex < 0 && options.promptText && options.admittedAt !== undefined) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (
        message.type === "user" &&
        message.text === options.promptText &&
        (message.time?.created ?? 0) >= options.admittedAt
      ) {
        anchorIndex = index
        break
      }
    }
  }

  if (anchorIndex >= 0) {
    for (let index = anchorIndex + 1; index < messages.length; index++) {
      if (messages[index]?.type === "idle") {
        return { done: true, startIndex: anchorIndex, idle: messages[index], anchorFound: true }
      }
    }
    return { done: false, startIndex: anchorIndex, anchorFound: true }
  }

  let lastRelevant = -1
  for (let index = 0; index < messages.length; index++) {
    if (isRelevant(messages[index])) lastRelevant = index
  }

  if (requireAnchor) {
    return { done: false, startIndex: messages.length, anchorFound: false }
  }

  if (lastRelevant < 0) return { done: false, startIndex: 0, anchorFound: false }
  for (let index = lastRelevant + 1; index < messages.length; index++) {
    if (messages[index]?.type === "idle") {
      return { done: true, startIndex: lastRelevant, idle: messages[index], anchorFound: false }
    }
  }
  return { done: false, startIndex: lastRelevant, anchorFound: false }
}

type EventWatcher = {
  next: () => Promise<SessionEventLike | undefined>
  close: () => Promise<void>
}

function startEventWatcher(
  ctx: WaitContext,
  sessionID: string,
  signal: AbortSignal,
): EventWatcher | undefined {
  if (typeof ctx.event?.subscribe !== "function") return undefined

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", onAbort, { once: true })

  const queue: SessionEventLike[] = []
  let pending: ((event: SessionEventLike | undefined) => void) | undefined
  let closed = false
  let iterator: AsyncIterator<SessionEventLike> | undefined
  let task: Promise<void> | undefined

  try {
    const stream = ctx.event.subscribe({
      types: [...EVENT_TYPES],
      signal: controller.signal,
    }) as unknown as AsyncIterable<SessionEventLike>
    iterator = stream[Symbol.asyncIterator]()
    task = (async () => {
      try {
        while (true) {
          const step = await iterator?.next()
          if (!step || step.done) break
          const event = step.value
          if (event?.data?.sessionID !== sessionID) continue
          if (pending) {
            const resolve = pending
            pending = undefined
            resolve(event)
          } else {
            queue.push(event)
          }
        }
      } catch {
        // The event stream may close when the turn ends or the signal aborts.
      } finally {
        closed = true
        if (pending) {
          const resolve = pending
          pending = undefined
          resolve(undefined)
        }
      }
    })()
  } catch {
    signal.removeEventListener("abort", onAbort)
    return undefined
  }

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (closed) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        pending = resolve
      })
    },
    async close() {
      controller.abort()
      signal.removeEventListener("abort", onAbort)
      try {
        const returned = iterator?.return?.()
        if (returned) await settleWithTimeout(Promise.resolve(returned), 100)
      } catch {
        // Ignore iterator cleanup errors.
      }
      if (task) await settleWithTimeout(task, 100)
    },
  }
}

type WaitOutcome = { kind: "wait" } | { kind: "wait-error"; error: unknown }

function startWait(
  ctx: WaitContext,
  sessionID: string,
  signal: AbortSignal,
): Promise<WaitOutcome> | undefined {
  if (typeof ctx.session.wait !== "function") return undefined
  try {
    return ctx.session.wait({ sessionID }, { signal }).then(
      () => ({ kind: "wait" as const }),
      (error: unknown) => ({ kind: "wait-error" as const, error }),
    )
  } catch (error) {
    return Promise.resolve({ kind: "wait-error", error })
  }
}

type RaceOutcome =
  | { kind: "event"; event: SessionEventLike | undefined }
  | { kind: "wait"; outcome: WaitOutcome }
  | { kind: "poll" }
  | { kind: "aborted" }

/**
 * Waits for a specific turn. The anchor is the ID returned by
 * `session.prompt`; a turn is complete only when that user message appears and
 * an idle message follows it. This is what makes `delivery: "queue"` exact.
 *
 * Primary signals: `session.wait` and `session.idle` events. Polling is the
 * bounded fallback when both are unavailable or the event stream fails.
 */
export async function waitForTurn(ctx: WaitContext, options: WaitOptions): Promise<TurnResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const maxPoll = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS
  const permissionPoll = options.permissionPollMs ?? DEFAULT_PERMISSION_POLL_MS
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const progressInterval = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS

  let fetchCount = options.initialFetchCount ?? 0
  let lastError: string | undefined
  let pendingPermissions: PermissionLike[] | undefined
  let messages: MessageLike[] = options.initialMessages ?? []
  let startIndex = 0
  let queued = false
  let consecutiveErrors = 0
  let lastPermissionCheck = 0
  let lastProgress = started
  let errorEvent: string | undefined

  const controller = new AbortController()
  let timedOut = false
  const onUserAbort = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else options.signal.addEventListener("abort", onUserAbort, { once: true })
  }
  const deadlineTimer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("Turn timed out", "TimeoutError"))
  }, timeoutMs)

  const finish = (state: TurnState, extra: Partial<TurnResult> = {}): TurnResult => ({
    state,
    messages,
    startIndex,
    lastError,
    pendingPermissions,
    elapsedMs: Date.now() - started,
    fetchCount,
    promptMessageID: options.promptMessageID,
    queued,
    ...extra,
  })

  if (options.initialMessages) {
    const evaluation = evaluateTurn(options.initialMessages, options)
    startIndex = evaluation.startIndex
    if (evaluation.done) {
      clearTimeout(deadlineTimer)
      options.signal?.removeEventListener("abort", onUserAbort)
      return finish("idle", {
        messages: options.initialMessages,
        startIndex: evaluation.startIndex,
        idle: evaluation.idle,
        lastError: evaluation.idle?.error?.message ?? lastError,
      })
    }
  }

  try {
    const pending = await listPermissions(ctx, options.sessionID, controller.signal, requestTimeout)
    lastPermissionCheck = Date.now()
    if (pending.length) {
      pendingPermissions = pending
      return finish("permission", { pendingPermissions: pending })
    }
  } catch (error) {
    if (!controller.signal.aborted) lastError = formatError(error)
  }

  const watcher = startEventWatcher(ctx, options.sessionID, controller.signal)
  let waitOutcome = startWait(ctx, options.sessionID, controller.signal)
  let eventPromise = watcher?.next()
  let eventRace: Promise<RaceOutcome> | undefined
  let waitRace: Promise<RaceOutcome> | undefined
  let pollMs = pollInterval

  try {
    while (true) {
      if (controller.signal.aborted) {
        return timedOut ? finish("timeout") : finish("aborted")
      }

      const now = Date.now()
      if (now >= started + timeoutMs) return finish("timeout")

      if (now - lastProgress >= progressInterval) {
        lastProgress = now
        try {
          options.onProgress?.({ elapsedMs: now - started, fetchCount, lastEvent: errorEvent })
        } catch {
          // Progress reporting must never break the wait.
        }
      }

      const racers: Array<Promise<RaceOutcome>> = []
      if (eventPromise) {
        if (!eventRace) {
          const current = eventPromise
          eventRace = current.then((event) => ({ kind: "event" as const, event }))
        }
        racers.push(eventRace)
      }
      if (waitOutcome) {
        if (!waitRace) {
          const current = waitOutcome
          waitRace = current.then((outcome) => ({ kind: "wait" as const, outcome }))
        }
        racers.push(waitRace)
      }
      const remaining = started + timeoutMs - now
      const sleepController = new AbortController()
      const onSleepAbort = () => sleepController.abort()
      if (controller.signal.aborted) sleepController.abort()
      else controller.signal.addEventListener("abort", onSleepAbort, { once: true })
      racers.push(
        sleep(Math.min(pollMs, remaining), sleepController.signal).then((elapsed) => ({
          kind: elapsed ? ("poll" as const) : ("aborted" as const),
        })),
      )

      let outcome: RaceOutcome
      try {
        outcome = await Promise.race(racers)
      } finally {
        // If an event or session.wait won the race, cancel the fallback timer.
        sleepController.abort()
        controller.signal.removeEventListener("abort", onSleepAbort)
      }
      if (outcome.kind === "aborted") continue

      if (outcome.kind === "wait") {
        waitOutcome = undefined
        waitRace = undefined
        if (outcome.outcome.kind === "wait-error" && !controller.signal.aborted) {
          lastError = formatError(outcome.outcome.error)
        }
      } else if (outcome.kind === "event") {
        const event = outcome.event
        if (!event) {
          eventPromise = undefined
          eventRace = undefined
        } else {
          eventPromise = watcher?.next()
          eventRace = undefined
          if (event.type === "permission.asked") {
            try {
              const pending = await listPermissions(
                ctx,
                options.sessionID,
                controller.signal,
                requestTimeout,
              )
              if (pending.length) {
                pendingPermissions = pending
                return finish("permission", { pendingPermissions: pending })
              }
            } catch (error) {
              if (!controller.signal.aborted) lastError = formatError(error)
            }
            continue
          }
          if (event.type === "session.execution.failed") {
            errorEvent = event.data?.error?.message ?? "session.execution.failed"
            lastError = errorEvent
          } else if (event.type === "session.execution.interrupted") {
            errorEvent = event.data?.reason
              ? `interrupted: ${event.data.reason}`
              : "session.execution.interrupted"
            lastError = errorEvent
          } else if (event.type === "session.idle") {
            errorEvent = undefined
          }
        }
      }

      if (Date.now() - lastPermissionCheck >= permissionPoll) {
        lastPermissionCheck = Date.now()
        try {
          const pending = await listPermissions(
            ctx,
            options.sessionID,
            controller.signal,
            requestTimeout,
          )
          if (pending.length) {
            pendingPermissions = pending
            return finish("permission", { pendingPermissions: pending })
          }
        } catch (error) {
          if (!controller.signal.aborted) lastError = formatError(error)
        }
      }

      fetchCount++
      try {
        messages = await fetchContext(ctx, options.sessionID, controller.signal, requestTimeout)
      } catch (error) {
        if (controller.signal.aborted) continue
        lastError = formatError(error)
        consecutiveErrors++
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return finish("error")
        pollMs = Math.min(pollMs * 2, maxPoll)
        continue
      }

      consecutiveErrors = 0
      const evaluation = evaluateTurn(messages, options)
      startIndex = evaluation.startIndex
      if (evaluation.done) {
        queued = false
        return finish("idle", {
          idle: evaluation.idle,
          lastError: evaluation.idle?.error?.message ?? lastError,
        })
      }
      if (evaluation.anchorFound) {
        queued = false
      } else if (options.anchorID) {
        queued = true
      }
      if (errorEvent) return finish("error")
      pollMs = Math.min(pollMs * 2, maxPoll)
    }
  } finally {
    clearTimeout(deadlineTimer)
    options.signal?.removeEventListener("abort", onUserAbort)
    await watcher?.close()
  }
}
