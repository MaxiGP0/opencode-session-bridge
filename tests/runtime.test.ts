import { describe, expect, it } from "vitest"
import { promptMessageID } from "../src/runtime.ts"

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
