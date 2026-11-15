import { describe, expect, it } from "vitest"
import { loadWorktrees } from "../src/worktrees.ts"
import type { PluginContext } from "../src/types.ts"

function worktreeContext(storage: Map<string, unknown>): PluginContext {
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
  } as unknown as PluginContext
}

describe("worktree registry pruning", () => {
  it("P2-3: never evicts a ready worktree with sessions under the soft cap", async () => {
    const storage = new Map<string, unknown>()
    const now = Date.now()
    const records: Array<Record<string, unknown>> = Array.from(
      { length: 200 },
      (_, index) => ({
        directory: `C:/worktrees/removed-${index}`,
        runID: "run_removed",
        createdAt: now,
        sessions: [],
        strategy: "worktree",
        state: "removed",
      }),
    )
    records.push({
      directory: "C:/worktrees/live",
      runID: "run_live",
      createdAt: now - 2 * 60 * 60 * 1_000,
      sessions: ["ses_live"],
      strategy: "worktree",
      state: "ready",
    })
    storage.set("session-bridge:worktrees", records)
    const loaded = await loadWorktrees(worktreeContext(storage))
    const directories = [...loaded.values()].map((record) => record.directory)
    expect(loaded.size).toBe(200)
    expect(directories).toContain("C:/worktrees/live")
    expect(directories).not.toContain("C:/worktrees/removed-0")
  })
})
