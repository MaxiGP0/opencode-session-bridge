import { describe, expect, it } from "vitest"
import { assertPermission, promptMessageID } from "../src/runtime.ts"

type AssertContext = Parameters<typeof assertPermission>[0]
type ExecuteContext = Parameters<typeof assertPermission>[1]

describe("promptMessageID", () => {
  it("preserves API-valid IDs", () => {
    expect(promptMessageID("msg_abc", "open:/repo")).toBe("msg_abc")
  })

  it("derives a stable msg_ ID for arbitrary idempotency keys", () => {
    const first = promptMessageID("custom-key", "open:/repo")
    const second = promptMessageID("custom-key", "open:/repo")
    expect(first).toMatch(/^msg_[a-f0-9]{32}$/)
    expect(second).toBe(first)
    expect(first).not.toBe("custom-key")
  })

  it("scopes the same key to different sessions", () => {
    const a = promptMessageID("same-key", "send:ses_a")
    const b = promptMessageID("same-key", "send:ses_b")
    expect(a).toMatch(/^msg_/)
    expect(b).toMatch(/^msg_/)
    expect(a).not.toBe(b)
  })

  it("returns undefined when no key is provided", () => {
    expect(promptMessageID(undefined, "open:/repo")).toBeUndefined()
  })
})

describe("assertPermission", () => {
  it("omits undefined metadata and source from the host request", async () => {
    const calls: unknown[] = []
    const ctx = {
      permission: {
        assert: async (input: unknown) => {
          calls.push(input)
        },
      },
    } as unknown as AssertContext
    const context = { sessionID: "ses_1" } as unknown as ExecuteContext

    await assertPermission(ctx, context, "session_bridge.apply", ["race", "candidate"])
    expect(calls[0]).not.toHaveProperty("metadata")
    expect(calls[0]).not.toHaveProperty("source")
    expect(calls[0]).toMatchObject({
      sessionID: "ses_1",
      action: "session_bridge.apply",
      resources: ["race", "candidate"],
    })

    await assertPermission(ctx, context, "session_bridge.apply", ["race"], {
      mode: "apply",
    })
    expect(calls[1]).toMatchObject({ metadata: { mode: "apply" } })
  })
})
