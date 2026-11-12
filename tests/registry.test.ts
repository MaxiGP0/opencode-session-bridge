import { describe, expect, it } from "vitest"
import {
  createRegistryPersistence,
  forgetOpenSessionsBySessionID,
  forgetOwnedSession,
  isOwnedSession,
  isWorkerSession,
  loadOpenSessions,
  loadOwnedSessions,
  lookupOpenSession,
  OWNED_TTL_MS,
  rememberOpenSession,
  rememberOwnedSession,
  rememberWorkerSession,
  touchWorkerSession,
  WORKER_TTL_MS,
  type OpenSessionMapping,
  type OwnedSessions,
  type WorkerSessions,
} from "../src/registry.ts"
import type { PluginContext } from "../src/types.ts"

function makeContext(directory: string, storage = new Map<string, unknown>()) {
  const ctx = {
    location: { directory },
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
  }
  return { ctx: ctx as unknown as PluginContext, storage }
}

describe("session registry", () => {
  it("P1-5: keeps the most recently used owned session when pruning", async () => {
    const { ctx } = makeContext("C:/repo")
    const sessions: OwnedSessions = new Map()
    for (let index = 0; index < 500; index++) {
      await rememberOwnedSession(ctx, sessions, `ses_${index}`, "C:/repo")
    }
    await rememberOwnedSession(ctx, sessions, "ses_0", "C:/repo")
    await rememberOwnedSession(ctx, sessions, "ses_500", "C:/repo")
    expect(sessions.size).toBe(500)
    expect(isOwnedSession(sessions, "ses_0", "C:/repo")).toBe(true)
    expect(isOwnedSession(sessions, "ses_1", "C:/repo")).toBe(false)
  })

  it("P1-5: expires owned sessions by TTL and validates the directory", () => {
    const sessions: OwnedSessions = new Map([
      ["ses_old", { at: Date.now() - OWNED_TTL_MS - 1, directory: "C:/repo" }],
      ["ses_recent", { at: Date.now(), directory: "C:/repo" }],
    ])
    expect(isOwnedSession(sessions, "ses_old", "C:/repo")).toBe(false)
    expect(isOwnedSession(sessions, "ses_recent", "C:/repo")).toBe(true)
    expect(isOwnedSession(sessions, "ses_recent", "C:/other")).toBe(false)
  })

  it("P1-5: isolates storage by directory and migrates the old array format", async () => {
    const shared = new Map<string, unknown>()
    const a = makeContext("C:/a", shared)
    const b = makeContext("C:/b", shared)
    const sessionsA: OwnedSessions = new Map()
    await rememberOwnedSession(a.ctx, sessionsA, "ses_a", "C:/a")
    const loadedB = await loadOwnedSessions(b.ctx)
    expect(loadedB.has("ses_a")).toBe(false)
    const loadedA = await loadOwnedSessions(a.ctx)
    expect(loadedA.has("ses_a")).toBe(true)

    const legacy = makeContext("C:/legacy", new Map([["session-bridge:owned-sessions", ["ses_legacy"]]]))
    const loadedLegacy = await loadOwnedSessions(legacy.ctx)
    expect(loadedLegacy.has("ses_legacy")).toBe(true)
  })

  it("P1-5: removes owned and open mappings", async () => {
    const { ctx } = makeContext("C:/repo")
    const sessions: OwnedSessions = new Map()
    await rememberOwnedSession(ctx, sessions, "ses_1", "C:/repo")
    await forgetOwnedSession(ctx, sessions, "ses_1")
    expect(sessions.has("ses_1")).toBe(false)

    const mapping: OpenSessionMapping = new Map()
    await rememberOpenSession(ctx, mapping, "msg_1", "ses_1", "C:/repo")
    await rememberOpenSession(ctx, mapping, "msg_2", "ses_1", "C:/repo")
    await rememberOpenSession(ctx, mapping, "msg_3", "ses_2", "C:/repo")
    await forgetOpenSessionsBySessionID(ctx, mapping, "ses_1")
    expect(mapping.size).toBe(1)
    expect(mapping.has("msg_3")).toBe(true)
  })

  it("P1-5: does not reuse an open mapping from another directory", async () => {
    const { ctx } = makeContext("C:/repo")
    const mapping: OpenSessionMapping = new Map()
    await rememberOpenSession(ctx, mapping, "msg_same", "ses_same", "C:/repo")
    expect(lookupOpenSession(mapping, "msg_same", "C:/repo")).toBe("ses_same")

    await rememberOpenSession(ctx, mapping, "msg_other", "ses_other", "C:/other")
    expect(lookupOpenSession(mapping, "msg_other", "C:/repo")).toBeUndefined()

    const loaded = await loadOpenSessions(ctx)
    expect(loaded.has("msg_other")).toBe(false)
  })

  it("P1-5: shares the storage namespace across equivalent directory spellings", async () => {
    const shared = new Map<string, unknown>()
    const writer = makeContext("C:/repo/", shared)
    const reader = makeContext("C:/repo", shared)
    const sessions: OwnedSessions = new Map()
    await rememberOwnedSession(writer.ctx, sessions, "ses_trailing", "C:/repo/")
    const loaded = await loadOwnedSessions(reader.ctx)
    expect(loaded.has("ses_trailing")).toBe(true)
  })

  it("P0-4: keeps the worker role beyond the old TTL and touches it cheaply", async () => {
    const { ctx } = makeContext("C:/repo")
    const workers: WorkerSessions = new Map()
    await rememberWorkerSession(ctx, workers, {
      sessionID: "ses_old_worker",
      targetDirectory: "C:/repo",
      at: Date.now() - WORKER_TTL_MS - 1,
    })
    expect(isWorkerSession(workers, "ses_old_worker")).toMatchObject({
      sessionID: "ses_old_worker",
      role: "worker",
    })

    const first = touchWorkerSession(workers, "ses_old_worker")
    expect(first.persist).toBe(true)
    const later = Date.now() + 1_000
    const second = touchWorkerSession(workers, "ses_old_worker", later)
    expect(second.persist).toBe(false)
    expect(second.entry?.at).toBe(later)
  })

  it("P0-4: LRU eviction prefers stale workers and never drops a recently seen one", async () => {
    const { ctx } = makeContext("C:/repo")
    const workers: WorkerSessions = new Map()
    const now = Date.now()
    workers.set("ses_recent", {
      sessionID: "ses_recent",
      at: now,
      targetDirectory: "C:/repo",
      role: "worker",
    })
    for (let index = 0; index < 500; index++) {
      workers.set(`ses_stale_${index}`, {
        sessionID: `ses_stale_${index}`,
        at: now - 2 * 60 * 60 * 1_000,
        targetDirectory: "C:/repo",
        role: "worker",
      })
    }
    await rememberWorkerSession(ctx, workers, {
      sessionID: "ses_new",
      targetDirectory: "C:/repo",
    })
    expect(workers.size).toBe(500)
    expect(workers.has("ses_recent")).toBe(true)
    expect(workers.has("ses_new")).toBe(true)
    expect(workers.has("ses_stale_0")).toBe(false)
  })

  it("P1-7: coalesces registry writes and flushes the final state", async () => {
    const stored = new Map<string, unknown>()
    let writes = 0
    const ctx = {
      location: { directory: "C:/repo" },
      storage: {
        get: async (key: string) => stored.get(key),
        set: async (key: string, value: unknown) => {
          writes++
          stored.set(key, value)
        },
        remove: async (key: string) => {
          stored.delete(key)
        },
        scan: async () => ({ entries: [] }),
      },
    } as unknown as PluginContext
    const owned: OwnedSessions = new Map()
    const open: OpenSessionMapping = new Map()
    const store = createRegistryPersistence(ctx, owned, open, { flushDelayMs: 60_000 })

    for (let index = 0; index < 10; index++) {
      store.rememberOwned(`ses_${index}`, "C:/repo")
      store.rememberOpen(`msg_${index}`, `ses_${index}`, "C:/repo")
    }
    expect(writes).toBe(0)
    expect(store.stats()).toMatchObject({ owned: 10, open: 10, dirtyOwned: true, dirtyOpen: true })

    await store.flush()
    expect(writes).toBe(2)
    expect(store.stats()).toMatchObject({ dirtyOwned: false, dirtyOpen: false })
    expect((await loadOwnedSessions(ctx)).size).toBe(10)
    expect((await loadOpenSessions(ctx)).size).toBe(10)

    store.forgetOwned("ses_0")
    await store.flush()
    expect((await loadOwnedSessions(ctx)).has("ses_0")).toBe(false)
    await store.dispose()
  })
})
