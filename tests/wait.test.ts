import { afterEach, describe, expect, it, vi } from "vitest"
import { summarizeTurn } from "../src/format.ts"
import type {
  MessageLike,
  PermissionLike,
  SessionEventLike,
  WaitContext,
} from "../src/types.ts"
import { waitForTurn } from "../src/wait.ts"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const user = (id: string, text: string, created = 1): MessageLike => ({
  id,
  type: "user",
  text,
  time: { created },
})
const assistant = (id: string, text: string, created = 2): MessageLike => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created },
})
const idle = (id: string, created = 3): MessageLike => ({
  id,
  type: "idle",
  outcome: "succeeded",
  time: { created },
})

type FakeOptions = {
  context: (call: number) => MessageLike[] | Promise<MessageLike[]>
  wait?: (call: number) => Promise<void>
  get?: (call: number) =>
    | { time?: { busy?: number; idle?: number; updated?: number }; outcome?: string }
    | Promise<{ time?: { busy?: number; idle?: number; updated?: number }; outcome?: string }>
  permissions?: (call: number) => PermissionLike[]
  events?: (signal?: AbortSignal) => AsyncIterable<SessionEventLike>
  sessionID?: string
}

function makeContext(options: FakeOptions) {
  const stats = {
    contextCalls: 0,
    waitCalls: 0,
    permissionCalls: 0,
    getCalls: 0,
    subscribeCalls: 0,
  }
  const sessionID = options.sessionID ?? "ses_1"
  const ctx = {
    session: {
      context: async () => {
        stats.contextCalls++
        return options.context(stats.contextCalls)
      },
      get: options.get
        ? async () => {
            stats.getCalls++
            return options.get?.(stats.getCalls)
          }
        : undefined,
      wait: options.wait
        ? async () => {
            stats.waitCalls++
            return options.wait?.(stats.waitCalls)
          }
        : undefined,
    },
    permission: {
      list: async () => {
        stats.permissionCalls++
        return options.permissions ? options.permissions(stats.permissionCalls) : []
      },
    },
    event: options.events
      ? {
          subscribe: (subscribeOptions?: { signal?: AbortSignal }) => {
            stats.subscribeCalls++
            return options.events?.(subscribeOptions?.signal)
          },
        }
      : undefined,
  }
  return { ctx: ctx as unknown as WaitContext, stats, sessionID }
}

function eventStream(events: SessionEventLike[], delayMs = 5) {
  return (signal?: AbortSignal): AsyncIterable<SessionEventLike> => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await delay(delayMs)
        if (signal?.aborted) return
        yield event
      }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    },
  })
}

function finiteEventStream(events: SessionEventLike[]) {
  return (signal?: AbortSignal): AsyncIterable<SessionEventLike> => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        if (signal?.aborted) return
        yield event
      }
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("waitForTurn", () => {
  it("uses the prompt ID anchor and needs at most two context reads on a normal turn", async () => {
    const { ctx, stats } = makeContext({
      wait: async () => {
        await delay(10)
      },
      context: () => [user("prompt", "hello"), assistant("answer", "world"), idle("done")],
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      promptMessageID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.startIndex).toBe(0)
    expect(result.promptMessageID).toBe("prompt")
    expect(stats.contextCalls).toBeLessThanOrEqual(2)
  })

  it("waits for the exact queued turn instead of returning the current idle", async () => {
    const old = [user("old", "old prompt", 1), assistant("old-answer", "old answer", 2), idle("old-idle", 3)]
    const queued = [
      ...old,
      user("queued", "queued prompt", 10),
      assistant("queued-answer", "queued answer", 11),
    ]
    const snapshots = [old, queued, [...queued, idle("queued-idle", 12)]]

    const { ctx, stats } = makeContext({
      wait: async () => undefined,
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
    })

    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "queued",
      promptText: "queued prompt",
      admittedAt: 10,
      timeoutMs: 500,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.startIndex).toBe(3)
    expect(summarizeTurn(result.messages, result.startIndex).text).toBe("queued answer")
    expect(summarizeTurn(result.messages, result.startIndex).text).not.toBe("old answer")
    expect(result.queued).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
    expect(stats.contextCalls).toBeGreaterThanOrEqual(3)
  })

  it("does not poll context while session.wait is active", async () => {
    const { ctx, stats } = makeContext({
      wait: async () => {
        await delay(120)
      },
      context: () => [user("prompt", "hello"), assistant("answer", "world"), idle("done")],
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(stats.contextCalls).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it("does not poll context while the event stream is active", async () => {
    const { ctx, stats } = makeContext({
      context: () => [user("prompt", "hello"), assistant("answer", "world"), idle("done")],
      events: eventStream([{ type: "session.idle", data: { sessionID: "ses_1" } }], 120),
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(stats.contextCalls).toBe(1)
  })

  it("does not return the idle of a previous turn when waiting for a later prompt", async () => {
    const messages = [
      user("a", "A", 1),
      assistant("a-answer", "A answer", 2),
      idle("a-idle", 3),
      user("b", "B", 4),
      assistant("b-answer", "B answer", 5),
      idle("b-idle", 6),
    ]
    const { ctx } = makeContext({ context: () => messages })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "b",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("b-idle")
    expect(result.startIndex).toBe(3)
    expect(summarizeTurn(result.messages, result.startIndex).text).toBe("B answer")
  })

  it("filters idle events by sessionID", async () => {
    const { ctx, stats } = makeContext({
      context: () => [user("prompt", "hello"), assistant("answer", "world"), idle("done")],
      events: eventStream([
        { type: "session.idle", data: { sessionID: "other" } },
        { type: "session.idle", data: { sessionID: "ses_1" } },
      ]),
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 100,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(stats.contextCalls).toBe(1)
  })

  it("times out within the agreed budget", async () => {
    const { ctx } = makeContext({ context: () => [user("prompt", "still running")] })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 80,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("aborts in less than one polling cycle and leaves no timers", async () => {
    vi.useFakeTimers()
    const { ctx } = makeContext({ context: () => [user("prompt", "running")] })
    const controller = new AbortController()
    const promise = waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 5_000,
      signal: controller.signal,
      requireAnchor: true,
      pollIntervalMs: 100,
      permissionPollMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(20)
    controller.abort()
    const result = await promise
    expect(result.state).toBe("aborted")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("returns permission immediately when a request is pending", async () => {
    const permission: PermissionLike = {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["echo *"],
    }
    const { ctx, stats } = makeContext({
      context: () => [user("prompt", "running")],
      permissions: () => [permission],
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 5_000,
      requireAnchor: true,
    })
    expect(result.state).toBe("permission")
    expect(result.pendingPermissions).toHaveLength(1)
    expect(stats.contextCalls).toBe(0)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it("cleans up its deadline timer when permission is pending", async () => {
    vi.useFakeTimers()
    const permission: PermissionLike = {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["echo *"],
    }
    const { ctx } = makeContext({
      context: () => [],
      permissions: () => [permission],
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 5_000,
      requireAnchor: true,
    })
    expect(result.state).toBe("permission")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("detects a permission that appears during a wait without polling context", async () => {
    const permission: PermissionLike = {
      id: "per_2",
      sessionID: "ses_1",
      action: "edit",
      resources: ["src/*"],
    }
    const { ctx, stats } = makeContext({
      wait: () => new Promise<void>(() => undefined),
      context: () => [user("prompt", "running")],
      permissions: (call) => (call === 1 ? [] : [permission]),
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 20,
    })
    expect(result.state).toBe("permission")
    expect(result.pendingPermissions?.[0]?.id).toBe("per_2")
    expect(stats.contextCalls).toBe(0)
    expect(Date.now() - started).toBeLessThan(300)
  })

  it("retries context after a transient failure even while session.wait is active", async () => {
    let call = 0
    const { ctx, stats } = makeContext({
      wait: async () => {
        await delay(20)
      },
      context: () => {
        call++
        if (call === 1) throw new Error("transient")
        return [user("prompt", "hello"), assistant("answer", "world"), idle("done")]
      },
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(stats.contextCalls).toBe(2)
  })

  it("returns an error after permanent context failures instead of waiting for the timeout", async () => {
    const { ctx } = makeContext({
      context: () => {
        throw new Error("boom")
      },
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 5_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("error")
    expect(result.lastError).toContain("boom")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("falls back to polling when session.wait and the event stream fail", async () => {
    const { ctx } = makeContext({
      wait: async () => {
        throw new Error("wait unsupported")
      },
      context: () => [user("prompt", "hello"), assistant("answer", "world"), idle("done")],
      events: () => {
        throw new Error("events unavailable")
      },
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
  })

  it("reports progress without leaking prompt content", async () => {
    const updates: Array<Record<string, unknown>> = []
    const { ctx } = makeContext({ context: () => [user("prompt", "secret prompt")] })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 80,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
      progressIntervalMs: 20,
      onProgress: (info) => updates.push(info as unknown as Record<string, unknown>),
    })
    expect(result.state).toBe("timeout")
    expect(updates.length).toBeGreaterThan(0)
    expect(JSON.stringify(updates)).not.toContain("secret prompt")
  })

  it("P0-1: settles after session.idle/session.wait when the idle message appears on the third context read", async () => {
    const running = [user("prompt", "hello", 1), assistant("answer", "world", 2)]
    const completed = [...running, idle("done", 3)]
    const snapshots = [running, running, completed]

    const { ctx, stats } = makeContext({
      wait: async () => {
        await delay(5)
      },
      events: eventStream([{ type: "session.idle", data: { sessionID: "ses_1" } }], 5),
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      promptMessageID: "prompt",
      timeoutMs: 300,
      requireAnchor: true,
      pollIntervalMs: 50,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("done")
    expect(stats.contextCalls).toBeLessThanOrEqual(4)
  })

  it("P0-2: ignores a previous turn's idle that appears after a queued or steered user message", async () => {
    const withForeignIdle = [
      user("old-user", "old prompt", 1),
      assistant("old-assistant", "old answer", 2),
      user("queued-user", "queued prompt", 10),
      idle("old-idle", 11),
    ]
    const withQueuedTurnDone = [
      ...withForeignIdle,
      assistant("queued-assistant", "queued answer", 12),
      idle("queued-idle", 13),
    ]
    const snapshots = [withForeignIdle, withQueuedTurnDone]

    const { ctx } = makeContext({
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "queued-user",
      promptText: "queued prompt",
      admittedAt: 10,
      timeoutMs: 300,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("queued-idle")
    expect(summarizeTurn(result.messages, result.startIndex).text).toBe("queued answer")
  })

  it("P0-2: ignores an interrupted prior turn idle in steer delivery until the steered turn finishes", async () => {
    const withInterruptedOldIdle = [
      user("old-user", "old prompt", 1),
      assistant("old-assistant", "old answer", 2),
      user("steered-user", "steered prompt", 10),
      { id: "old-idle", type: "idle", outcome: "interrupted", time: { created: 11 } },
    ]
    const withSteeredTurnDone = [
      ...withInterruptedOldIdle,
      assistant("steered-assistant", "steered answer", 12),
      idle("steered-idle", 13),
    ]
    const snapshots = [withInterruptedOldIdle, withSteeredTurnDone]

    const { ctx } = makeContext({
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "steered-user",
      promptText: "steered prompt",
      admittedAt: 10,
      timeoutMs: 300,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("steered-idle")
    expect(summarizeTurn(result.messages, result.startIndex).text).toBe("steered answer")
  })

  it("P0-2: completes when a turn fails without an assistant message", async () => {
    const failedTurn = [
      user("u1", "prompt", 1),
      {
        id: "i_failed",
        type: "idle",
        outcome: "failed",
        error: { message: "provider rejected request" },
        time: { created: 2 },
      },
    ]
    const { ctx } = makeContext({
      context: () => failedTurn,
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "u1",
      timeoutMs: 300,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.outcome).toBe("failed")
    expect(result.lastError).toBe("provider rejected request")
  })

  it("P0-5: re-arms session.wait after a foreign idle without falling back to full polling", async () => {
    const old = [user("old", "old prompt", 1), assistant("old-answer", "old answer", 2), idle("old-idle", 3)]
    const queued = [
      ...old,
      user("queued", "queued prompt", 10),
      assistant("queued-answer", "queued answer", 11),
    ]
    const done = [...queued, idle("queued-idle", 12)]
    const snapshots = [old, queued, done]
    const { ctx, stats } = makeContext({
      wait: async () => {
        await delay(2)
      },
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "queued",
      promptText: "queued prompt",
      admittedAt: 10,
      timeoutMs: 500,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("queued-idle")
    expect(summarizeTurn(result.messages, result.startIndex).text).toBe("queued answer")
    expect(stats.waitCalls).toBeGreaterThanOrEqual(2)
    expect(stats.contextCalls).toBeLessThanOrEqual(4)
  })

  it("P0-5: re-subscribes to events after the stream closes before the anchored turn ends", async () => {
    const old = [user("old", "old prompt", 1), assistant("old-answer", "old answer", 2), idle("old-idle", 3)]
    const queued = [
      ...old,
      user("queued", "queued prompt", 10),
      assistant("queued-answer", "queued answer", 11),
    ]
    const done = [...queued, idle("queued-idle", 12)]
    const snapshots = [old, queued, done]
    const { ctx, stats } = makeContext({
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
      events: finiteEventStream([{ type: "session.idle", data: { sessionID: "ses_1" } }]),
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "queued",
      promptText: "queued prompt",
      admittedAt: 10,
      timeoutMs: 500,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("queued-idle")
    expect(stats.subscribeCalls).toBeGreaterThanOrEqual(2)
    expect(stats.contextCalls).toBeLessThanOrEqual(4)
  })

  it("P1-8: fallback uses session.get and reads the transcript at most three times", async () => {
    const running = [user("prompt", "hello", 1), assistant("answer", "world", 2)]
    const completed = [...running, idle("done", 3)]
    let getCount = 0
    const { ctx, stats } = makeContext({
      get: () => {
        getCount++
        return getCount < 4 ? { time: { busy: 1 } } : { time: { idle: 2 } }
      },
      context: () => (getCount < 4 ? running : completed),
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 500,
      requireAnchor: true,
      pollIntervalMs: 20,
      maxPollIntervalMs: 100,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("done")
    expect(stats.contextCalls).toBeLessThanOrEqual(3)
    expect(stats.getCalls).toBeGreaterThan(1)
  })

  it("P1-8: timeout performs a final read and returns idle when the turn completed", async () => {
    const started = Date.now()
    const running = [user("prompt", "hello", 1), assistant("answer", "world", 2)]
    const completed = [...running, idle("done", 3)]
    const { ctx, stats } = makeContext({
      context: () => (Date.now() - started < 45 ? running : completed),
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 60,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })

    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("done")
    expect(stats.contextCalls).toBeLessThanOrEqual(3)
  })

  it("P1-8: a real timeout still returns timeout with partial messages", async () => {
    const { ctx } = makeContext({
      context: () => [user("prompt", "still running")],
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 40,
      requireAnchor: true,
      pollIntervalMs: 10,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("timeout")
    expect(result.messages[0]?.id).toBe("prompt")
  })

  it("P1-1: session.status retry stays visible and does not fail the wait", async () => {
    const retryAt = Date.now() + 5_000
    const { ctx } = makeContext({
      context: () => [user("prompt", "hello", 1), assistant("answer", "world", 2), idle("done", 3)],
      events: eventStream(
        [
          {
            type: "session.status",
            data: {
              sessionID: "ses_1",
              status: { type: "retry", attempt: 2, message: "rate limited", next: retryAt },
            },
          },
          { type: "session.idle", data: { sessionID: "ses_1" } },
        ],
        5,
      ),
    })

    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 500,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
      progressIntervalMs: 1,
    })

    expect(result.state).toBe("idle")
    expect(result.retry).toMatchObject({
      attempt: 2,
      message: "rate limited",
      next: retryAt,
      at: retryAt,
      atISO: new Date(retryAt).toISOString(),
    })
    expect(result.retry?.inMs).toBeLessThanOrEqual(5_000)
    expect(result.lastError).toBeUndefined()
  })

  it("P1-3: session.execution.succeeded completes a turn without an idle message", async () => {
    const { ctx } = makeContext({
      context: () => [user("prompt", "hello", 1), assistant("answer", "world", 2)],
      events: finiteEventStream([
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ]),
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(result.idle).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(800)
  })

  it("P1-3: session.execution.succeeded completes a user-only turn without an assistant", async () => {
    const { ctx } = makeContext({
      context: () => [user("prompt", "hello", 1)],
      events: finiteEventStream([
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ]),
    })
    const started = Date.now()
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(Date.now() - started).toBeLessThan(800)
  })

  it("P1-3: session.retry.scheduled exposes the absolute retry timestamp", async () => {
    const retryAt = Date.now() + 3_000
    const { ctx } = makeContext({
      context: () => [user("prompt", "hello", 1), assistant("answer", "world", 2), idle("done", 3)],
      events: finiteEventStream([
        {
          type: "session.retry.scheduled",
          data: {
            sessionID: "ses_1",
            attempt: 3,
            at: retryAt,
            error: { message: "provider overloaded" },
          },
        },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ]),
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(result.retry).toMatchObject({
      attempt: 3,
      message: "provider overloaded",
      next: retryAt,
      at: retryAt,
      atISO: new Date(retryAt).toISOString(),
    })
  })

  it("P1-3: a foreign execution failure does not stick to a later successful turn", async () => {
    const snapshots = [
      [user("prompt", "hello", 1), assistant("answer", "world", 2)],
      [
        user("prompt", "hello", 1),
        assistant("answer", "world", 2),
        idle("done", 3),
      ],
    ]
    const { ctx } = makeContext({
      context: (call) => snapshots[Math.min(call - 1, snapshots.length - 1)],
      events: finiteEventStream([
        {
          type: "session.execution.failed",
          data: { sessionID: "ses_1", error: { message: "previous turn failed" } },
        },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ]),
    })
    const result = await waitForTurn(ctx, {
      sessionID: "ses_1",
      anchorID: "prompt",
      timeoutMs: 1_000,
      requireAnchor: true,
      pollIntervalMs: 20,
      permissionPollMs: 1_000,
    })
    expect(result.state).toBe("idle")
    expect(result.idle?.id).toBe("done")
    expect(result.lastError).toBeUndefined()
  })
})
