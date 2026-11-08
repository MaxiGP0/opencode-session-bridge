import { describe, expect, it } from "vitest"
import { createLiveState } from "../src/live.ts"

describe("live state", () => {
  it("P1-4: execution events update status, outcome, and error", () => {
    let now = 1_000
    const live = createLiveState({ now: () => now })
    live.applyEvent({
      type: "session.execution.started",
      data: { sessionID: "ses_1" },
    })
    expect(live.get("ses_1").status).toEqual({ type: "busy" })

    live.applyEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { message: "provider boom" } },
    })
    expect(live.get("ses_1")).toMatchObject({
      status: { type: "idle" },
      lastOutcome: "failed",
      lastError: "provider boom",
      statusAt: 1_000,
    })

    now = 1_100
    live.applyEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
    })
    expect(live.get("ses_1")).toMatchObject({
      status: { type: "idle" },
      lastOutcome: "succeeded",
    })
    expect(live.get("ses_1").lastError).toBeUndefined()
  })

  it("P1-4: retry.scheduled uses the absolute timestamp", () => {
    const live = createLiveState({ now: () => 5_000 })
    live.applyEvent({
      type: "session.retry.scheduled",
      data: {
        sessionID: "ses_1",
        attempt: 4,
        at: 9_000,
        error: { message: "rate limited" },
      },
    })
    expect(live.get("ses_1").status).toEqual({
      type: "retry",
      attempt: 4,
      message: "rate limited",
      next: 9_000,
    })
  })

  it("P1-4: pending entries expire with the pending TTL", () => {
    let now = 1_000
    const live = createLiveState({ now: () => now, pendingTtlMs: 500 })
    live.notePrompt({ sessionID: "ses_1", messageID: "msg_1", delivery: "queue" })
    expect(live.get("ses_1").pending).toHaveLength(1)
    now = 1_600
    expect(live.get("ses_1").pending).toHaveLength(0)
    expect(live.stats().pending).toBe(0)
  })

  it("P1-4: reconcile removes delivered pending entries and stats stay bounded", () => {
    const live = createLiveState({ now: () => 1_000 })
    live.notePrompt({ sessionID: "ses_1", messageID: "msg_1", delivery: "queue" })
    live.notePrompt({ sessionID: "ses_1", messageID: "msg_2", delivery: "queue" })
    live.reconcile("ses_1", [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
    ])
    expect(live.get("ses_1").pending.map((entry) => entry.messageID)).toEqual(["msg_2"])
    expect(live.stats()).toMatchObject({ sessions: 1, pending: 1 })
  })
})
