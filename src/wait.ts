import { formatError, isRunning } from "./format.ts"
import { retryInfo } from "./retry.ts"
import type {
  MessageLike,
  PermissionLike,
  ProgressInfo,
  RetryInfo,
  SessionEventLike,
  SessionStatusLike,
  TerminalSignal,
  TurnResult,
  TurnState,
  WaitContext,
} from "./types.ts"

const EVENT_TYPES = [
  "session.idle",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "permission.asked",
] as const

const MAX_CONSECUTIVE_ERRORS = 5
const MAX_SETTLE_ATTEMPTS = 4
const MAX_REARMS = 4
const MAX_WAIT_ERRORS = 2
const MAX_EVENT_QUEUE = 64
const INITIAL_SETTLE_DELAY_MS = 25
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 500
const DEFAULT_MAX_POLL_MS = 2_000
const DEFAULT_PERMISSION_POLL_MS = 1_500
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000
const FALLBACK_CONTEXT_INTERVAL_MS = 5_000
const FINAL_BUDGET_MS = 300

export type WaitOptions = {
  sessionID: string
  anchorID?: string
  promptText?: string
  admittedAt?: number
  timeoutMs: number
  signal?: AbortSignal
  initialMessages?: MessageLike[]
  initialFetchCount?: number
  /** Permissions already listed by the caller's preflight. */
  initialPermissions?: PermissionLike[]
  /** Epoch ms of the caller's preflight permission.list, if any. */
  initialPermissionCheckAt?: number
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
    if (parent.aborted) {
      controller.abort(parent.reason)
    } else {
      parent.addEventListener("abort", onAbort, { once: true })
      if (parent.aborted) onAbort()
    }
  }
  const timer =
    timeoutMs > 0 && !controller.signal.aborted
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
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
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

type SessionGetResult = Awaited<ReturnType<WaitContext["session"]["get"]>>

async function fetchSession(
  ctx: WaitContext,
  sessionID: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SessionGetResult | undefined> {
  if (typeof ctx.session.get !== "function") return undefined
  const request = requestSignal(signal, timeoutMs)
  try {
    return await ctx.session.get({ sessionID }, { signal: request.signal })
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

export type Evaluation = {
  done: boolean
  startIndex: number
  endIndex?: number
  idle?: MessageLike
  anchorFound: boolean
  anchorMessage?: MessageLike
  anchorCreatedAt?: number
  hasTurnAssistant: boolean
  queued: boolean
}

function isRelevant(message: MessageLike | undefined): boolean {
  return message?.type === "user" || message?.type === "assistant" || message?.type === "compaction"
}

export function evaluateTurn(messages: MessageLike[], options: WaitOptions): Evaluation {
  const requireAnchor = options.requireAnchor ?? Boolean(options.anchorID)
  const hasExplicitAnchor = Boolean(options.anchorID || (options.promptText && options.admittedAt !== undefined))
  let anchorIndex = options.anchorID
    ? messages.findIndex((message) => message.id === options.anchorID)
    : -1

  if (anchorIndex < 0 && options.promptText && options.admittedAt !== undefined) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (
        message?.type === "user" &&
        message.text === options.promptText &&
        (message.time?.created ?? 0) >= options.admittedAt
      ) {
        anchorIndex = index
        break
      }
    }
  }

  if (anchorIndex < 0) {
    if (requireAnchor) {
      return {
        done: false,
        startIndex: messages.length,
        anchorFound: false,
        hasTurnAssistant: false,
        queued: Boolean(options.anchorID),
      }
    }

    let lastUserIndex = -1
    let lastRelevantIndex = -1
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message?.type === "user") lastUserIndex = index
      if (isRelevant(message)) lastRelevantIndex = index
    }

    if (lastRelevantIndex < 0) {
      return {
        done: false,
        startIndex: 0,
        anchorFound: false,
        hasTurnAssistant: false,
        queued: false,
      }
    }
    anchorIndex = lastUserIndex >= 0 ? lastUserIndex : lastRelevantIndex
  }

  const anchorMessage = messages[anchorIndex]
  const anchorCreatedAt = anchorMessage?.time?.created ?? options.admittedAt
  const anchorFound = hasExplicitAnchor

  if (anchorMessage?.type !== "user") {
    for (let index = anchorIndex + 1; index < messages.length; index++) {
      if (messages[index]?.type === "idle") {
        return {
          done: true,
          startIndex: anchorIndex,
          endIndex: index,
          idle: messages[index],
          anchorFound,
          anchorMessage,
          anchorCreatedAt,
          hasTurnAssistant: anchorMessage?.type === "assistant",
          queued: false,
        }
      }
    }
    return {
      done: false,
      startIndex: anchorIndex,
      anchorFound,
      anchorMessage,
      anchorCreatedAt,
      hasTurnAssistant: anchorMessage?.type === "assistant",
      queued: false,
    }
  }

  let priorRelevantIndex = -1
  let priorIdleIndex = -1
  for (let index = 0; index < anchorIndex; index++) {
    const message = messages[index]
    if (message?.type === "idle") priorIdleIndex = index
    if (isRelevant(message)) priorRelevantIndex = index
  }
  let unclosedPriorTurn = priorRelevantIndex > priorIdleIndex

  let lastTurnAssistant: MessageLike | undefined
  let hasForeignIdle = false

  for (let index = anchorIndex + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message?.type === "assistant" || message?.type === "compaction") {
      const created = message.time?.created
      if (
        typeof created !== "number" ||
        typeof anchorCreatedAt !== "number" ||
        created >= anchorCreatedAt
      ) {
        lastTurnAssistant = message
        unclosedPriorTurn = false
      }
      continue
    }

    if (message?.type === "idle") {
      const idleCreated = message.time?.created
      if (
        typeof idleCreated === "number" &&
        typeof anchorCreatedAt === "number" &&
        idleCreated < anchorCreatedAt
      ) {
        unclosedPriorTurn = false
        hasForeignIdle = true
        continue
      }

      if (lastTurnAssistant) {
        const assistantCompleted = lastTurnAssistant.time?.completed
        if (
          typeof idleCreated === "number" &&
          typeof assistantCompleted === "number" &&
          idleCreated < assistantCompleted
        ) {
          continue
        }
        return {
          done: true,
          startIndex: anchorIndex,
          endIndex: index,
          idle: message,
          anchorFound,
          anchorMessage,
          anchorCreatedAt,
          hasTurnAssistant: true,
          queued: false,
        }
      }

      if (unclosedPriorTurn) {
        unclosedPriorTurn = false
        hasForeignIdle = true
        continue
      }

      const isFailureOrInterrupt =
        message.outcome === "failed" ||
        message.outcome === "interrupted" ||
        Boolean(message.error)
      if (isFailureOrInterrupt) {
        return {
          done: true,
          startIndex: anchorIndex,
          endIndex: index,
          idle: message,
          anchorFound,
          anchorMessage,
          anchorCreatedAt,
          hasTurnAssistant: false,
          queued: false,
        }
      }

      hasForeignIdle = true
    }
  }

  const queued = !lastTurnAssistant && (unclosedPriorTurn || hasForeignIdle)
  return {
    done: false,
    startIndex: anchorIndex,
    anchorFound,
    anchorMessage,
    anchorCreatedAt,
    hasTurnAssistant: Boolean(lastTurnAssistant),
    queued,
  }
}

type EventWatcher = {
  next: () => Promise<SessionEventLike | undefined>
  drainTerminal: () => boolean
  isClosed: () => boolean
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
  if (signal.aborted) {
    controller.abort(signal.reason)
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  }

  const queue: SessionEventLike[] = []
  let pending: ((event: SessionEventLike | undefined) => void) | undefined
  let closed = false
  let iterator: AsyncIterator<SessionEventLike> | undefined

  const enqueue = (event: SessionEventLike): void => {
    // Coalesce the two high-frequency state events and bound the queue; a
    // slow settle must not grow memory with duplicates.
    if (event.type === "session.status" || event.type === "session.retry.scheduled") {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]?.type === event.type) queue.splice(index, 1)
      }
    }
    if (queue.length >= MAX_EVENT_QUEUE) queue.shift()
    queue.push(event)
  }

  try {
    const stream = ctx.event.subscribe({
      types: [...EVENT_TYPES],
      signal: controller.signal,
    }) as unknown as AsyncIterable<SessionEventLike>
    iterator = stream[Symbol.asyncIterator]()
    void (async () => {
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
            enqueue(event)
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
    drainTerminal() {
      let sawTerminal = false
      for (let i = queue.length - 1; i >= 0; i--) {
        const event = queue[i]
        const type = event?.type
        if (
          type === "session.idle" ||
          type === "session.execution.succeeded" ||
          type === "session.execution.failed" ||
          type === "session.execution.interrupted" ||
          (type === "session.status" && event?.data?.status?.type === "idle")
        ) {
          sawTerminal = true
          queue.splice(i, 1)
        }
      }
      return sawTerminal
    },
    isClosed() {
      return closed
    },
    async close() {
      if (pending) {
        const resolve = pending
        pending = undefined
        resolve(undefined)
      }
      controller.abort()
      signal.removeEventListener("abort", onAbort)
      try {
        const returned = Promise.resolve(iterator?.return?.()).catch(() => undefined)
        await Promise.race([returned, sleep(50)])
      } catch {
        // Ignore iterator cleanup errors.
      }
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
  | { kind: "settle" }
  | { kind: "permission" }
  | { kind: "deadline" }
  | { kind: "aborted" }

/**
 * Waits for a specific turn. The anchor is the ID returned by
 * `session.prompt`; a turn is complete only when that user message appears and
 * an idle message for that turn follows it. This is what makes `delivery: "queue"` exact.
 *
 * Primary signals: `session.wait` and `session.idle` events. Polling is the
 * bounded fallback when both are unavailable or the event stream fails, and
 * a short bounded settle phase bridges the gap when a terminal signal arrives
 * slightly before `session.context` persists the `idle` message.
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
  let endIndex: number | undefined
  let anchorMessage: MessageLike | undefined
  let anchorCreatedAt: number | undefined
  let terminalSignal: TerminalSignal | undefined
  let queued = Boolean(options.anchorID)
  let consecutiveErrors = 0
  let lastPermissionCheck = 0
  let lastProgress = started
  let lastContextAt = 0
  let errorEvent: string | undefined
  let retry: RetryInfo | undefined
  let sawSuccessEvent = false
  let forcePoll = false
  let settleRemaining = 0
  let settleDelayMs = Math.min(pollInterval, INITIAL_SETTLE_DELAY_MS)
  let waitErrors = 0
  let rearmCount = 0
  let pollMs = pollInterval
  let finalizing = false

  const controller = new AbortController()
  let timedOut = false
  const onUserAbort = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason)
    } else {
      options.signal.addEventListener("abort", onUserAbort, { once: true })
      if (options.signal.aborted) onUserAbort()
    }
  }
  const deadlineTimer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("Turn timed out", "TimeoutError"))
  }, timeoutMs)

  const finish = (state: TurnState, extra: Partial<TurnResult> = {}): TurnResult => {
    clearTimeout(deadlineTimer)
    options.signal?.removeEventListener("abort", onUserAbort)
    // Cancel a pending session.wait or event subscription as soon as the
    // result is known; no request should outlive the wait.
    controller.abort()
    const resolvedSignal: TerminalSignal | undefined =
      extra.terminalSignal ??
      terminalSignal ??
      (state === "timeout" ? "timeout" : state === "aborted" ? "abort" : undefined)
    return {
      state,
      messages,
      startIndex,
      endIndex,
      lastError,
      pendingPermissions,
      elapsedMs: Date.now() - started,
      fetchCount,
      promptMessageID: options.promptMessageID,
      queued,
      anchorMessage,
      anchorCreatedAt,
      terminalSignal: resolvedSignal,
      retry,
      permissionCheckedAt: lastPermissionCheck || undefined,
      ...extra,
    }
  }

  /**
   * At the deadline, make one short best-effort read. A turn that persisted its
   * idle message just before the timer fired should return idle, not timeout.
   */
  const finalizeTimeout = async (): Promise<TurnResult> => {
    if (finalizing) return finish("timeout", { terminalSignal: "timeout" })
    finalizing = true
    const userSignal = options.signal
    if (!userSignal?.aborted) {
      // A single shared budget keeps the final read within the end-to-end
      // timeout instead of spending 250ms + 500ms sequentially.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FINAL_BUDGET_MS)
      const onUserAbort = () => controller.abort(userSignal?.reason)
      if (userSignal) {
        if (userSignal.aborted) controller.abort(userSignal.reason)
        else userSignal.addEventListener("abort", onUserAbort, { once: true })
      }
      try {
        const [permissionResult, contextResult] = await Promise.allSettled([
          listPermissions(ctx, options.sessionID, controller.signal, FINAL_BUDGET_MS),
          fetchContext(ctx, options.sessionID, controller.signal, FINAL_BUDGET_MS),
        ])
        lastPermissionCheck = Date.now()
        if (permissionResult.status === "fulfilled" && permissionResult.value.length) {
          pendingPermissions = permissionResult.value
          return finish("permission", {
            pendingPermissions: permissionResult.value,
            terminalSignal: "timeout",
          })
        }
        if (contextResult.status === "fulfilled") {
          fetchCount++
          messages = contextResult.value
          const evaluation = evaluateTurn(messages, options)
          startIndex = evaluation.startIndex
          endIndex = evaluation.endIndex
          anchorMessage = evaluation.anchorMessage
          anchorCreatedAt = evaluation.anchorCreatedAt
          queued = evaluation.queued
          if (evaluation.done) {
            queued = false
            return finish("idle", {
              idle: evaluation.idle,
              endIndex: evaluation.endIndex,
              lastError: evaluation.idle?.error?.message,
              queued: false,
            })
          }
          if (
            sawSuccessEvent &&
            (evaluation.hasTurnAssistant || evaluation.anchorMessage?.type === "user") &&
            !evaluation.queued
          ) {
            queued = false
            return finish("idle", {
              endIndex: evaluation.endIndex,
              lastError: evaluation.idle?.error?.message,
              queued: false,
            })
          }
        }
      } catch {
        // The final read is best effort only.
      } finally {
        clearTimeout(timer)
        userSignal?.removeEventListener("abort", onUserAbort)
      }
    }
    return finish("timeout", { terminalSignal: "timeout" })
  }

  if (options.signal?.aborted) return finish("aborted", { terminalSignal: "abort" })

  if (options.initialMessages) {
    const evaluation = evaluateTurn(options.initialMessages, options)
    startIndex = evaluation.startIndex
    endIndex = evaluation.endIndex
    anchorMessage = evaluation.anchorMessage
    anchorCreatedAt = evaluation.anchorCreatedAt
    queued = evaluation.queued
    if (evaluation.done) {
      return finish("idle", {
        messages: options.initialMessages,
        startIndex: evaluation.startIndex,
        endIndex: evaluation.endIndex,
        idle: evaluation.idle,
        lastError: evaluation.idle?.error?.message,
        queued: false,
      })
    }
  }

  if (options.initialPermissions?.length) {
    pendingPermissions = options.initialPermissions
    return finish("permission", { pendingPermissions: options.initialPermissions })
  }
  if (options.initialPermissions) pendingPermissions = options.initialPermissions
  if (options.initialPermissionCheckAt) lastPermissionCheck = options.initialPermissionCheckAt
  const permissionCheckIsFresh =
    lastPermissionCheck > 0 && Date.now() - lastPermissionCheck < permissionPoll
  if (!permissionCheckIsFresh) {
    try {
      const pending = await listPermissions(ctx, options.sessionID, controller.signal, requestTimeout)
      lastPermissionCheck = Date.now()
      if (pending.length) {
        pendingPermissions = pending
        return finish("permission", { pendingPermissions: pending })
      }
    } catch (error) {
      if (!controller.signal.aborted) lastError = formatError(error)
      lastPermissionCheck = Date.now()
    }
  }

  let watcher = startEventWatcher(ctx, options.sessionID, controller.signal)
  let waitOutcome = startWait(ctx, options.sessionID, controller.signal)
  let eventPromise = watcher?.next()
  let eventRace: Promise<RaceOutcome> | undefined
  let waitRace: Promise<RaceOutcome> | undefined

  const armPrimarySignals = (): void => {
    if (!watcher || watcher.isClosed()) {
      void watcher?.close()
      watcher = startEventWatcher(ctx, options.sessionID, controller.signal)
      eventPromise = watcher?.next()
      eventRace = undefined
    } else if (!eventPromise) {
      eventPromise = watcher.next()
      eventRace = undefined
    }
    if (!waitOutcome && waitErrors < MAX_WAIT_ERRORS) {
      waitOutcome = startWait(ctx, options.sessionID, controller.signal)
      waitRace = undefined
    }
  }

  const rearmSignals = async (delayMs: number): Promise<boolean> => {
    if (rearmCount >= MAX_REARMS || controller.signal.aborted) return false
    const canRearm =
      typeof ctx.session.wait === "function" || typeof ctx.event?.subscribe === "function"
    if (!canRearm) return false
    rearmCount++
    if (delayMs > 0) {
      const remaining = Math.max(1, started + timeoutMs - Date.now())
      const waited = await sleep(Math.min(delayMs, remaining), controller.signal)
      if (!waited) return false
    }
    // Preserve an active settle window: re-arming the primary signals must not
    // discard a terminal event that is still being persisted.
    if (settleRemaining === 0) {
      settleDelayMs = Math.max(10, Math.min(pollInterval, INITIAL_SETTLE_DELAY_MS))
    }
    forcePoll = false
    armPrimarySignals()
    return true
  }

  try {
    while (true) {
      if (controller.signal.aborted) {
        return timedOut
          ? await finalizeTimeout()
          : finish("aborted", { terminalSignal: "abort" })
      }

      const now = Date.now()
      if (now >= started + timeoutMs) return await finalizeTimeout()

      if (now - lastProgress >= progressInterval) {
        lastProgress = now
        try {
          options.onProgress?.({
            elapsedMs: now - started,
            fetchCount,
            lastEvent: retry ? "retry" : errorEvent,
            ...(retry ? { state: "retrying" as const, retry } : {}),
          })
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
      const hasPrimary = Boolean(eventRace || waitRace) && !forcePoll && settleRemaining === 0
      const remaining = started + timeoutMs - now
      const sleepController = new AbortController()
      const onSleepAbort = () => sleepController.abort()
      if (controller.signal.aborted) sleepController.abort()
      else controller.signal.addEventListener("abort", onSleepAbort, { once: true })

      if (settleRemaining > 0) {
        racers.push(
          sleep(Math.min(settleDelayMs, remaining), sleepController.signal).then((elapsed) => ({
            kind: elapsed ? ("settle" as const) : ("aborted" as const),
          })),
        )
      } else if (hasPrimary) {
        // With session.wait or an event stream active, do not poll the
        // transcript. Only wake for the deadline or a permission check.
        racers.push(
          sleep(remaining, sleepController.signal).then((elapsed) => ({
            kind: elapsed ? ("deadline" as const) : ("aborted" as const),
          })),
        )
        const permissionDue = Math.max(0, permissionPoll - (now - lastPermissionCheck))
        if (permissionDue < remaining) {
          racers.push(
            sleep(permissionDue, sleepController.signal).then((elapsed) => ({
              kind: elapsed ? ("permission" as const) : ("aborted" as const),
            })),
          )
        }
      } else {
        racers.push(
          sleep(Math.min(pollMs, remaining), sleepController.signal).then((elapsed) => ({
            kind: elapsed ? ("poll" as const) : ("aborted" as const),
          })),
        )
      }

      let outcome: RaceOutcome
      try {
        outcome = await Promise.race(racers)
      } finally {
        // If an event or session.wait won the race, cancel fallback timers.
        sleepController.abort()
        controller.signal.removeEventListener("abort", onSleepAbort)
      }
      if (outcome.kind === "aborted") continue
      if (outcome.kind === "deadline") continue

      let receivedTerminalSignal = false

      if (outcome.kind === "wait") {
        waitOutcome = undefined
        waitRace = undefined
        if (outcome.outcome.kind === "wait-error") {
          waitErrors++
          if (!controller.signal.aborted) {
            lastError = formatError(outcome.outcome.error)
          }
        } else {
          terminalSignal = "wait"
          receivedTerminalSignal = true
          watcher?.drainTerminal()
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
              lastPermissionCheck = Date.now()
              if (pending.length) {
                pendingPermissions = pending
                return finish("permission", { pendingPermissions: pending })
              }
            } catch (error) {
              lastPermissionCheck = Date.now()
              if (!controller.signal.aborted) lastError = formatError(error)
            }
            continue
          }
          if (event.type === "session.status") {
            const status: SessionStatusLike | undefined = event.data?.status
            if (status?.type === "retry") {
              retry = retryInfo(status.attempt, status.message, status.next)
              sawSuccessEvent = false
              if (!controller.signal.aborted) {
                try {
                  options.onProgress?.({
                    elapsedMs: Date.now() - started,
                    fetchCount,
                    lastEvent: "retry",
                    state: "retrying",
                    retry,
                  })
                } catch {
                  // Progress reporting must never break the wait.
                }
              }
              continue
            }
            if (status?.type === "busy") {
              // The turn started; the anchor may still be queued in context.
              continue
            }
            if (status?.type === "idle") {
              errorEvent = undefined
              sawSuccessEvent = true
              terminalSignal = "event"
              receivedTerminalSignal = true
            }
          } else if (event.type === "session.retry.scheduled") {
            const attempt =
              typeof event.data?.attempt === "number"
                ? event.data.attempt
                : (retry?.attempt ?? 0) + 1
            const next =
              typeof event.data?.at === "number" ? event.data.at : Date.now()
            retry = retryInfo(
              attempt,
              event.data?.error?.message ?? "retry scheduled",
              next,
            )
            sawSuccessEvent = false
            if (!controller.signal.aborted) {
              try {
                options.onProgress?.({
                  elapsedMs: Date.now() - started,
                  fetchCount,
                  lastEvent: "retry",
                  state: "retrying",
                  retry,
                })
              } catch {
                // Progress reporting must never break the wait.
              }
            }
            continue
          } else if (event.type === "session.execution.started") {
            sawSuccessEvent = false
            continue
          } else if (event.type === "session.execution.succeeded") {
            errorEvent = undefined
            sawSuccessEvent = true
            terminalSignal = "event"
            receivedTerminalSignal = true
          } else if (event.type === "session.execution.failed") {
            errorEvent = event.data?.error?.message ?? "session.execution.failed"
            lastError = errorEvent
            sawSuccessEvent = false
            terminalSignal = "event"
            receivedTerminalSignal = true
          } else if (event.type === "session.execution.interrupted") {
            errorEvent = event.data?.reason
              ? `interrupted: ${event.data.reason}`
              : "session.execution.interrupted"
            lastError = errorEvent
            sawSuccessEvent = false
            terminalSignal = "event"
            receivedTerminalSignal = true
          } else if (event.type === "session.idle") {
            errorEvent = undefined
            sawSuccessEvent = true
            terminalSignal = "event"
            receivedTerminalSignal = true
          }
        }
      } else if (outcome.kind === "poll") {
        terminalSignal = terminalSignal ?? "poll"
      }

      if (receivedTerminalSignal && settleRemaining === 0) {
        settleRemaining = errorEvent ? 2 : MAX_SETTLE_ATTEMPTS
        settleDelayMs = Math.max(10, Math.min(pollInterval, INITIAL_SETTLE_DELAY_MS))
      } else if (outcome.kind === "settle" && settleRemaining > 0) {
        settleRemaining--
        settleDelayMs = Math.min(settleDelayMs * 2, maxPoll)
      }

      const shouldCheckPermission =
        outcome.kind === "permission" ||
        (outcome.kind === "poll" && Date.now() - lastPermissionCheck >= permissionPoll)
      if (shouldCheckPermission) {
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
        lastPermissionCheck = Date.now()
      }
      if (outcome.kind === "permission") continue

      // If both session.idle and session.wait resolved right after each other
      // while we are already settling from the first terminal read, wait one
      // short settle interval before reading context a second time.
      if (
        outcome.kind === "wait" &&
        receivedTerminalSignal &&
        fetchCount > (options.initialFetchCount ?? 0) &&
        settleRemaining > 0
      ) {
        const waited = await sleep(
          Math.min(settleDelayMs, Math.max(1, started + timeoutMs - Date.now())),
          controller.signal,
        )
        if (!waited) continue
      }

      // Cheap fallback: session.get is much smaller than a full transcript.
      // While the session is still running and the anchor is visible, skip the
      // context read until the session reports idle or a safety interval passes.
      if (outcome.kind === "poll" && !receivedTerminalSignal && settleRemaining === 0) {
        try {
          const session = await fetchSession(
            ctx,
            options.sessionID,
            controller.signal,
            requestTimeout,
          )
          if (session) {
            const running = isRunning(session, [])
            const sinceContext = Date.now() - lastContextAt
            if (anchorMessage !== undefined && running && sinceContext < FALLBACK_CONTEXT_INTERVAL_MS) {
              pollMs = Math.min(pollMs * 2, maxPoll)
              continue
            }
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
        forcePoll = true
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return finish("error")
        pollMs = Math.min(pollMs * 2, maxPoll)
        continue
      }

      lastContextAt = Date.now()
      consecutiveErrors = 0
      forcePoll = false
      const evaluation = evaluateTurn(messages, options)
      startIndex = evaluation.startIndex
      endIndex = evaluation.endIndex
      anchorMessage = evaluation.anchorMessage
      anchorCreatedAt = evaluation.anchorCreatedAt
      queued = evaluation.queued

      if (evaluation.done) {
        queued = false
        return finish("idle", {
          idle: evaluation.idle,
          endIndex: evaluation.endIndex,
          lastError: evaluation.idle?.error?.message,
          queued: false,
        })
      }

      if (errorEvent && settleRemaining === 0) {
        // A failure for a queued turn that has not started yet is not the
        // anchored turn's failure. Clear it before re-arming so it cannot leak
        // into the result of the anchored turn.
        if (evaluation.queued && rearmCount < MAX_REARMS) {
          const ok = await rearmSignals(Math.min(pollInterval, 250))
          if (ok) {
            errorEvent = undefined
            lastError = undefined
            pollMs = pollInterval
            continue
          }
        }
        return finish("error")
      }

      // Durable execution events can complete a turn even when the transcript
      // never persists an `idle` message within the settle window.
      if (
        settleRemaining === 0 &&
        sawSuccessEvent &&
        (evaluation.hasTurnAssistant || evaluation.anchorMessage?.type === "user") &&
        !evaluation.queued
      ) {
        return finish("idle", {
          endIndex: evaluation.endIndex,
          lastError: evaluation.idle?.error?.message,
          queued: false,
        })
      }

      if (settleRemaining === 0 && !receivedTerminalSignal) {
        const lostPrimary = !waitOutcome && !eventPromise
        const shouldRearm = lostPrimary && rearmCount === 0
        if (shouldRearm && rearmCount < MAX_REARMS) {
          const ok = await rearmSignals(Math.min(pollInterval, 250))
          if (ok) {
            pollMs = pollInterval
            continue
          }
        }
        if (!waitOutcome && !eventPromise) forcePoll = true
      } else if (rearmCount < MAX_REARMS) {
        // A terminal signal that did not complete the anchored turn (for
        // example an idle from the previous turn) must not leave the wait
        // without its primary signal. Re-arm session.wait/events immediately,
        // with a small backoff to avoid a tight loop if they resolve instantly.
        const ok = await rearmSignals(Math.min(pollInterval, 250))
        if (ok) {
          pollMs = pollInterval
          continue
        }
        if (!waitOutcome && !eventPromise) forcePoll = true
      } else if (!waitOutcome && !eventPromise) {
        forcePoll = true
      }
      pollMs = Math.min(pollMs * 2, maxPoll)
    }
  } finally {
    clearTimeout(deadlineTimer)
    options.signal?.removeEventListener("abort", onUserAbort)
    controller.abort()
    await watcher?.close()
  }
}
