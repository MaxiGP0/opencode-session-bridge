import { describe, expect, it } from "vitest"
import {
  collectRecentTools,
  compact,
  fitBudget,
  formatError,
  formatSummary,
  isRunning,
  modelRef,
  parseModel,
  renderTranscript,
  summarizeTurn,
  titleFromPrompt,
  truncateCodePoints,
} from "../src/format.ts"

const idle = { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }

function tool(index: number) {
  return {
    type: "tool",
    id: `tool_${index}`,
    name: "read",
    state: {
      status: "completed",
      input: { path: `file-${index}.txt` },
      content: [{ type: "text", text: `body-${index}` }],
    },
  }
}

describe("isRunning", () => {
  it("ignores control messages after idle", () => {
    expect(isRunning({ time: {} }, [{ type: "idle" }, { type: "model-switched" }])).toBe(false)
    expect(isRunning({ time: {} }, [{ type: "idle" }, { type: "agent-switched" }])).toBe(false)
    expect(isRunning({ time: {} }, [{ type: "idle" }, { type: "system", text: "x" }])).toBe(false)
    expect(isRunning({ time: {} }, [{ type: "idle" }, { type: "skill", text: "x" }])).toBe(false)
  })

  it("uses timestamps before transcript heuristics", () => {
    expect(isRunning({ time: { busy: 10, idle: 5 } }, [idle])).toBe(true)
    expect(isRunning({ time: { busy: 5, idle: 10 } }, [{ type: "user" }])).toBe(false)
    expect(isRunning({ time: { busy: 10 } }, [])).toBe(true)
    expect(isRunning({ time: { idle: 10 } }, [])).toBe(false)
  })

  it("detects empty sessions and open turns", () => {
    expect(isRunning({ time: {} }, [])).toBe(false)
    expect(isRunning({ time: {} }, [{ type: "user" }])).toBe(true)
    expect(isRunning({ time: {} }, [{ type: "user" }, { type: "assistant" }])).toBe(true)
    expect(isRunning({ time: {} }, [{ type: "user" }, idle])).toBe(false)
  })
})

describe("robust helpers", () => {
  it("rejects incomplete model refs and normalizes whitespace", () => {
    expect(modelRef({ id: "m" })).toBeUndefined()
    expect(modelRef({ providerID: "p" })).toBeUndefined()
    expect(modelRef({ providerID: "p", id: "" })).toBeUndefined()
    expect(parseModel(" provider/model ")).toEqual({ providerID: "provider", id: "model" })
    expect(parseModel("provider/mod el")).toBeUndefined()
    expect(parseModel("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    })
  })

  it("does not throw on circular values", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => compact(circular)).not.toThrow()
    expect(compact(circular)).not.toBe("")
  })

  it("formats structured errors", () => {
    expect(formatError({ message: "boom", status: 500 })).toContain("boom")
    expect(formatError({ message: "boom", status: 500 })).toContain("500")
    expect(formatError("plain")).toBe("plain")
    expect(formatError(new Error("err"))).toBe("err")
  })

  it("truncates without splitting surrogate pairs", () => {
    const clipped = truncateCodePoints("😀😀😀", 2)
    expect(Array.from(clipped)).toHaveLength(2)
    expect(clipped).toBe("😀…")
    expect(Array.from(titleFromPrompt("😀".repeat(100)))).toHaveLength(60)
    expect(Array.from(fitBudget("😀".repeat(50), 10))).toHaveLength(10)
  })
})

describe("output budget", () => {
  it("summarizes omitted tools and stays within maxOutputChars", () => {
    const tools = Array.from({ length: 100 }, (_, index) => tool(index))
    const summary = summarizeTurn(
      [
        { id: "u1", type: "user", text: "run", time: { created: 1 } },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "done" }, ...tools],
          time: { created: 2 },
        },
        idle,
      ],
      0,
    )
    const report = formatSummary("Session: ses_1", summary, {
      lang: "en",
      maxOutputChars: 2_000,
      maxTools: 40,
    })
    expect(report.length).toBeLessThanOrEqual(2_000)
    expect(report).toContain("60 actions omitted")
  })

  it("reserves budget for the omission summary even with long assistant text", () => {
    const tools = Array.from({ length: 100 }, (_, index) => tool(index))
    const summary = summarizeTurn(
      [
        { id: "u1", type: "user", text: "run", time: { created: 1 } },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "x".repeat(20_000) }, ...tools],
          time: { created: 2 },
        },
        idle,
      ],
      0,
    )
    const report = formatSummary("Session: ses_1", summary, {
      lang: "en",
      maxOutputChars: 2_000,
      maxTools: 40,
      maxTextChars: 4_000,
    })
    expect(report.length).toBeLessThanOrEqual(2_000)
    expect(report).toContain("60 actions omitted")
  })

  it("treats zero helper limits as defaults, not unlimited", () => {
    const tools = Array.from({ length: 100 }, (_, index) => tool(index))
    const summary = summarizeTurn(
      [
        { id: "u1", type: "user", text: "run", time: { created: 1 } },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "done" }, ...tools],
          time: { created: 2 },
        },
        idle,
      ],
      0,
    )
    const report = formatSummary("Session: ses_1", summary, {
      lang: "en",
      maxOutputChars: 0,
      maxTextChars: 0,
      maxTools: 0,
      maxPermissions: 0,
    })
    expect(report.length).toBeLessThanOrEqual(20_000)
    expect(report).toContain("60 actions omitted")
  })

  it("collects only the most recent tools", () => {
    const messages = [
      {
        id: "a1",
        type: "assistant",
        content: Array.from({ length: 100 }, (_, index) => tool(index)),
        time: { created: 1 },
      },
    ]
    const recent = collectRecentTools(messages, 8)
    expect(recent).toHaveLength(8)
    expect(recent[0]?.id).toBe("tool_92")
    expect(recent[7]?.id).toBe("tool_99")
  })
})

describe("renderTranscript", () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `u${index}`,
    type: "user",
    text: `message ${index}`,
    time: { created: index },
  }))

  it("limits the transcript instead of returning everything", () => {
    const content = renderTranscript(messages, {
      lang: "en",
      limit: 30,
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect((content.match(/User:/g) ?? []).length).toBe(30)
    expect(content).not.toContain("message 0")
    expect(content).toContain("message 39")
  })

  it("treats a zero limit as the default in the pure renderer too", () => {
    const content = renderTranscript(messages, {
      lang: "en",
      limit: 0,
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect((content.match(/User:/g) ?? []).length).toBe(30)
  })

  it("warns when afterMessageID does not exist", () => {
    const content = renderTranscript(messages, {
      lang: "en",
      limit: 30,
      afterMessageID: "missing",
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect(content).toContain("afterMessageID not found: missing")
    expect((content.match(/User:/g) ?? []).length).toBe(30)
  })

  it("includes reasoning only when requested", () => {
    const withReasoning = [
      {
        id: "a1",
        type: "assistant",
        content: [
          { type: "reasoning", text: "think carefully" },
          { type: "text", text: "answer" },
        ],
        time: { created: 1 },
      },
    ]
    const without = renderTranscript(withReasoning, {
      lang: "en",
      limit: 30,
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    const withFlag = renderTranscript(withReasoning, {
      lang: "en",
      limit: 30,
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: true,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect(without).not.toContain("think carefully")
    expect(withFlag).toContain("think carefully")
  })

  it("respects the transcript budget", () => {
    const content = renderTranscript(messages, {
      lang: "en",
      limit: 40,
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 500,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect(content.length).toBeLessThanOrEqual(500)
  })
})
