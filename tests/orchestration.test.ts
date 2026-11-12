import { describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import { workerPermissionRules } from "../src/orchestration.ts"
import type { WorkerPermissionRule } from "../src/orchestration.ts"

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

function lastMatching(
  rules: WorkerPermissionRule[],
  action: string,
  resource: string,
): WorkerPermissionRule | undefined {
  return rules.filter(
    (rule) => globMatches(rule.action, action) && globMatches(rule.resource, resource),
  ).at(-1)
}

describe("worker permission preset", () => {
  it("P0-1: keeps denials last so caller allow rules cannot widen the worker", () => {
    const rules = workerPermissionRules(
      { ...DEFAULT_OPTIONS, allowPermissionRules: true },
      [
        { action: "session_bridge.open", resource: "*", effect: "allow" },
        { action: "session_bridge.race", resource: "*", effect: "allow" },
        { action: "shell", resource: "*git push*", effect: "allow" },
        { action: "shell", resource: "*git worktree*", effect: "allow" },
        { action: "shell", resource: "*--force*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "shell", resource: "git status", effect: "allow" },
        { action: "shell", resource: "npm test*", effect: "deny" },
      ],
    )

    expect(lastMatching(rules, "session_bridge.open", "anything")?.effect).toBe("deny")
    expect(lastMatching(rules, "session_bridge.race", "anything")?.effect).toBe("deny")
    expect(lastMatching(rules, "session_bridge.waitAny", "ses_1")?.effect).toBe("deny")
    expect(lastMatching(rules, "session_bridge.waitAll", "ses_1")?.effect).toBe("deny")
    expect(lastMatching(rules, "shell", "git push origin main")?.effect).toBe("deny")
    expect(lastMatching(rules, "shell", "git worktree add x")?.effect).toBe("deny")
    expect(lastMatching(rules, "shell", "rm --force x")?.effect).toBe("deny")
    expect(lastMatching(rules, "external_directory", "C:/outside")?.effect).toBe("deny")

    // A harmless allow is preserved (before the denials).
    expect(lastMatching(rules, "shell", "git status")?.effect).toBe("allow")
    // Additional deny rules from the caller are preserved.
    expect(lastMatching(rules, "shell", "npm test")?.effect).toBe("deny")
  })

  it("P0-1: still filters allow rules when allowPermissionRules is false", () => {
    const rules = workerPermissionRules(DEFAULT_OPTIONS, [
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "shell", resource: "npm test", effect: "deny" },
    ])
    expect(rules.some((rule) => rule.effect === "allow")).toBe(false)
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource === "npm test")).toBe(true)
  })
})
