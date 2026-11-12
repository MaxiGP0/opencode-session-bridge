import { sameDirectory } from "./directories.ts"
import type { PluginContext } from "./types.ts"

const OWNED_KEY = "session-bridge:owned-sessions"
const OPEN_KEY = "session-bridge:open-sessions"
const WORKERS_KEY = "session-bridge:workers"
const MAX_OWNED = 500
const MAX_OPEN = 500
const MAX_WORKERS = 500
const OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const OWNED_TTL_MS = 30 * 24 * 60 * 60 * 1_000
/** Deprecated: worker registrations are persistent; kept for older callers. */
export const WORKER_TTL_MS = 7 * 24 * 60 * 60 * 1_000
/** A worker seen inside this window is never evicted by the soft LRU cap. */
const ACTIVE_WORKER_WINDOW_MS = 60 * 60 * 1_000

export type SessionRole = "orchestrator" | "worker"

export type OwnedSessionEntry = {
  at: number
  /** Legacy directory metadata. Kept for old registries and same-directory auth. */
  directory?: string
  ownerSessionID?: string
  runID?: string
  ownerDirectory?: string
  targetDirectory?: string
  role?: SessionRole
}

export type OwnedSessions = Map<string, OwnedSessionEntry>

export type OwnedCaller = {
  sessionID?: string
  runID?: string
  role?: SessionRole
  directory?: string
}

export type OwnershipOptions = {
  /** When false, owner/run authorization does not cross directories. */
  allowCrossDirectoryManagement?: boolean
}

export type OpenSessionEntry = {
  sessionID: string
  at: number
  directory?: string
  ownerSessionID?: string
  runID?: string
  targetDirectory?: string
}

export type OpenSessionMapping = Map<string, OpenSessionEntry>

export type WorkerSessionEntry = {
  sessionID: string
  at: number
  ownerSessionID?: string
  runID?: string
  ownerDirectory?: string
  targetDirectory: string
  role: "worker"
  /** In-memory only: last time this touch was persisted. */
  touchPersistedAt?: number
}

export type WorkerSessions = Map<string, WorkerSessionEntry>

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

function validString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function validRole(value: unknown): SessionRole | undefined {
  return value === "orchestrator" || value === "worker" ? value : undefined
}

function ownedEntryFromRecord(
  record: Record<string, unknown>,
  currentDirectory: string | undefined,
  now: number,
): OwnedSessionEntry | undefined {
  const at = validTimestamp(record.at) ?? now
  const legacyDirectory =
    typeof record.directory === "string" && record.directory
      ? record.directory
      : undefined
  const explicitTarget = validString(record.targetDirectory)
  const targetDirectory = explicitTarget ?? legacyDirectory
  const ownerDirectory = validString(record.ownerDirectory)
  const ownerSessionID = validString(record.ownerSessionID)
  const runID = validString(record.runID)
  const role = validRole(record.role)
  // Old registries only carry `directory`; keep them usable for
  // same-directory ownership. Entries from another directory are legitimate
  // when they carry owner/run/target metadata, so do not drop those.
  if (
    legacyDirectory &&
    !explicitTarget &&
    !ownerSessionID &&
    !runID &&
    currentDirectory &&
    legacyDirectory !== currentDirectory
  ) {
    return undefined
  }
  return {
    at,
    ...(legacyDirectory ? { directory: legacyDirectory } : {}),
    ...(ownerSessionID ? { ownerSessionID } : {}),
    ...(runID ? { runID } : {}),
    ...(ownerDirectory ? { ownerDirectory } : {}),
    ...(targetDirectory ? { targetDirectory } : {}),
    ...(role ? { role } : {}),
  }
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
      const entry = ownedEntryFromRecord(record, directory, now)
      if (!entry) continue
      sessions.delete(sessionID)
      sessions.set(sessionID, entry)
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
        directory: entry.directory ?? entry.targetDirectory ?? directory ?? "",
        ...(entry.ownerSessionID ? { ownerSessionID: entry.ownerSessionID } : {}),
        ...(entry.runID ? { runID: entry.runID } : {}),
        ...(entry.ownerDirectory ? { ownerDirectory: entry.ownerDirectory } : {}),
        ...(entry.targetDirectory ? { targetDirectory: entry.targetDirectory } : {}),
        ...(entry.role ? { role: entry.role } : {}),
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
  metadata: Omit<OwnedSessionEntry, "at" | "directory"> = {},
): Promise<void> {
  sessions.delete(sessionID)
  sessions.set(sessionID, {
    at: Date.now(),
    ...(directory ? { directory } : {}),
    ...metadata,
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

/**
 * Authorizes management of a session.
 *
 * Priority:
 * 1. the caller is the recorded owner (`ownerSessionID`);
 * 2. the caller is an orchestrator of the same run;
 * 3. a legacy entry without owner/run still authorizes the same directory.
 *
 * Directory equality alone never authorizes a session that has an owner or a
 * run, so a foreign caller cannot inherit access by sharing a worktree.
 */
export function isOwnedSession(
  sessions: OwnedSessions,
  sessionID: string,
  caller?: string | OwnedCaller,
  now = Date.now(),
  options: OwnershipOptions = {},
): boolean {
  const entry = sessions.get(sessionID)
  if (!entry) return false
  if (now - entry.at > OWNED_TTL_MS) {
    sessions.delete(sessionID)
    return false
  }

  const who: OwnedCaller =
    typeof caller === "string" || caller === undefined
      ? { directory: caller }
      : caller
  const callerEntry = who.sessionID ? sessions.get(who.sessionID) : undefined
  const callerRunID = who.runID ?? callerEntry?.runID
  const callerRole = who.role ?? callerEntry?.role
  const crossDirectory = options.allowCrossDirectoryManagement ?? true
  const callerDirectory = who.directory ?? callerEntry?.directory ?? callerEntry?.targetDirectory
  const entryDirectory = entry.targetDirectory ?? entry.directory

  if (entry.ownerSessionID && who.sessionID && who.sessionID === entry.ownerSessionID) {
    if (!crossDirectory && callerDirectory && entryDirectory && !sameDirectory(callerDirectory, entryDirectory)) {
      return false
    }
    return true
  }

  if (
    entry.runID &&
    callerRunID &&
    callerRunID === entry.runID &&
    callerRole === "orchestrator" &&
    entry.role !== "orchestrator"
  ) {
    if (!crossDirectory && callerDirectory && entryDirectory && !sameDirectory(callerDirectory, entryDirectory)) {
      return false
    }
    return true
  }

  // Legacy entries only. Once an entry has an owner or a run, directory
  // equality is metadata and not an authorization grant.
  if (!entry.ownerSessionID && !entry.runID) {
    if (!callerDirectory || !entryDirectory) return true
    return sameDirectory(callerDirectory, entryDirectory)
  }

  return false
}

export function isWorkerSession(
  workers: WorkerSessions,
  sessionID: string | undefined,
  now = Date.now(),
): WorkerSessionEntry | undefined {
  if (!sessionID) return undefined
  const entry = workers.get(sessionID)
  if (!entry) return undefined
  // The worker role is persistent while the session exists. Refreshing `at`
  // keeps the in-memory LRU honest without writing storage on every call.
  if (now > entry.at) entry.at = now
  return entry
}

export const WORKER_TOUCH_INTERVAL_MS = 60_000

/**
 * Refreshes the in-memory last-seen timestamp and reports whether the touch
 * should be persisted. Callers persist at most once per minute per worker.
 */
export function touchWorkerSession(
  workers: WorkerSessions,
  sessionID: string | undefined,
  now = Date.now(),
): { entry?: WorkerSessionEntry; persist: boolean } {
  const entry = isWorkerSession(workers, sessionID, now)
  if (!entry) return { persist: false }
  const last = entry.touchPersistedAt ?? 0
  if (now - last < WORKER_TOUCH_INTERVAL_MS) return { entry, persist: false }
  entry.touchPersistedAt = now
  return { entry, persist: true }
}

/**
 * Plugin instances for different locations share the process but not their
 * in-memory module state when they run in separate workers. This module-level
 * map still covers the common case (one server process); storage is the
 * cross-process fallback.
 */
const processWorkers: WorkerSessions = new Map()

export function getProcessWorkerSessions(): WorkerSessions {
  return processWorkers
}

function pruneWorkers(workers: WorkerSessions, now = Date.now()): void {
  while (workers.size > MAX_WORKERS) {
    // Evict the least recently seen entry, but never one observed inside the
    // active window. A burst of active workers can temporarily exceed the cap;
    // silently dropping an active worker would re-enable orchestration tools.
    let oldest: [string, WorkerSessionEntry] | undefined
    for (const entry of workers) {
      if (now - entry[1].at <= ACTIVE_WORKER_WINDOW_MS) continue
      if (!oldest || entry[1].at < oldest[1].at) oldest = entry
    }
    if (!oldest) break
    workers.delete(oldest[0])
  }
}

export async function loadWorkerSessions(ctx: PluginContext): Promise<WorkerSessions> {
  const workers: WorkerSessions = new Map()
  try {
    const raw = await ctx.storage?.get(WORKERS_KEY)
    for (const record of readStoredEntries(raw)) {
      const sessionID = typeof record.sessionID === "string" ? record.sessionID : ""
      if (!sessionID) continue
      const targetDirectory = validString(record.targetDirectory)
      if (!targetDirectory) continue
      const at = validTimestamp(record.at) ?? Date.now()
      workers.set(sessionID, {
        sessionID,
        at,
        targetDirectory,
        role: "worker",
        ...(validString(record.ownerSessionID)
          ? { ownerSessionID: validString(record.ownerSessionID) }
          : {}),
        ...(validString(record.runID) ? { runID: validString(record.runID) } : {}),
        ...(validString(record.ownerDirectory)
          ? { ownerDirectory: validString(record.ownerDirectory) }
          : {}),
      })
    }
  } catch {
    // Storage is optional; the process map still protects this process.
  }
  for (const [sessionID, entry] of processWorkers) workers.set(sessionID, entry)
  pruneWorkers(workers)
  return workers
}

export async function persistWorkerSessions(
  ctx: PluginContext,
  workers: WorkerSessions,
): Promise<void> {
  try {
    const values: Array<Record<string, string | number>> = [...workers.values()].map(
      (entry) => ({
        sessionID: entry.sessionID,
        at: entry.at,
        targetDirectory: entry.targetDirectory,
        role: "worker",
        ...(entry.ownerSessionID ? { ownerSessionID: entry.ownerSessionID } : {}),
        ...(entry.runID ? { runID: entry.runID } : {}),
        ...(entry.ownerDirectory ? { ownerDirectory: entry.ownerDirectory } : {}),
      }),
    )
    await ctx.storage?.set(WORKERS_KEY, values)
  } catch {
    // Storage is optional.
  }
}

/**
 * Worker registrations are written immediately (not coalesced): the worker
 * may run in another location/plugin instance and its first tool call must
 * already see the role.
 */
export async function rememberWorkerSession(
  ctx: PluginContext,
  workers: WorkerSessions,
  entry: Omit<WorkerSessionEntry, "at" | "role"> & { at?: number },
): Promise<void> {
  const value: WorkerSessionEntry = {
    ...entry,
    at: entry.at ?? Date.now(),
    role: "worker",
  }
  workers.delete(value.sessionID)
  workers.set(value.sessionID, value)
  processWorkers.delete(value.sessionID)
  processWorkers.set(value.sessionID, value)
  pruneWorkers(workers)
  pruneWorkers(processWorkers)
  await persistWorkerSessions(ctx, workers)
}

export async function forgetWorkerSession(
  ctx: PluginContext,
  workers: WorkerSessions,
  sessionID: string,
): Promise<void> {
  const changed = workers.delete(sessionID)
  processWorkers.delete(sessionID)
  if (changed) await persistWorkerSessions(ctx, workers)
}

export function pruneOpenSessions(
  mapping: OpenSessionMapping,
  now = Date.now(),
  _directory?: string,
): void {
  for (const [messageID, entry] of mapping) {
    if (!entry.sessionID || now - entry.at > OPEN_TTL_MS) {
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
      const legacyDirectory =
        typeof record.directory === "string" && record.directory
          ? record.directory
          : undefined
      const explicitTarget = validString(record.targetDirectory)
      const targetDirectory = explicitTarget ?? legacyDirectory
      const ownerSessionID = validString(record.ownerSessionID)
      const runID = validString(record.runID)
      if (
        legacyDirectory &&
        !explicitTarget &&
        !ownerSessionID &&
        !runID &&
        directory &&
        legacyDirectory !== directory
      ) {
        continue
      }
      mapping.delete(messageID)
      mapping.set(messageID, {
        sessionID,
        at,
        ...(legacyDirectory ? { directory: legacyDirectory } : {}),
        ...(ownerSessionID ? { ownerSessionID } : {}),
        ...(runID ? { runID } : {}),
        ...(targetDirectory ? { targetDirectory } : {}),
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
        directory: entry.directory ?? entry.targetDirectory ?? directory ?? "",
        ...(entry.ownerSessionID ? { ownerSessionID: entry.ownerSessionID } : {}),
        ...(entry.runID ? { runID: entry.runID } : {}),
        ...(entry.targetDirectory ? { targetDirectory: entry.targetDirectory } : {}),
      }),
    )
    await ctx.storage?.set(storageKey(OPEN_KEY, directory), values)
  } catch {
    // Storage is optional; the in-memory mapping still protects this process.
  }
}

/**
 * Returns the raw mapping regardless of directory. `open` uses this to turn a
 * same `messageID` in another directory into an explicit conflict instead of
 * silently reusing or discarding the session.
 */
export function findOpenSession(
  mapping: OpenSessionMapping,
  messageID: string | undefined,
  now = Date.now(),
): OpenSessionEntry | undefined {
  if (!messageID) return undefined
  const entry = mapping.get(messageID)
  if (!entry) return undefined
  if (now - entry.at > OPEN_TTL_MS) {
    mapping.delete(messageID)
    return undefined
  }
  return entry
}

export function lookupOpenSession(
  mapping: OpenSessionMapping,
  messageID: string | undefined,
  directory?: string,
  now = Date.now(),
): string | undefined {
  const entry = findOpenSession(mapping, messageID, now)
  if (!entry) return undefined
  const entryDirectory = entry.targetDirectory ?? entry.directory
  if (directory && entryDirectory && !sameDirectory(entryDirectory, directory)) {
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
  metadata: Omit<OpenSessionEntry, "sessionID" | "at" | "directory"> = {},
): Promise<void> {
  mapping.delete(messageID)
  mapping.set(messageID, {
    sessionID,
    at: Date.now(),
    ...(directory ? { directory } : {}),
    ...metadata,
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
  rememberOpen: (
    messageID: string,
    sessionID: string,
    directory?: string,
    metadata?: Omit<OpenSessionEntry, "sessionID" | "at" | "directory">,
  ) => void
  rememberOwned: (
    sessionID: string,
    directory?: string,
    metadata?: Omit<OwnedSessionEntry, "at" | "directory">,
  ) => void
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
    rememberOpen(messageID, sessionID, targetDirectory = directory, metadata = {}) {
      open.delete(messageID)
      open.set(messageID, {
        sessionID,
        at: Date.now(),
        ...(targetDirectory ? { directory: targetDirectory } : {}),
        ...metadata,
      })
      pruneOpenSessions(open, Date.now(), directory)
      dirtyOpen = true
      schedule()
    },
    rememberOwned(sessionID, targetDirectory = directory, metadata = {}) {
      owned.delete(sessionID)
      owned.set(sessionID, {
        at: Date.now(),
        ...(targetDirectory ? { directory: targetDirectory } : {}),
        ...metadata,
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
