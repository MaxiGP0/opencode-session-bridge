import { sameDirectory, resolveGitDir } from "./directories.ts"
import { runGit, type GitRunner } from "./git.ts"
import type { LiveState } from "./live.ts"
import type { BridgeOptions } from "./options.ts"
import type { PluginContext } from "./types.ts"

export type WorktreeStrategy = "worktree" | "copy" | "clone" | "unknown"

export type WorktreeRecord = {
  directory: string
  runID: string
  projectID?: string
  ownerSessionID?: string
  ownerDirectory?: string
  base?: string
  branch?: string
  name?: string
  strategy: WorktreeStrategy
  createdAt: number
  sessions: string[]
  state: "ready" | "removed" | "orphan"
}

export type WorktreeRegistry = Map<string, WorktreeRecord>

export type WorktreeView = WorktreeRecord & {
  dirty: boolean
  dirtyFiles?: number
  missing?: boolean
}

export type RemoveWorktreeResult = {
  directory: string
  removed: boolean
  reason?: string
  dirty?: boolean
  archivedSessions?: number
  orphan?: boolean
}

export type WorktreeDeps = {
  ctx: PluginContext
  options: BridgeOptions
  worktrees: WorktreeRegistry
  git: GitRunner
  liveState?: LiveState
}

const WORKTREES_KEY = "session-bridge:worktrees"
const MAX_WORKTREES = 200
const WORKTREE_TTL_MS = 30 * 24 * 60 * 60 * 1_000

const processWorktrees: WorktreeRegistry = new Map()

export class WorktreeCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorktreeCapabilityError"
  }
}

function validString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function strategyFrom(value: string | undefined): WorktreeStrategy | undefined {
  if (!value) return undefined
  const lower = value.toLowerCase()
  if (lower.includes("copy")) return "copy"
  if (lower.includes("clone")) return "clone"
  if (lower.includes("worktree") || lower.includes("git")) return "worktree"
  return "unknown"
}

function pruneWorktrees(records: WorktreeRegistry, now = Date.now()): void {
  for (const [key, record] of records) {
    if (now - record.createdAt > WORKTREE_TTL_MS && record.state !== "ready") {
      records.delete(key)
    }
  }
  while (records.size > MAX_WORKTREES) {
    const oldest = records.keys().next().value
    if (typeof oldest !== "string") break
    records.delete(oldest)
  }
}

function recordKey(directory: string): string {
  return directory
}

export function worktreeFor(
  records: WorktreeRegistry,
  directory: string | undefined,
): WorktreeRecord | undefined {
  if (!directory) return undefined
  for (const record of records.values()) {
    if (sameDirectory(record.directory, directory)) return record
  }
  return undefined
}

export async function loadWorktrees(ctx: PluginContext): Promise<WorktreeRegistry> {
  const records: WorktreeRegistry = new Map()
  try {
    const raw = await ctx.storage?.get(WORKTREES_KEY)
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (!value || typeof value !== "object") continue
        const entry = value as Record<string, unknown>
        const directory = validString(entry.directory)
        const runID = validString(entry.runID)
        if (!directory || !runID) continue
        const createdAt = validTimestamp(entry.createdAt) ?? Date.now()
        const sessions = Array.isArray(entry.sessions)
          ? entry.sessions.filter((id): id is string => typeof id === "string")
          : []
        records.set(recordKey(directory), {
          directory,
          runID,
          createdAt,
          sessions,
          strategy: strategyFrom(validString(entry.strategy)) ?? "unknown",
          state:
            entry.state === "removed" || entry.state === "orphan" ? entry.state : "ready",
          ...(validString(entry.ownerSessionID)
            ? { ownerSessionID: validString(entry.ownerSessionID) }
            : {}),
          ...(validString(entry.ownerDirectory)
            ? { ownerDirectory: validString(entry.ownerDirectory) }
            : {}),
          ...(validString(entry.base) ? { base: validString(entry.base) } : {}),
          ...(validString(entry.branch) ? { branch: validString(entry.branch) } : {}),
          ...(validString(entry.name) ? { name: validString(entry.name) } : {}),
          ...(validString(entry.projectID) ? { projectID: validString(entry.projectID) } : {}),
        })
      }
    }
  } catch {
    // Storage is optional.
  }
  for (const [key, record] of processWorktrees) records.set(key, record)
  pruneWorktrees(records)
  return records
}

export async function persistWorktrees(
  ctx: PluginContext,
  records: WorktreeRegistry,
): Promise<void> {
  try {
    await ctx.storage?.set(WORKTREES_KEY, [...records.values()])
  } catch {
    // Storage is optional.
  }
}

export async function rememberWorktree(
  ctx: PluginContext,
  records: WorktreeRegistry,
  record: WorktreeRecord,
): Promise<void> {
  records.set(recordKey(record.directory), record)
  processWorktrees.set(recordKey(record.directory), record)
  pruneWorktrees(records)
  pruneWorktrees(processWorktrees)
  await persistWorktrees(ctx, records)
}

function projectIDOf(ctx: PluginContext): string {
  const projectID = ctx.location?.project?.id
  if (!projectID) {
    throw new WorktreeCapabilityError("the host did not expose ctx.location.project.id")
  }
  return String(projectID)
}

export function canManageWorktrees(ctx: PluginContext): boolean {
  return (
    typeof ctx.worktree?.create === "function" &&
    typeof ctx.worktree?.list === "function" &&
    typeof ctx.worktree?.remove === "function"
  )
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return (cleaned || "sb").slice(0, 48)
}

async function resolveBase(deps: WorktreeDeps, base: string, signal?: AbortSignal): Promise<string> {
  const source = deps.ctx.location?.directory
  if (!source) return base
  const result = await deps.git(["rev-parse", "--verify", `${base}^{commit}`], source, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (result.exitCode !== 0) {
    throw new WorktreeCapabilityError(
      `base ref is not a commit in this repository: ${base}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
    )
  }
  return result.stdout.trim() || base
}

async function branchOf(deps: WorktreeDeps, directory: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (result.exitCode !== 0) return undefined
  const branch = result.stdout.trim()
  return branch && branch !== "HEAD" ? branch : undefined
}

async function isDirty(deps: WorktreeDeps, directory: string, signal?: AbortSignal): Promise<{ dirty: boolean; files: number }> {
  if (typeof deps.ctx.vcs?.status === "function") {
    try {
      const result = await deps.ctx.vcs.status({ location: { directory } }, { signal })
      const files = Array.isArray(result?.data) ? result.data.length : 0
      return { dirty: files > 0, files }
    } catch {
      // Fall back to git below.
    }
  }
  const result = await deps.git(["status", "--porcelain=v1"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (result.exitCode !== 0) return { dirty: false, files: 0 }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  return { dirty: lines.length > 0, files: lines.length }
}

export async function createWorktrees(
  deps: WorktreeDeps,
  input: {
    count: number
    base?: string
    namePrefix: string
    branch?: string
  },
  meta: { runID: string; ownerSessionID?: string; ownerDirectory?: string },
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  if (!canManageWorktrees(deps.ctx)) {
    throw new WorktreeCapabilityError(
      "ctx.worktree is not available in this host; no worktrees were created",
    )
  }
  const count = Math.max(1, Math.min(input.count, deps.options.maxWorktrees))
  const projectID = projectIDOf(deps.ctx)
  const source = deps.ctx.location?.directory
  if (!source) throw new WorktreeCapabilityError("ctx.location.directory is not available")
  const base = await resolveBase(deps, input.base ?? "HEAD", signal)
  const prefix = safeName(input.namePrefix || "sb")
  const runID = safeName(meta.runID)
  const created: WorktreeRecord[] = []
  const failures: string[] = []

  const createOne = async (index: number): Promise<void> => {
    const name = `${prefix}-${runID}-${index + 1}`.slice(0, 64)
    try {
      const result = await deps.ctx.worktree.create(
        {
          projectID,
          name,
          branch: input.branch ?? base,
        },
        { signal: signal ?? new AbortController().signal },
      )
      const directory = result?.directory
      if (!directory) throw new Error("worktree.create did not return a directory")
      const gitDir = await resolveGitDir(directory)
      const record: WorktreeRecord = {
        directory,
        runID: meta.runID,
        projectID,
        createdAt: Date.now(),
        sessions: [],
        base,
        name,
        strategy: gitDir ? "worktree" : "unknown",
        state: "ready",
        ...(meta.ownerSessionID ? { ownerSessionID: meta.ownerSessionID } : {}),
        ...(meta.ownerDirectory ? { ownerDirectory: meta.ownerDirectory } : {}),
      }
      const branch = await branchOf(deps, directory, signal)
      if (branch) record.branch = branch
      created.push(record)
      await rememberWorktree(deps.ctx, deps.worktrees, record)
    } catch (error) {
      failures.push(String((error as { message?: string })?.message ?? error))
    }
  }

  // Worktree creation is expensive and the host serializes setup scripts.
  const concurrency = Math.max(1, Math.min(count, 2))
  let next = 0
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++
      if (index >= count) return
      await createOne(index)
    }
  })
  await Promise.all(workers)

  if (failures.length) {
    // Roll back only what this run created. The host may leave a directory
    // behind; report it instead of trying shell-based tooling.
    const orphans: string[] = []
    for (const record of [...created].reverse()) {
      try {
        await deps.ctx.worktree.remove(
          { projectID, directory: record.directory, force: true },
          { signal: signal ?? new AbortController().signal },
        )
        record.state = "removed"
        await rememberWorktree(deps.ctx, deps.worktrees, record)
      } catch {
        record.state = "orphan"
        orphans.push(record.directory)
        await rememberWorktree(deps.ctx, deps.worktrees, record)
      }
    }
    throw new WorktreeCapabilityError(
      `worktree creation failed after ${created.length}/${count}: ${failures[0]}${
        orphans.length ? `; orphans: ${orphans.join(", ")}` : ""
      }`,
    )
  }

  // The host reports the strategy through list; keep it when available.
  if (created.length && typeof deps.ctx.worktree.list === "function") {
    try {
      const inventory = await deps.ctx.worktree.list(
        { projectID },
        { signal: signal ?? new AbortController().signal },
      )
      for (const record of created) {
        const found = inventory.find((entry) => sameDirectory(entry.directory, record.directory))
        const strategy = strategyFrom(found?.strategy)
        if (strategy) record.strategy = strategy
        await rememberWorktree(deps.ctx, deps.worktrees, record)
      }
    } catch {
      // Strategy detection is best effort.
    }
  }

  return created
}

export async function listWorktrees(
  deps: WorktreeDeps,
  signal?: AbortSignal,
): Promise<WorktreeView[]> {
  if (!canManageWorktrees(deps.ctx)) {
    throw new WorktreeCapabilityError(
      "ctx.worktree is not available in this host; no worktrees can be listed",
    )
  }
  const projectID = projectIDOf(deps.ctx)
  const inventory = await deps.ctx.worktree.list(
    { projectID },
    { signal: signal ?? new AbortController().signal },
  )
  const views: WorktreeView[] = []
  for (const entry of inventory) {
    const record = worktreeFor(deps.worktrees, entry.directory)
    const dirty = await isDirty(deps, entry.directory, signal)
    const branch = await branchOf(deps, entry.directory, signal)
    views.push({
      directory: entry.directory,
      runID: record?.runID ?? "external",
      createdAt: record?.createdAt ?? 0,
      sessions: record?.sessions ?? [],
      base: record?.base,
      branch: branch ?? record?.branch,
      name: record?.name,
      strategy: strategyFrom(entry.strategy) ?? record?.strategy ?? "unknown",
      state: record?.state ?? "ready",
      dirty: dirty.dirty,
      dirtyFiles: dirty.files,
      ...(record?.ownerSessionID ? { ownerSessionID: record.ownerSessionID } : {}),
      ...(record?.ownerDirectory ? { ownerDirectory: record.ownerDirectory } : {}),
    })
  }
  for (const record of deps.worktrees.values()) {
    if (record.state !== "ready") continue
    if (record.projectID && record.projectID !== projectID) continue
    if (views.some((view) => sameDirectory(view.directory, record.directory))) continue
    views.push({
      ...record,
      dirty: false,
      missing: true,
    })
  }
  return views
}

export async function removeWorktrees(
  deps: WorktreeDeps,
  directories: string[],
  options: { force: boolean; archiveSessions: boolean },
  signal?: AbortSignal,
): Promise<RemoveWorktreeResult[]> {
  if (!canManageWorktrees(deps.ctx)) {
    throw new WorktreeCapabilityError(
      "ctx.worktree is not available in this host; no worktrees were removed",
    )
  }
  const projectID = projectIDOf(deps.ctx)
  const results: RemoveWorktreeResult[] = []
  const root = deps.ctx.location?.directory
  const canonical = deps.ctx.location?.project?.canonical

  for (const directory of directories) {
    if (root && sameDirectory(root, directory)) {
      results.push({ directory, removed: false, reason: "refusing to remove the project root" })
      continue
    }
    if (canonical && sameDirectory(canonical, directory)) {
      results.push({ directory, removed: false, reason: "refusing to remove the project root" })
      continue
    }
    const record = worktreeFor(deps.worktrees, directory)
    if (!record) {
      results.push({
        directory,
        removed: false,
        reason: "worktree was not created by this plugin",
      })
      continue
    }
    if (record.projectID && record.projectID !== projectID) {
      results.push({
        directory,
        removed: false,
        reason: "worktree belongs to another project",
      })
      continue
    }
    if (record.state === "removed") {
      results.push({ directory, removed: true, reason: "worktree is already removed" })
      continue
    }

    const dirty = await isDirty(deps, record.directory, signal)
    if (dirty.dirty && !options.force) {
      results.push({
        directory,
        removed: false,
        dirty: true,
        reason: "worktree has uncommitted changes; pass force: true and confirm: true to remove it",
      })
      continue
    }

    let active = false
    for (const sessionID of record.sessions) {
      const live = deps.liveState?.get(sessionID)
      if (live?.status?.type === "busy" || live?.pending.length || live?.background?.length) {
        active = true
        break
      }
      if (typeof deps.ctx.session?.get === "function") {
        try {
          const session = await deps.ctx.session.get(
            { sessionID },
            { signal: signal ?? new AbortController().signal },
          )
          if (
            typeof session.time?.busy === "number" &&
            typeof session.time?.idle === "number" &&
            session.time.busy > session.time.idle
          ) {
            active = true
            break
          }
        } catch {
          // A missing session is not active.
        }
      }
    }
    if (active && !options.force) {
      results.push({
        directory,
        removed: false,
        reason: "worktree has active sessions; stop them or pass force: true",
      })
      continue
    }

    let archivedSessions = 0
    if (options.archiveSessions && typeof deps.ctx.session?.update === "function") {
      for (const sessionID of record.sessions) {
        try {
          await deps.ctx.session.update(
            { sessionID, archived: true },
            { signal: signal ?? new AbortController().signal },
          )
          archivedSessions++
        } catch {
          // Archiving is best effort; the worktree removal still reports errors.
        }
      }
    }

    try {
      await deps.ctx.worktree.remove(
        { projectID, directory: record.directory, force: options.force },
        { signal: signal ?? new AbortController().signal },
      )
      record.state = "removed"
      await rememberWorktree(deps.ctx, deps.worktrees, record)
      results.push({ directory, removed: true, dirty: dirty.dirty, archivedSessions })
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error)
      const forceRequired = /force|dirty|modified|untracked/i.test(message)
      if (forceRequired) record.state = "orphan"
      await rememberWorktree(deps.ctx, deps.worktrees, record)
      results.push({
        directory,
        removed: false,
        dirty: dirty.dirty,
        orphan: record.state === "orphan",
        reason: message,
      })
    }
  }
  return results
}

export function attachSessionToWorktree(
  records: WorktreeRegistry,
  directory: string | undefined,
  sessionID: string | undefined,
): void {
  if (!directory || !sessionID) return
  const record = worktreeFor(records, directory)
  if (!record) return
  if (!record.sessions.includes(sessionID)) record.sessions.push(sessionID)
}

/** Attaches a session and persists it so cleanup after a reload knows it is active. */
export async function attachAndPersistSession(
  ctx: PluginContext,
  records: WorktreeRegistry,
  directory: string | undefined,
  sessionID: string | undefined,
): Promise<void> {
  if (!directory || !sessionID) return
  const record = worktreeFor(records, directory)
  if (!record) return
  if (record.sessions.includes(sessionID)) return
  record.sessions.push(sessionID)
  await rememberWorktree(ctx, records, record)
}
