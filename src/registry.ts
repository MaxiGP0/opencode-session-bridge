import type { PluginContext } from "./types.ts"

const OWNED_KEY = "session-bridge:owned-sessions"
const OPEN_KEY = "session-bridge:open-sessions"
const MAX_OWNED = 500
const MAX_OPEN = 500
const OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const OWNED_TTL_MS = 30 * 24 * 60 * 60 * 1_000

export type OwnedSessionEntry = {
  at: number
  directory?: string
}

export type OwnedSessions = Map<string, OwnedSessionEntry>

export type OpenSessionEntry = {
  sessionID: string
  at: number
  directory?: string
}

export type OpenSessionMapping = Map<string, OpenSessionEntry>

function directoryOf(ctx: PluginContext): string | undefined {
  try {
    return ctx.location?.directory
  } catch {
    return undefined
  }
}

/**
 * Stable 32-bit FNV-1a hash used only to build a short, deterministic storage
 * namespace per directory. It is not a security primitive.
 */
function directoryNamespace(directory: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < directory.length; index++) {
    hash ^= directory.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function storageKey(base: string, directory: string | undefined): string {
  return directory ? `${base}:${directoryNamespace(directory)}` : base
}

function readStoredEntries(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return []
  const result: Record<string, unknown>[] = []
  for (const value of raw) {
    if (typeof value === "string" && value) {
      result.push({ sessionID: value })
    } else if (value && typeof value === "object") {
      result.push(value as Record<string, unknown>)
    }
  }
  return result
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function validDirectory(value: unknown, current: string | undefined): string | undefined {
  if (typeof value !== "string" || !value) return current
  if (current && value !== current) return undefined
  return value
}

export function pruneOwnedSessions(sessions: OwnedSessions, now = Date.now()): void {
  for (const [sessionID, entry] of sessions) {
    if (now - entry.at > OWNED_TTL_MS) sessions.delete(sessionID)
  }
  while (sessions.size > MAX_OWNED) {
    const oldest = sessions.keys().next().value
    if (typeof oldest !== "string") break
    sessions.delete(oldest)
  }
}

export async function loadOwnedSessions(ctx: PluginContext): Promise<OwnedSessions> {
  const sessions: OwnedSessions = new Map()
  const directory = directoryOf(ctx)
  try {
    const namespaced = await ctx.storage?.get(storageKey(OWNED_KEY, directory))
    const raw =
      namespaced === undefined || namespaced === null
        ? await ctx.storage?.get(OWNED_KEY)
        : namespaced
    const now = Date.now()
    for (const record of readStoredEntries(raw)) {
      const sessionID = typeof record.sessionID === "string" ? record.sessionID : ""
      if (!sessionID) continue
      const at = validTimestamp(record.at) ?? now
      const entryDirectory = validDirectory(record.directory, directory)
      if (record.directory !== undefined && entryDirectory === undefined) continue
      sessions.delete(sessionID)
      sessions.set(sessionID, { at, ...(entryDirectory ? { directory: entryDirectory } : {}) })
    }
    pruneOwnedSessions(sessions, now)
  } catch {
    return new Map()
  }
  return sessions
}

export async function persistOwnedSessions(
  ctx: PluginContext,
  sessions: OwnedSessions,
): Promise<void> {
  const directory = directoryOf(ctx)
  try {
    const values: Array<Record<string, string | number>> = [...sessions].map(
      ([sessionID, entry]) => ({
        sessionID,
        at: entry.at,
        directory: entry.directory ?? directory ?? "",
      }),
    )
    await ctx.storage?.set(storageKey(OWNED_KEY, directory), values)
  } catch {
    // Storage is optional; the in-memory registry still protects this process.
  }
}

export async function rememberOwnedSession(
  ctx: PluginContext,
  sessions: OwnedSessions,
  sessionID: string,
  directory = directoryOf(ctx),
): Promise<void> {
  sessions.delete(sessionID)
  sessions.set(sessionID, {
    at: Date.now(),
    ...(directory ? { directory } : {}),
  })
  pruneOwnedSessions(sessions)
  await persistOwnedSessions(ctx, sessions)
}

export async function forgetOwnedSession(
  ctx: PluginContext,
  sessions: OwnedSessions,
  sessionID: string,
): Promise<void> {
  if (!sessions.delete(sessionID)) return
  await persistOwnedSessions(ctx, sessions)
}

export function isOwnedSession(
  sessions: OwnedSessions,
  sessionID: string,
  directory?: string,
  now = Date.now(),
): boolean {
  const entry = sessions.get(sessionID)
  if (!entry) return false
  if (now - entry.at > OWNED_TTL_MS) {
    sessions.delete(sessionID)
    return false
  }
  if (directory && entry.directory && entry.directory !== directory) return false
  return true
}

export function pruneOpenSessions(
  mapping: OpenSessionMapping,
  now = Date.now(),
  directory?: string,
): void {
  for (const [messageID, entry] of mapping) {
    if (!entry.sessionID || now - entry.at > OPEN_TTL_MS) {
      mapping.delete(messageID)
      continue
    }
    if (directory && entry.directory && entry.directory !== directory) {
      mapping.delete(messageID)
    }
  }
  while (mapping.size > MAX_OPEN) {
    const oldest = mapping.keys().next().value
    if (typeof oldest !== "string") break
    mapping.delete(oldest)
  }
}

export async function loadOpenSessions(ctx: PluginContext): Promise<OpenSessionMapping> {
  const mapping: OpenSessionMapping = new Map()
  const directory = directoryOf(ctx)
  try {
    const namespaced = await ctx.storage?.get(storageKey(OPEN_KEY, directory))
    const raw =
      namespaced === undefined || namespaced === null
        ? await ctx.storage?.get(OPEN_KEY)
        : namespaced
    for (const record of readStoredEntries(raw)) {
      const messageID = typeof record.messageID === "string" ? record.messageID : ""
      const sessionID = typeof record.sessionID === "string" ? record.sessionID : ""
      if (!messageID || !sessionID) continue
      const at = validTimestamp(record.at) ?? Date.now()
      const entryDirectory = validDirectory(record.directory, directory)
      if (record.directory !== undefined && entryDirectory === undefined) continue
      mapping.delete(messageID)
      mapping.set(messageID, {
        sessionID,
        at,
        ...(entryDirectory ? { directory: entryDirectory } : {}),
      })
    }
    pruneOpenSessions(mapping, Date.now(), directory)
  } catch {
    return new Map()
  }
  return mapping
}

export async function persistOpenSessions(
  ctx: PluginContext,
  mapping: OpenSessionMapping,
): Promise<void> {
  const directory = directoryOf(ctx)
  try {
    const values: Array<Record<string, string | number>> = [...mapping].map(
      ([messageID, entry]) => ({
        messageID,
        sessionID: entry.sessionID,
        at: entry.at,
        directory: entry.directory ?? directory ?? "",
      }),
    )
    await ctx.storage?.set(storageKey(OPEN_KEY, directory), values)
  } catch {
    // Storage is optional; the in-memory mapping still protects this process.
  }
}

export function lookupOpenSession(
  mapping: OpenSessionMapping,
  messageID: string | undefined,
  directory?: string,
  now = Date.now(),
): string | undefined {
  if (!messageID) return undefined
  const entry = mapping.get(messageID)
  if (!entry) return undefined
  if (now - entry.at > OPEN_TTL_MS) {
    mapping.delete(messageID)
    return undefined
  }
  if (directory && entry.directory && entry.directory !== directory) {
    mapping.delete(messageID)
    return undefined
  }
  return entry.sessionID
}

export async function rememberOpenSession(
  ctx: PluginContext,
  mapping: OpenSessionMapping,
  messageID: string,
  sessionID: string,
  directory = directoryOf(ctx),
): Promise<void> {
  mapping.delete(messageID)
  mapping.set(messageID, {
    sessionID,
    at: Date.now(),
    ...(directory ? { directory } : {}),
  })
  pruneOpenSessions(mapping, Date.now(), directory)
  await persistOpenSessions(ctx, mapping)
}

export async function forgetOpenSession(
  ctx: PluginContext,
  mapping: OpenSessionMapping,
  messageID: string,
): Promise<void> {
  if (!mapping.delete(messageID)) return
  await persistOpenSessions(ctx, mapping)
}

export async function forgetOpenSessionsBySessionID(
  ctx: PluginContext,
  mapping: OpenSessionMapping,
  sessionID: string,
): Promise<void> {
  let changed = false
  for (const [messageID, entry] of mapping) {
    if (entry.sessionID === sessionID) {
      mapping.delete(messageID)
      changed = true
    }
  }
  if (changed) await persistOpenSessions(ctx, mapping)
}

export type RegistryStats = {
  owned: number
  open: number
  dirtyOwned: boolean
  dirtyOpen: boolean
  flushPending: boolean
  lastFlushAt?: number
}

export type RegistryPersistence = {
  rememberOpen: (messageID: string, sessionID: string, directory?: string) => void
  rememberOwned: (sessionID: string, directory?: string) => void
  forgetOwned: (sessionID: string) => void
  forgetOpenBySessionID: (sessionID: string) => void
  flush: () => Promise<void>
  stats: () => RegistryStats
  dispose: () => Promise<void>
}

type RegistryPersistenceOptions = {
  /** Debounce window for coalesced writes. */
  flushDelayMs?: number
}

/**
 * Coalesces registry writes so `open` does not block the prompt on two full
 * map serializations. In-memory state is authoritative for the current
 * process; `flush()` is called by cleanup and destructive operations.
 */
export function createRegistryPersistence(
  ctx: PluginContext,
  owned: OwnedSessions,
  open: OpenSessionMapping,
  options: RegistryPersistenceOptions = {},
): RegistryPersistence {
  const directory = directoryOf(ctx)
  const flushDelayMs = Math.max(1, options.flushDelayMs ?? 250)
  let dirtyOwned = false
  let dirtyOpen = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined
  let lastFlushAt: number | undefined

  async function flush(): Promise<void> {
    // If a coalesced flush is already running, wait for it and then flush any
    // state that became dirty while it was in flight.
    while (flushing) {
      try {
        await flushing
      } catch {
        // persistOwnedSessions/persistOpenSessions already swallow errors.
      }
    }
    const writeOwned = dirtyOwned
    const writeOpen = dirtyOpen
    if (!writeOwned && !writeOpen) return
    dirtyOwned = false
    dirtyOpen = false
    const current = (async () => {
      const jobs: Promise<void>[] = []
      if (writeOwned) jobs.push(persistOwnedSessions(ctx, owned))
      if (writeOpen) jobs.push(persistOpenSessions(ctx, open))
      await Promise.all(jobs)
    })()
    flushing = current
    try {
      await current
      lastFlushAt = Date.now()
    } finally {
      if (flushing === current) flushing = undefined
      if (dirtyOwned || dirtyOpen) schedule()
    }
  }

  function schedule(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, flushDelayMs)
    const handle = timer as unknown as { unref?: () => void }
    if (typeof handle.unref === "function") handle.unref()
  }

  return {
    rememberOpen(messageID, sessionID, targetDirectory = directory) {
      open.delete(messageID)
      open.set(messageID, {
        sessionID,
        at: Date.now(),
        ...(targetDirectory ? { directory: targetDirectory } : {}),
      })
      pruneOpenSessions(open, Date.now(), directory)
      dirtyOpen = true
      schedule()
    },
    rememberOwned(sessionID, targetDirectory = directory) {
      owned.delete(sessionID)
      owned.set(sessionID, {
        at: Date.now(),
        ...(targetDirectory ? { directory: targetDirectory } : {}),
      })
      pruneOwnedSessions(owned)
      dirtyOwned = true
      schedule()
    },
    forgetOwned(sessionID) {
      if (owned.delete(sessionID)) {
        dirtyOwned = true
        schedule()
      }
    },
    forgetOpenBySessionID(sessionID) {
      let changed = false
      for (const [messageID, entry] of open) {
        if (entry.sessionID === sessionID) {
          open.delete(messageID)
          changed = true
        }
      }
      if (changed) {
        dirtyOpen = true
        schedule()
      }
    },
    flush,
    stats() {
      return {
        owned: owned.size,
        open: open.size,
        dirtyOwned,
        dirtyOpen,
        flushPending: flushing !== undefined,
        lastFlushAt,
      }
    },
    async dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
    },
  }
}
