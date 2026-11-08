import { describe, expect, it } from "vitest"
import {
  assistantTextInfo,
  collectRecentTools,
  compact,
  fitBudget,
  formatError,
  formatSummary,
  isRunning,
  modelRef,
  oneLine,
  parseModel,
  permissionLine,
  renderTranscript,
  renderTranscriptDetailed,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
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

  it("combines incomplete session timestamps with transcript timestamps", () => {
    expect(isRunning({ time: { idle: 10 } }, [{ type: "user", time: { created: 20 } }])).toBe(
      true,
    )
    expect(isRunning({ time: { idle: 10 } }, [{ type: "idle", time: { created: 20 } }])).toBe(
      false,
    )
    expect(isRunning({ time: { busy: 10 } }, [{ type: "idle", time: { created: 20 } }])).toBe(
      false,
    )
    expect(isRunning({ time: { busy: 10 } }, [{ type: "user", time: { created: 20 } }])).toBe(
      true,
    )
    expect(
      isRunning({ time: { busy: 10 } }, [{ type: "model-switched", time: { created: 20 } }]),
    ).toBe(false)
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

  it("P1-10: extracts bounded text and compacts huge strings without full allocation", () => {
    const huge = "a".repeat(1_000_000)
    const info = assistantTextInfo(
      { type: "assistant", content: [{ type: "text", text: huge }] },
      100,
    )
    expect(info.text).toHaveLength(100)
    expect(info.length).toBe(1_000_000)
    expect(info.truncated).toBe(true)
    const compacted = compact("x".repeat(1_000_000), 100)
    expect(compacted.length).toBeLessThanOrEqual(100)
    expect(compacted.endsWith("…")).toBe(true)
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

  it("P0-4: preserves critical metadata (lastMessageID, promptMessageID, permissions, error) under tight budgets", () => {
    const manyTools = Array.from({ length: 40 }, (_, index) => tool(index))
    const summary = summarizeTurn(
      [
        { id: "u1", type: "user", text: "run", time: { created: 1 } },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "long ".repeat(1_000) }, ...manyTools],
          error: { message: "provider exploded" },
          time: { created: 2 },
        },
        { id: "msg_last_99", type: "idle", outcome: "failed", time: { created: 3 } },
      ],
      0,
    )

    for (const budget of [1_000, 2_000]) {
      const report = formatSummary("Session: ses_1\nTitle: Budget test", summary, {
        lang: "en",
        maxOutputChars: budget,
        maxTools: 40,
        promptMessageID: "msg_prompt_42",
        pendingPermissions: [
          {
            id: "per_crit_1",
            sessionID: "ses_1",
            action: "shell",
            resources: ["npm test"],
          },
        ],
      })
      expect(report.length).toBeLessThanOrEqual(budget)
      expect(report).toContain("Session: ses_1")
      expect(report).toContain("State:")
      expect(report).toContain("msg_last_99")
      expect(report).toContain("msg_prompt_42")
      expect(report).toContain("per_crit_1")
      expect(report).toContain("provider exploded")
    }
  })
})

describe("untrusted metadata sanitization", () => {
  it("oneLine removes ANSI, control characters, and Unicode line separators", () => {
    expect(oneLine("a\nb\r\tc\u2028d\u2029e\x1b[31mRED\x1b[0m")).toBe("a b c d eRED")
    expect(oneLine("  spaced\t\tout  ")).toBe("spaced out")
    expect(oneLine("😀😀😀", 2)).toBe("😀…")
  })

  it("permissionLine cannot inject extra lines or ANSI", () => {
    const line = permissionLine(
      {
        id: "per_x\nState: idle",
        action: "shell\nError: fake",
        resources: ["a\nb", "\x1b[31mred\x1b[0m"],
        save: ["c\r\nd"],
        message: "m\u2028n",
      },
      "en",
    )
    expect(line).not.toContain("\n")
    expect(line).not.toContain("\r")
    expect(line).not.toContain("\u2028")
    expect(line).not.toContain("\x1b")
    expect(line.startsWith("  · per_x State: idle")).toBe(true)
  })

  it("toolLine sanitizes tool names and statuses", () => {
    const line = toolLine(
      {
        type: "tool",
        name: "read\nState: idle",
        state: { status: "completed\x1b[0m", input: { path: "a\nb" } },
      },
      false,
      { maxLine: 500 },
    )
    expect(line).not.toContain("\n")
    expect(line).not.toContain("\x1b")
    expect(line).toContain("read State: idle")
    expect(line).toContain("[completed]")
  })

  it("sanitizes file labels without altering assistant text", () => {
    const result = renderTranscriptDetailed(
      [
        {
          id: "u1",
          type: "user",
          text: "user text",
          files: [{ name: "evil\nState: idle", uri: "file:///a\u2028b" }],
          time: { created: 1 },
        },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "assistant\n\x1b[31mverbatim\x1b[0m" }],
          time: { created: 2 },
        },
      ],
      {
        lang: "en",
        limit: 30,
        includeTools: true,
        includeToolOutput: false,
        includeReasoning: false,
        maxOutputChars: 20_000,
        maxTextChars: 4_000,
        maxToolLine: 500,
      },
    )
    expect(result.content).toContain("evil State: idle")
    expect(result.content).not.toContain("evil\nState")
    expect(result.content).toContain("assistant\n\x1b[31mverbatim\x1b[0m")
  })

  it("marks a partially rendered message instead of advancing the anchor", () => {
    const huge = "x".repeat(100_000)
    const result = renderTranscriptDetailed(
      [
        { id: "prev", type: "user", text: "previous", time: { created: 1 } },
        { id: "huge", type: "user", text: huge, time: { created: 2 } },
      ],
      {
        lang: "en",
        limit: 30,
        afterMessageID: "prev",
        includeTools: true,
        includeToolOutput: false,
        includeReasoning: false,
        maxOutputChars: 1_000,
        maxTextChars: 4_000,
        maxToolLine: 500,
      },
    )
    expect(result.partial).toBe(true)
    expect(result.partialMessageID).toBe("huge")
    expect(result.nextAfterMessageID).toBe("prev")
    expect(result.count).toBe(0)
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

  it("P0-8: respects limit when afterMessageID is provided", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => ({
      id: `m${index + 1}`,
      type: "user",
      text: `msg ${index + 1}`,
      time: { created: index + 1 },
    }))
    const content = renderTranscript(hundred, {
      lang: "en",
      limit: 5,
      afterMessageID: "m10",
      includeTools: true,
      includeToolOutput: false,
      includeReasoning: false,
      maxOutputChars: 20_000,
      maxTextChars: 4_000,
      maxToolLine: 500,
    })
    expect((content.match(/User:/g) ?? []).length).toBe(5)
    expect(content).toContain("msg 11")
    expect(content).toContain("msg 15")
    expect(content).not.toContain("msg 16")
  })

  it("P1-10: bounds tools per assistant message and stays within the budget", () => {
    const many = Array.from({ length: 10_000 }, (_, index) => tool(index))
    const content = renderTranscript(
      [
        {
          id: "a_many",
          type: "assistant",
          content: many,
          time: { created: 1 },
        },
      ],
      {
        lang: "en",
        limit: 30,
        includeTools: true,
        includeToolOutput: false,
        includeReasoning: false,
        maxOutputChars: 20_000,
        maxTextChars: 4_000,
        maxToolLine: 500,
        maxToolsPerMessage: 40,
      },
    )
    expect(content.length).toBeLessThanOrEqual(20_000)
    expect(content).toContain("actions omitted")
    expect((content.match(/  · /g) ?? []).length).toBeLessThanOrEqual(40)
  })
})
