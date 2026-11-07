import { describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import {
  parseListInput,
  parseOpenInput,
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
})
