import { describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS, parseOptions } from "../src/options.ts"
import {
  parseListInput,
  parseOpenInput,
  parsePermissionsInput,
  parseReadInput,
  parseReplyInput,
  parseStatusInput,
  parseUpdateInput,
  ValidationError,
} from "../src/validation.ts"

describe("input validation", () => {
  it("uses defaults for zero in bounded numeric options", () => {
    expect(parseStatusInput({ sessionID: "ses_1", recent: 0 }, "en", DEFAULT_OPTIONS).recent).toBe(8)
    expect(parseReadInput({ sessionID: "ses_1", limit: 0 }, "en", DEFAULT_OPTIONS).limit).toBe(30)
    expect(parseListInput({ limit: 0 }, "en", DEFAULT_OPTIONS).limit).toBe(10)
    expect(
      parseOpenInput(
        { prompt: "hello", maxOutputChars: 0 },
        "en",
        DEFAULT_OPTIONS,
      ).maxOutputChars,
    ).toBe(DEFAULT_OPTIONS.maxOutputChars)
  })

  it("rejects invalid timeout, limit, recent, prompt, and budget values", () => {
    expect(() => parseOpenInput({ prompt: "hi", timeoutMs: -1 }, "en", DEFAULT_OPTIONS)).toThrow(
      ValidationError,
    )
    expect(() => parseOpenInput({ prompt: "hi", timeoutMs: 0 }, "en", DEFAULT_OPTIONS)).toThrow(
      ValidationError,
    )
    expect(() => parseReadInput({ sessionID: "ses_1", limit: -5 }, "en", DEFAULT_OPTIONS)).toThrow(
      ValidationError,
    )
    expect(() => parseStatusInput({ sessionID: "ses_1", recent: -1 }, "en", DEFAULT_OPTIONS)).toThrow(
      ValidationError,
    )
    expect(() => parseOpenInput({ prompt: "   " }, "en", DEFAULT_OPTIONS)).toThrow(ValidationError)
    expect(
      () => parseOpenInput({ prompt: "hi", maxOutputChars: 10 }, "en", DEFAULT_OPTIONS),
    ).toThrow(ValidationError)
  })

  it("rejects malformed model and permission rules", () => {
    expect(() => parseOpenInput({ prompt: "hi", model: "nope" }, "en", DEFAULT_OPTIONS)).toThrow(
      ValidationError,
    )
    expect(() =>
      parseOpenInput(
        { prompt: "hi", permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/allowPermissionRules/)
  })

  it("accepts allow rules only with opt-in", () => {
    const parsed = parseOpenInput(
      { prompt: "hi", permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
      "en",
      { ...DEFAULT_OPTIONS, allowPermissionRules: true },
    )
    expect(parsed.permissions).toHaveLength(1)
  })

  it("rejects invalid decisions", () => {
    expect(() =>
      parseReplyInput(
        { sessionID: "ses_1", requestID: "per_1", decision: "sometimes" },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(ValidationError)
  })

  it("P1-9: enforces prompt, title, search, rule, and metadata limits", () => {
    expect(() =>
      parseOpenInput(
        { prompt: "x".repeat(DEFAULT_OPTIONS.maxPromptChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/prompt/i)
    expect(() =>
      parseOpenInput(
        { prompt: "hi", title: "x".repeat(DEFAULT_OPTIONS.maxTitleChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/título|title/i)
    expect(() =>
      parseListInput(
        { search: "x".repeat(DEFAULT_OPTIONS.maxSearchChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/search/i)
    const rules = Array.from(
      { length: DEFAULT_OPTIONS.maxPermissionRules + 1 },
      () => ({ action: "shell", resource: "*", effect: "ask" as const }),
    )
    expect(() =>
      parseOpenInput({ prompt: "hi", permissions: rules }, "en", DEFAULT_OPTIONS),
    ).toThrow(/reglas|rules/i)
    expect(() =>
      parseUpdateInput(
        {
          sessionID: "ses_1",
          metadata: { big: "x".repeat(DEFAULT_OPTIONS.maxMetadataBytes) },
        },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/metadata/i)
    expect(
      parseOpenInput({ prompt: "ok" }, "en", DEFAULT_OPTIONS).prompt,
    ).toBe("ok")
  })

  it("P0-3: maxOutputTotalChars defaults to the configured maxOutputChars", () => {
    expect(parseOptions({ maxOutputChars: 50_000 }).maxOutputTotalChars).toBe(50_000)
    expect(
      parseOptions({ maxOutputChars: 50_000, maxOutputTotalChars: 30_000 })
        .maxOutputTotalChars,
    ).toBe(30_000)
  })

  it("accepts an omitted argument object for tools without required fields", () => {
    expect(parseListInput(undefined, "en", DEFAULT_OPTIONS).limit).toBe(10)
    expect(parseListInput(null, "en", DEFAULT_OPTIONS).limit).toBe(10)
  })

  it("P0-4: bounds IDs, agents, models, paths, and permission fields", () => {
    expect(() =>
      parseStatusInput(
        { sessionID: "s".repeat(DEFAULT_OPTIONS.maxIdChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/sessionID/i)
    expect(() =>
      parseOpenInput(
        { prompt: "hi", agent: "a".repeat(DEFAULT_OPTIONS.maxAgentChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/agent/i)
    expect(() =>
      parseOpenInput(
        { prompt: "hi", model: `p/${"m".repeat(DEFAULT_OPTIONS.maxModelChars)}` },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/model/i)
    expect(() =>
      parseListInput(
        { directory: "d".repeat(DEFAULT_OPTIONS.maxPathChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/directory/i)
    expect(() =>
      parsePermissionsInput(
        { sessionID: "s".repeat(DEFAULT_OPTIONS.maxIdChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/sessionID/i)
    expect(() =>
      parseOpenInput(
        {
          prompt: "hi",
          permissions: [
            {
              action: "a".repeat(DEFAULT_OPTIONS.maxPermissionFieldChars + 1),
              resource: "*",
              effect: "ask",
            },
          ],
        },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/action\/resource/i)
  })

  it("P0-4: prompt limits count Unicode code points, not UTF-16 units", () => {
    const emojis = "😀".repeat(60_000)
    expect(emojis.length).toBe(120_000)
    const parsed = parseOpenInput({ prompt: emojis }, "en", DEFAULT_OPTIONS)
    expect(parsed.prompt).toBe(emojis)
    expect(() =>
      parseOpenInput(
        { prompt: "😀".repeat(DEFAULT_OPTIONS.maxPromptChars + 1) },
        "en",
        DEFAULT_OPTIONS,
      ),
    ).toThrow(/prompt/i)
  })
})
