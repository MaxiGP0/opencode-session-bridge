import { describe, expect, it } from "vitest"
import { boundOutputTotal, jsonSafe } from "../src/output.ts"

describe("jsonSafe", () => {
  it("P1-11: handles self-referencing arrays without a stack overflow", () => {
    const array: unknown[] = ["ok"]
    array.push(array)
    expect(() => jsonSafe(array)).not.toThrow()
    const safe = jsonSafe(array) as unknown[]
    expect(safe[0]).toBe("ok")
    expect(safe[1]).toBe("[Circular]")
    expect(() => JSON.stringify(safe)).not.toThrow()

    const object: Record<string, unknown> = { id: "x" }
    object.self = object
    expect(jsonSafe(object)).toEqual({ id: "x", self: "[Circular]" })
  })

  it("P1-11: keeps sibling arrays after a circular one", () => {
    const shared = { id: "shared" }
    const array: unknown[] = [shared, shared]
    const wrapped = { array, after: "kept" }
    const safe = jsonSafe(wrapped) as Record<string, unknown>
    expect(safe.after).toBe("kept")
    expect((safe.array as unknown[])[1]).toEqual({ id: "shared" })
  })

  it("P1-11: boundOutputTotal tolerates circular arrays after jsonSafe", () => {
    const array: unknown[] = []
    array.push(array)
    const output = { candidates: array, state: "ok" }
    const safe = jsonSafe(output) as Record<string, unknown>
    const bounded = boundOutputTotal(safe, 10_000)
    expect(() => JSON.stringify(bounded)).not.toThrow()
  })
})
