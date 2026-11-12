import { t, type StringKey } from "./i18n.ts"
import {
  assistantTextInfo,
  capOutput,
  collectRecentTools,
  compact,
  formatError,
  formatSummary,
  isRunning,
  lastAssistant,
  lastIdle,
  lastUser,
  modelRef,
  oneLine,
  parseModel,
  permissionLine,
  renderTranscriptDetailed,
  sanitizeTitle,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
  truncateCodePoints,
} from "./format.ts"
import { normalizeDirectory, sameDirectory, validateTargetDirectory } from "./directories.ts"
import { runGit, type GitRunner } from "./git.ts"
import { type LiveState, type LiveSnapshot } from "./live.ts"
import type { BridgeOptions } from "./options.ts"
import {
  boundError,
  boundOutputTotal,
  boundPendingPermissions,
  boundTitle,
  boundedPermissionLine,
  cleanOutput,
  errorOutput,
  jsonSafe,
  outputBudget,
  stringField,
} from "./output.ts"
import {
  clearQueuedPrompts,
  enqueueQueuedPrompt,
  listQueuedPrompts,
  nextQueuedPrompt,
  removeQueuedPrompt,
  type QueueOptions,
} from "./queue.ts"
import {
  applyCandidate,
  raceCleanup,
  raceList,
  raceStatus,
  runRace,
  waitMany,
  workerPermissionRules,
  type DirectoryValidator,
  type OrchestrationDeps,
} from "./orchestration.ts"
import { rankCandidates, shapeCandidate, shapeRace } from "./races.ts"
import { createRaceID } from "./races.ts"
import type { RaceRegistry } from "./races.ts"
import {
  forgetOpenSessionsBySessionID,
  forgetOwnedSession,
  forgetWorkerSession,
  findOpenSession,
  getProcessWorkerSessions,
  isOwnedSession,
  isWorkerSession,
  touchWorkerSession,
  lookupOpenSession,
  rememberOpenSession,
  rememberOwnedSession,
  rememberWorkerSession,
  type OpenSessionMapping,
  type OwnedSessions,
  type RegistryPersistence,
  type SessionRole,
  type WorkerSessions,
} from "./registry.ts"
import {
  PermissionDenied,
  abortError,
  assertPermission,
  awaitWithSignal,
  promptMessageID,
  signalOf,
  throwIfAborted,
  withRequest,
} from "./runtime.ts"
import {
  attachAndPersistSession,
  canManageWorktrees,
  createWorktrees,
  listWorktrees,
  removeWorktrees,
  type WorktreeRegistry,
} from "./worktrees.ts"
import { refreshRetry, retryInfo, retryRemainingMs } from "./retry.ts"
import { PLUGIN_VERSION } from "./version.ts"
import type {
  Lang,
  PluginContext,
  ProgressInfo,
  QueuedPrompts,
  RegisteredTool,
  RetryInfo,
  SessionInfo,
  ToolEditor,
  ToolExecuteContext,
  TurnResult,
} from "./types.ts"
import {
  parseApplyInput,
  parseCompactInput,
  parseDiagnosticsInput,
  parseInterruptInput,
  parseLanguageInput,
  parseListInput,
  parseOpenInput,
  parsePermissionsInput,
  parseRaceCleanupInput,
  parseRaceInput,
  parseRaceStatusInput,
  parseReadInput,
  parseRemoveInput,
  parseReplyInput,
  parseSendInput,
  parseStatusInput,
  parseUpdateInput,
  parseWaitInput,
  parseWaitManyInput,
  parseWorktreesInput,
  ValidationError,
  type OpenInput,
} from "./validation.ts"
import { evaluateTurn, requestSignal, waitForTurn } from "./wait.ts"

export type OpenAdmission =
  | {
      ok: true
      session: SessionInfo
      admitted: Awaited<ReturnType<PluginContext["session"]["prompt"]>>
      reused: boolean
      title: string
      directory: string
      role: SessionRole
      ownerSessionID?: string
      runID?: string
      permissionsApplied?: boolean
      locationVerified?: boolean
    }
  | {
      ok: false
      error: unknown
      sessionID?: string
      title: string
      messageID?: string
      directory: string
    }

export type OpenInflight = {
  signature: string
  messageID?: string
  directory: string
  controller: AbortController
  promise: Promise<OpenAdmission>
  waiters: number
  settled: boolean
}

export type SentMessageEntry = {
  signature: string
  at: number
  admittedID?: string
  admittedAt?: number
}

export type SentMessages = Map<string, SentMessageEntry>

export type SendAdmission =
  | {
      ok: true
      session: SessionInfo
      admittedID: string
      admittedAt: number
      applied: string[]
      alreadySent: boolean
    }
  | {
      ok: false
      error: unknown
      applied: string[]
    }

export type SendInflight = {
  signature: string
  controller: AbortController
  promise: Promise<SendAdmission>
  waiters: number
  settled: boolean
}

export type ToolDeps = {
  ctx: PluginContext
  options: BridgeOptions
  getLanguage: () => Lang
  setLanguage: (lang: Lang) => Promise<void>
  ownedSessions: OwnedSessions
  openSessions?: OpenSessionMapping
  queuedPrompts?: QueuedPrompts
  liveState?: LiveState
  inFlightOpens?: Map<string, OpenInflight>
  inFlightSends?: Map<string, SendInflight>
  sentMessages?: SentMessages
  registry?: RegistryPersistence
  workerSessions?: WorkerSessions
  worktrees?: WorktreeRegistry
  races?: RaceRegistry
  git?: GitRunner
  validateDirectory?: DirectoryValidator
  refreshWorkers?: () => Promise<void>
  persistWorkers?: () => Promise<void>
}

function orchestrationDeps(deps: ToolDeps): OrchestrationDeps {
  return {
    ctx: deps.ctx,
    options: deps.options,
    getLanguage: deps.getLanguage,
    ownedSessions: deps.ownedSessions,
    openSessions: deps.openSessions ?? new Map(),
    workerSessions: deps.workerSessions ?? getProcessWorkerSessions(),
    worktrees: deps.worktrees ?? new Map(),
    races: deps.races ?? new Map(),
    liveState: deps.liveState,
    registry: deps.registry,
    git: deps.git ?? runGit,
    validateDirectory: deps.validateDirectory,
  }
}

function callerOf(deps: ToolDeps, context: ToolExecuteContext) {
  return {
    sessionID: context.sessionID,
    directory: deps.ctx.location?.directory,
  }
}

function registeredWorktreeDirectories(deps: ToolDeps): string[] {
  const projectID = deps.ctx.location?.project?.id
  return [...(deps.worktrees?.values() ?? [])]
    .filter((record) => !record.projectID || !projectID || record.projectID === String(projectID))
    .map((record) => record.directory)
}

type ToolDefinition = Omit<RegisteredTool, "execute">
export type ToolExecutionResult = {
  content: string
  output?: unknown
  metadata?: Record<string, unknown>
}
type ToolExecute = (
  input: unknown,
  context: ToolExecuteContext,
  lang: Lang,
) => Promise<ToolExecutionResult>

/**
 * JSON Schema objects are validated by OpenCode before `execute` runs. The
 * cast is only at the registration boundary; tool bodies receive `unknown`
 * and validate every field at runtime.
 */
const schema = (value: Record<string, unknown>): ToolDefinition["input"] =>
  value as ToolDefinition["input"]

const outputSchema = (value: Record<string, unknown>): ToolDefinition["output"] =>
  value as ToolDefinition["output"]

function permissionRuleSchemaFor(deps: ToolDeps) {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        maxLength: deps.options.maxPermissionFieldChars,
        description: "Action to match, for example edit, shell, or webfetch.",
      },
      resource: {
        type: "string",
        maxLength: deps.options.maxPermissionFieldChars,
        description: "Resource or glob pattern to match.",
      },
      effect: {
        type: "string",
        enum: ["allow", "deny", "ask"],
        description: "Whether to allow, deny, or ask for matching actions.",
      },
    },
    required: ["action", "resource", "effect"],
    additionalProperties: false,
  }
}

const timeoutSchema = {
  type: "integer",
  minimum: 1,
  maximum: 600_000,
  description: "Maximum wait time in milliseconds. Defaults to 120000.",
}

const limitSchema = {
  type: "integer",
  minimum: 0,
  maximum: 200,
  description: "Number of recent messages. Defaults to 30; 0 also uses the default.",
}

const recentSchema = {
  type: "integer",
  minimum: 0,
  maximum: 100,
  description: "Number of recent actions. Defaults to 8; 0 also uses the default.",
}

const listLimitSchema = {
  type: "integer",
  minimum: 0,
  maximum: 100,
  description: "Maximum number of sessions. Defaults to 10; 0 also uses the default.",
}

const pendingPermissionsSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
}

const outputStateSchema = {
  type: "string",
  enum: ["ok", "running", "retrying", "idle", "queued", "timeout", "aborted", "permission", "error"],
}

const retrySchema = {
  type: "object",
  properties: {
    attempt: { type: "number" },
    message: { type: "string" },
    next: { type: "number", description: "Absolute epoch milliseconds." },
    retryAt: { type: "string", description: "ISO timestamp of the next attempt." },
    retryInMs: { type: "number", description: "Milliseconds remaining at read time." },
  },
  required: [],
  additionalProperties: true,
}

const turnOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    title: { type: "string" },
    messageID: { type: "string" },
    state: outputStateSchema,
    outcome: { type: "string" },
    lastMessageID: { type: "string" },
    text: { type: "string" },
    textLength: { type: "number" },
    textTruncated: { type: "boolean" },
    elapsedMs: { type: "number" },
    fetchCount: { type: "number" },
    queued: { type: "boolean" },
    retry: retrySchema,
    pendingPermissions: pendingPermissionsSchema,
    pendingTotal: { type: "number" },
    pendingTruncated: { type: "boolean" },
    error: { type: "string" },
    errorTruncated: { type: "boolean" },
    reused: { type: "boolean" },
    alreadySent: { type: "boolean" },
    permissionCheckedAt: { type: "number" },
  },
  additionalProperties: true,
})

const statusOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    title: { type: "string" },
    state: outputStateSchema,
    running: { type: "boolean" },
    queued: { type: "boolean" },
    queuedCount: { type: "number" },
    queuedMessageIDs: { type: "array", items: { type: "string" } },
    nextQueuedMessageID: { type: "string" },
    outcome: { type: "string" },
    lastOutcome: { type: "string" },
    promptMessageID: { type: "string" },
    lastMessageID: { type: "string" },
    text: { type: "string" },
    textLength: { type: "number" },
    textTruncated: { type: "boolean" },
    tools: { type: "array", items: { type: "string" } },
    pendingPermissions: pendingPermissionsSchema,
    pendingTotal: { type: "number" },
    pendingTruncated: { type: "boolean" },
    retry: retrySchema,
    error: { type: "string" },
    errorTruncated: { type: "boolean" },
    contextError: { type: "string" },
    permissionError: { type: "string" },
    transcriptAvailable: { type: "boolean" },
    permissionsAvailable: { type: "boolean" },
    liveStale: { type: "boolean" },
    statusAt: { type: "number" },
    lastError: { type: "string" },
    toolsTruncated: { type: "boolean" },
    queuedTruncated: { type: "boolean" },
    includeTools: { type: "boolean" },
    includeText: { type: "boolean" },
  },
  additionalProperties: true,
})

const readOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    lastMessageID: { type: "string" },
    nextAfterMessageID: { type: "string" },
    hasMore: { type: "boolean" },
    truncated: { type: "boolean" },
    count: { type: "number" },
    partial: { type: "boolean" },
    partialMessageID: { type: "string" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const permissionsOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    pending: pendingPermissionsSchema,
    pendingTotal: { type: "number" },
    pendingTruncated: { type: "boolean" },
    hasMore: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const listOutput = outputSchema({
  type: "object",
  properties: {
    sessions: { type: "array", items: { type: "object", additionalProperties: true } },
    nextCursor: { type: "string" },
    count: { type: "number" },
    sessionsTruncated: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const replyOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    requestID: { type: "string" },
    decision: { type: "string", enum: ["once", "always", "reject"] },
    approved: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const updateOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    updated: { type: "boolean" },
    title: { type: "string" },
    archived: { type: "boolean" },
    metadataChanged: { type: "boolean" },
    permissionsChanged: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const removeOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    removed: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const interruptOutput = outputSchema({
  type: "object",
  properties: {
    sessionID: { type: "string" },
    interrupted: { type: "boolean" },
    queueCleared: { type: "boolean" },
    queueResumed: { type: "number" },
    queuedCount: { type: "number" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const languageOutput = outputSchema({
  type: "object",
  properties: {
    language: { type: "string", enum: ["es", "en"] },
    changed: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const diagnosticsOutput = outputSchema({
  type: "object",
  properties: {
    version: { type: "string" },
    capabilities: { type: "object", additionalProperties: true },
    registry: { type: "object", additionalProperties: true },
    live: { type: "object", additionalProperties: true },
    queues: { type: "object", additionalProperties: true },
    options: { type: "object", additionalProperties: true },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const worktreesOutput = outputSchema({
  type: "object",
  properties: {
    action: { type: "string" },
    worktrees: { type: "array", items: { type: "object", additionalProperties: true } },
    removed: { type: "array", items: { type: "object", additionalProperties: true } },
    orphans: { type: "array", items: { type: "string" } },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const waitManyOutput = outputSchema({
  type: "object",
  properties: {
    mode: { type: "string", enum: ["any", "all"] },
    sessions: { type: "array", items: { type: "object", additionalProperties: true } },
    pending: { type: "array", items: { type: "string" } },
    elapsedMs: { type: "number" },
    timedOut: { type: "boolean" },
    aborted: { type: "boolean" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const raceOutput = outputSchema({
  type: "object",
  properties: {
    raceID: { type: "string" },
    status: { type: "string" },
    mode: { type: "string" },
    base: { type: "string" },
    targetDirectory: { type: "string" },
    keepWorktrees: { type: "boolean" },
    worktrees: { type: "array", items: { type: "string" } },
    candidates: { type: "array", items: { type: "object", additionalProperties: true } },
    recommended: { type: ["string", "null"] },
    ranking: { type: "array", items: { type: "string" } },
    rankingReasons: { type: "array", items: { type: "string" } },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const applyOutput = outputSchema({
  type: "object",
  properties: {
    raceID: { type: "string" },
    candidateID: { type: "string" },
    applied: { type: "boolean" },
    alreadyApplied: { type: "boolean" },
    dryRun: { type: "boolean" },
    strategy: { type: "string" },
    targetDirectory: { type: "string" },
    integrationDirectory: { type: "string" },
    base: { type: "string" },
    backup: { type: "string" },
    commit: { type: "string" },
    pushed: { type: "boolean" },
    pushError: { type: "string" },
    verification: { type: "object", additionalProperties: true },
    reason: { type: "string" },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const raceStatusOutput = outputSchema({
  type: "object",
  properties: {
    races: { type: "array", items: { type: "object", additionalProperties: true } },
    race: { type: "object", additionalProperties: true },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

const raceCleanupOutput = outputSchema({
  type: "object",
  properties: {
    raceID: { type: "string" },
    removed: { type: "array", items: { type: "string" } },
    orphans: { type: "array", items: { type: "string" } },
    state: outputStateSchema,
    error: { type: "string" },
  },
  additionalProperties: true,
})

function signatureOf(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function openSignature(data: OpenInput, directory: string | undefined): string {
  return signatureOf({
    sessionID: data.sessionID,
    prompt: data.prompt,
    title: data.title,
    agent: data.agent,
    model: data.model,
    delivery: data.delivery,
    permissions: data.permissions,
    directory: directory ? normalizeDirectory(directory) : undefined,
    runID: data.runID,
  })
}

function sendSignature(data: {
  sessionID: string
  prompt: string
  agent?: string
  model?: string
  delivery: "steer" | "queue"
}): string {
  return signatureOf({
    sessionID: data.sessionID,
    prompt: data.prompt,
    agent: data.agent,
    model: data.model,
    delivery: data.delivery,
  })
}

function sameModel(
  current: { providerID: string; id: string; variant?: string } | undefined,
  target: { providerID: string; id: string; variant?: string } | undefined,
): boolean {
  if (!current || !target) return false
  return (
    current.providerID === target.providerID &&
    current.id === target.id &&
    (current.variant ?? undefined) === (target.variant ?? undefined)
  )
}

function rememberSentMessage(
  sentMessages: SentMessages,
  key: string,
  entry: SentMessageEntry,
): void {
  sentMessages.delete(key)
  sentMessages.set(key, entry)
  while (sentMessages.size > 500) {
    const oldest = sentMessages.keys().next().value
    if (typeof oldest !== "string") break
    sentMessages.delete(oldest)
  }
}

function progressFor(context: ToolExecuteContext, sessionID: string) {
  return (info: ProgressInfo) => {
    const update: Record<string, string | number> = {
      status: "waiting",
      sessionID,
      elapsedMs: info.elapsedMs,
      fetchCount: info.fetchCount,
    }
    if (info.lastEvent) update.lastEvent = info.lastEvent
    if (info.state) update.state = info.state
    if (info.retry) {
      const current = refreshRetry(info.retry)
      update.retryAttempt = current.attempt
      update.retryNext = current.next
      update.retryAt = current.atISO ?? ""
      update.retryInMs = current.inMs ?? 0
      update.retryMessage = truncateCodePoints(current.message, 1_000)
    }
    void context.progress(update).catch(() => undefined)
  }
}

function waitConfig(deps: ToolDeps, context: ToolExecuteContext, sessionID: string) {
  return {
    pollIntervalMs: deps.options.pollIntervalMs,
    maxPollIntervalMs: deps.options.maxPollIntervalMs,
    permissionPollMs: deps.options.permissionPollMs,
    requestTimeoutMs: deps.options.requestTimeoutMs,
    progressIntervalMs: deps.options.progressIntervalMs,
    onProgress: progressFor(context, sessionID),
  }
}

function sessionHeader(lang: Lang, session: SessionInfo): string {
  const title = session.title ? sanitizeTitle(session.title) : t(lang, "noTitle")
  return `${t(lang, "session")}: ${oneLine(session.id, 256)}\n${t(lang, "title")}: ${title}`
}

function modelLabel(session: SessionInfo): string {
  return session.model ? `${session.model.providerID}/${session.model.id}` : ""
}

function turnStateLabel(lang: Lang, turn: TurnResult): string | undefined {
  if (turn.state === "idle") return undefined
  if (turn.state === "timeout") {
    return turn.queued
      ? `${t(lang, "timedOutRunning")} · ${t(lang, "messageQueued")}`
      : t(lang, "timedOutRunning")
  }
  if (turn.state === "aborted") return t(lang, "waitCancelled")
  if (turn.state === "permission") return t(lang, "waitPermission")
  return t(lang, "waitError")
}

function renderTurn(
  lang: Lang,
  header: string,
  turn: TurnResult,
  maxOutputChars: number,
  options: BridgeOptions,
): string {
  const summary = summarizeTurn(
    turn.messages,
    turn.startIndex,
    false,
    turn.endIndex,
    options.maxTools,
    options.maxTextChars,
  )
  const showLastError =
    turn.state !== "idle" || summary.outcome === "failed" || summary.outcome === "interrupted"
  return formatSummary(header, summary, {
    lang,
    state: turnStateLabel(lang, turn),
    maxOutputChars,
    maxTextChars: options.maxTextChars,
    maxTools: options.maxTools,
    maxToolLine: options.maxToolLine,
    maxPermissions: options.maxPermissions,
    promptMessageID: turn.promptMessageID,
    lastError: showLastError ? turn.lastError : undefined,
    pendingPermissions: turn.pendingPermissions,
  })
}

async function appendPermissionHint(
  deps: ToolDeps,
  context: ToolExecuteContext,
  lang: Lang,
  sessionID: string,
  content: string,
  maxOutputChars: number,
): Promise<string> {
  try {
    const pending = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
      deps.ctx.permission.list({ sessionID }, { signal }),
    )
    if (!pending.length) return content
    const permBudget = Math.max(200, Math.floor(maxOutputChars * 0.4))
    const header = t(lang, "pendingPermissionsCount", { count: pending.length })
    const hint = t(lang, "replyHint")
    const lines = [header]
    let used = header.length + 1 + hint.length
    const shown = pending.slice(0, deps.options.maxPermissions)
    for (let index = 0; index < shown.length; index++) {
      const line = truncateCodePoints(
        permissionLine(shown[index], lang),
        Math.max(100, Math.floor(permBudget / 2)),
      )
      const cost = line.length + 1
      if (index === 0 || used + cost <= permBudget) {
        lines.push(line)
        used += cost
      } else {
        lines.push("  · …")
        break
      }
    }
    lines.push(hint)
    const tail = lines.join("\n")
    const body = capOutput(content, Math.max(0, maxOutputChars - tail.length - 2), lang)
    return capOutput(`${body}${body ? "\n\n" : ""}${tail}`, maxOutputChars, lang)
  } catch {
    return content
  }
}

function formatTimestamp(value: number | undefined, lang: Lang): string {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 8.64e15
    ? new Date(value).toISOString()
    : t(lang, "unknownF")
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return /not found|404/i.test(String(error))
  const record = error as Record<string, unknown>
  if (record.status === 404) return true
  const message = typeof record.message === "string" ? record.message : ""
  return /not found|404/i.test(message)
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return /already exists|exists already|conflict|409/i.test(String(error))
  }
  const record = error as Record<string, unknown>
  if (record.status === 409) return true
  const message = typeof record.message === "string" ? record.message : ""
  return /already exists|exists already|conflict|409/i.test(message)
}

function queueOptions(options: BridgeOptions): QueueOptions {
  return { ttlMs: options.queueTtlMs, maxPerSession: options.maxQueuedPrompts }
}

function liveQueue(deps: ToolDeps, sessionID: string): LiveSnapshot {
  return deps.liveState?.get(sessionID) ?? { pending: [] }
}

function retryOutput(
  retry: RetryInfo | undefined,
  maxChars = 1_000,
): Record<string, unknown> | undefined {
  if (!retry) return undefined
  const current = refreshRetry(retry)
  return {
    attempt: current.attempt,
    message: oneLine(current.message, maxChars),
    next: current.next,
    retryAt: current.atISO,
    retryInMs: current.inMs,
  }
}

function retryLabel(lang: Lang, retry: RetryInfo): string {
  const seconds = Math.ceil(retryRemainingMs(retry) / 1_000)
  return `${t(lang, "retrying")} (${t(lang, "retryAttempt", {
    attempt: retry.attempt,
  })}; ${t(lang, "retryNext", {
    seconds,
  })})`
}

function turnOutputValue(
  sessionID: string,
  title: string | undefined,
  turn: TurnResult,
  options: BridgeOptions,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const budget = outputBudget(options)
  const summary = summarizeTurn(
    turn.messages,
    turn.startIndex,
    false,
    turn.endIndex,
    options.maxTools,
    budget.maxTextChars,
  )
  const pending = boundPendingPermissions(
    turn.pendingPermissions,
    budget.maxPermissions,
    options.language,
  )
  const error = boundError(turn.lastError, budget.maxErrorChars)
  return cleanOutput({
    sessionID,
    title: boundTitle(title, budget.maxTitleChars),
    messageID: turn.promptMessageID,
    state: turn.state,
    outcome: summary.outcome,
    lastMessageID: summary.lastMessageID,
    text: summary.text,
    textLength: summary.textLength,
    textTruncated: summary.textTruncated,
    elapsedMs: turn.elapsedMs,
    fetchCount: turn.fetchCount,
    queued: Boolean(turn.queued),
    retry: retryOutput(turn.retry, budget.maxErrorChars),
    permissionCheckedAt: turn.permissionCheckedAt,
    pendingPermissions: pending.pendingPermissions,
    pendingTotal: pending.pendingTotal,
    pendingTruncated: pending.pendingTruncated,
    ...error,
    ...extra,
  })
}

function errorFor(
  deps: ToolDeps,
  error: unknown,
  input: unknown,
  keys: string[] = ["sessionID", "messageID", "requestID"],
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const key of keys) {
    const value = stringField(input, key)
    if (value !== undefined) {
      const max =
        key === "title"
          ? deps.options.maxTitleChars
          : key === "search"
            ? deps.options.maxSearchChars
            : 500
      extra[key] = truncateCodePoints(value, max)
    }
  }
  return errorOutput(error, deps.options.maxErrorChars, extra)
}

function maxOutputSchemaFor(deps: ToolDeps) {
  return {
    anyOf: [
      { const: 0 },
      {
        type: "integer",
        minimum: 1_000,
        maximum: deps.options.maxOutputChars,
      },
    ],
    description: `Maximum output characters. 0 uses the plugin default (${deps.options.maxOutputChars}); otherwise the minimum is 1000.`,
  }
}

function maxTextSchemaFor(deps: ToolDeps) {
  return {
    anyOf: [
      { const: 0 },
      {
        type: "integer",
        minimum: 100,
        maximum: deps.options.maxTextChars,
      },
    ],
    description: `Maximum characters for the last text. 0 uses the plugin default (${deps.options.maxTextChars}); otherwise the minimum is 100.`,
  }
}

export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  const queuedPrompts: QueuedPrompts = deps.queuedPrompts ?? new Map()
  const openSessions: OpenSessionMapping = deps.openSessions ?? new Map()
  const inFlightOpens: Map<string, OpenInflight> = deps.inFlightOpens ?? new Map()
  const inFlightSends: Map<string, SendInflight> = deps.inFlightSends ?? new Map()
  const sentMessages: SentMessages = deps.sentMessages ?? new Map()
  const add = (
    definition: ToolDefinition,
    execute: ToolExecute,
    errorKey?: StringKey,
    buildErrorOutput?: (error: unknown, input: unknown) => Record<string, unknown>,
  ) => {
    const tool = {
      ...definition,
      execute: async (input: unknown, context: ToolExecuteContext) => {
        const lang = deps.getLanguage()
        try {
          let worker = isWorkerSession(
            deps.workerSessions ?? getProcessWorkerSessions(),
            context.sessionID,
          )
          if (!worker && deps.refreshWorkers) {
            await deps.refreshWorkers()
            worker = isWorkerSession(
              deps.workerSessions ?? getProcessWorkerSessions(),
              context.sessionID,
            )
          }
          if (worker) {
            const touch = touchWorkerSession(
              deps.workerSessions ?? getProcessWorkerSessions(),
              context.sessionID,
            )
            if (touch.persist && deps.persistWorkers) {
              await deps.persistWorkers().catch(() => undefined)
            }
          }
          if (worker && !deps.options.allowWorkerOrchestration) {
            return {
              content: t(lang, "workerBlocked"),
              output: {
                state: "error",
                error: t(lang, "workerBlocked"),
                worker: true,
                hint: t(lang, "workerHint"),
              },
            }
          }
          const result = await execute(input, context, lang)
          throwIfAborted(context.signal)
          return {
            content: capOutput(result.content, deps.options.maxOutputChars, lang),
            ...(result.output !== undefined
              ? {
                  output: jsonSafe(
                    boundOutputTotal(result.output, deps.options.maxOutputTotalChars),
                  ),
                }
              : {}),
            ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
          }
        } catch (error) {
          // A denied permission is a Tool.Error, not a successful report.
          if (error instanceof PermissionDenied) throw error.cause
          // Host cancellation is not a normal tool result; let the host mark
          // the call as aborted. Internal request timeouts still become errors.
          throwIfAborted(context.signal)
          const prefix = errorKey ? `${t(lang, errorKey)}: ` : ""
          const output = buildErrorOutput
            ? buildErrorOutput(error, input)
            : errorFor(deps, error, input)
          return {
            content: capOutput(
              `${prefix}${oneLine(formatError(error), deps.options.maxErrorChars)}`,
              deps.options.maxOutputChars,
              lang,
            ),
            output: jsonSafe(boundOutputTotal(output, deps.options.maxOutputTotalChars)),
          }
        }
      },
    }
    editor.add(tool as RegisteredTool)
  }

  add(
    {
      name: "open",
      description:
        "Create or reuse an OpenCode session, optionally in another validated project/worktree directory, send it a message, and wait for its turn. Returns the final state, response text, actions (tools) performed, directory, owner, and role. Pass sessionID or reuse messageID to retry without duplicating the session; messageID is scoped to the target directory.",
      input: schema({
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description:
              "Optional session ID to create or reuse. Retries with the same ID do not create a second session.",
          },
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Initial message to send to the new session." },
          title: { type: "string", maxLength: deps.options.maxTitleChars, description: "Session title. If omitted, it is derived from the message." },
          agent: { type: "string", maxLength: deps.options.maxAgentChars, description: "Agent ID. Defaults to build." },
          model: { type: "string", maxLength: deps.options.maxModelChars, description: "Model in provider/model format. Defaults to this session's model." },
          delivery: {
            type: "string",
            enum: ["steer", "queue"],
            description: "steer (default) starts the turn immediately; queue waits for the current turn.",
          },
          wait: {
            type: "boolean",
            description:
              "If true (default), wait for the turn to finish. Use false to keep working in the background and check later with sessions.status.",
          },
          timeoutMs: timeoutSchema,
          messageID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description:
              "Optional idempotency key for the message and for the session mapping. Reusing it does not create a second message or session.",
          },
          directory: {
            type: "string",
            maxLength: deps.options.maxPathChars,
            description:
              "Absolute directory (project or registered worktree) where the session is created. Defaults to the caller's directory.",
          },
          runID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description:
              "Optional orchestration run ID. Sessions created with a run ID are registered as workers of that run.",
          },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            description:
              "Optional permission rules for the new session. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchemaFor(deps),
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["prompt"],
        additionalProperties: false,
      }),
      output: turnOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseOpenInput(input, lang, deps.options)
      const signal = signalOf(context)
      const ownerDirectory = deps.ctx.location?.directory
      if (!ownerDirectory) {
        throw new ValidationError(t(lang, "invalidDirectory"))
      }
      const explicitModel = parseModel(data.model)
      const ownerSessionID = context.sessionID
      const runID = data.runID

      let targetDirectory: string = ownerDirectory
      if (data.directory) {
        const validation = await (deps.validateDirectory ?? validateTargetDirectory)(
          data.directory,
          {
            projectDirectory: deps.ctx.location?.project?.directory,
            projectCanonical: deps.ctx.location?.project?.canonical,
            registeredDirectories: registeredWorktreeDirectories(deps),
            allowWorktreeDirectories: deps.options.allowWorktreeDirectories,
          },
        )
        if (!validation.ok) {
          throw new ValidationError(
            `${t(lang, "directoryInvalid", { reason: validation.error })} ${t(lang, "directoryOutsideProject")}`,
          )
        }
        targetDirectory = validation.realDirectory
      }
      const role: SessionRole =
        runID || !sameDirectory(targetDirectory, ownerDirectory) ? "worker" : "orchestrator"
      const permissionRules =
        role === "worker"
          ? workerPermissionRules(deps.options, data.permissions)
          : data.permissions

      // Permission policy is evaluated for every caller, even when the
      // admission itself is deduplicated and shared.
      await assertPermission(deps.ctx, context, "session_bridge.open",
        [data.sessionID ?? data.messageID ?? "new-session", targetDirectory],
        {
          delivery: data.delivery,
          wait: data.wait,
          directory: targetDirectory,
          hasSessionID: Boolean(data.sessionID),
          hasMessageID: Boolean(data.messageID),
          role,
          ...(runID ? { runID } : {}),
          ...(data.agent ? { agent: data.agent } : {}),
          ...(explicitModel ? { model: data.model } : {}),
        },
      )

      // A messageID used in another directory is an explicit conflict, not a
      // silent reuse. This check also covers concurrent admissions that have
      // not written the mapping yet.
      const mapped = findOpenSession(openSessions, data.messageID)
      const mappedDirectory = mapped?.targetDirectory ?? mapped?.directory
      if (mapped && mappedDirectory && !sameDirectory(mappedDirectory, targetDirectory)) {
        throw new ValidationError(t(lang, "openConflict"))
      }
      if (data.messageID) {
        for (const operation of inFlightOpens.values()) {
          if (
            operation.messageID === data.messageID &&
            !sameDirectory(operation.directory, targetDirectory)
          ) {
            throw new ValidationError(t(lang, "openConflict"))
          }
        }
      }

      const openKey = data.messageID
        ? `message:${data.messageID}@${normalizeDirectory(targetDirectory)}`
        : data.sessionID
          ? `session:${data.sessionID}@${normalizeDirectory(targetDirectory)}`
          : undefined
      const signature = openSignature(data, targetDirectory)
      let inflight: OpenInflight
      const existing = openKey ? inFlightOpens.get(openKey) : undefined
      if (existing) {
        if (existing.signature !== signature) {
          throw new ValidationError(t(lang, "openConflict"))
        }
        existing.waiters++
        inflight = existing
      } else {
        const controller = new AbortController()
        const title = titleFromPrompt(
          data.prompt,
          data.title,
          t(lang, "newSession"),
          deps.options.maxTitleChars,
        )
        const operation: OpenInflight = {
          signature,
          messageID: data.messageID,
          directory: targetDirectory,
          controller,
          waiters: 1,
          settled: false,
          promise: Promise.resolve({
            ok: false,
            error: new Error("not started"),
            title,
            directory: targetDirectory,
          }),
        }
        operation.promise = (async (): Promise<OpenAdmission> => {
          let created: SessionInfo | undefined
          let reused = false
          let permissionsApplied = false
          let locationVerified = false
          let displayTitle = truncateCodePoints(title, deps.options.maxTitleChars)
          let targetSessionID =
            data.sessionID ?? lookupOpenSession(openSessions, data.messageID, targetDirectory)
          const internalSignal = controller.signal
          try {
            if (targetSessionID) {
              const ownedEntry = deps.ownedSessions.get(targetSessionID)
              if (
                ownedEntry?.ownerSessionID &&
                ownedEntry.ownerSessionID !== ownerSessionID &&
                ownedEntry.runID !== runID
              ) {
                throw new ValidationError(
                  `${t(lang, "foreignSessionBlocked")} ${t(lang, "foreignSessionHint")}`,
                )
              }
              try {
                created = await withRequest(
                  internalSignal,
                  deps.options.requestTimeoutMs,
                  (request) =>
                    deps.ctx.session.get(
                      { sessionID: targetSessionID as string },
                      { signal: request },
                    ),
                )
                reused = true
                const current = created
                if (!current) throw new Error("session.get returned no session")
                if (!current.location?.directory) {
                  locationVerified = false
                } else if (!sameDirectory(current.location.directory, targetDirectory)) {
                  throw new ValidationError(
                    `${t(lang, "openConflict")} (session location: ${current.location.directory}, requested: ${targetDirectory})`,
                  )
                } else {
                  locationVerified = true
                }
                if (data.agent && current.agent && data.agent !== current.agent) {
                  throw new ValidationError(
                    `${t(lang, "openConflict")} (agent: ${current.agent}, requested: ${data.agent})`,
                  )
                }
                if (explicitModel && current.model && !sameModel(modelRef(current.model), explicitModel)) {
                  throw new ValidationError(
                    `${t(lang, "openConflict")} (model: ${current.model.providerID}/${current.model.id}, requested: ${data.model})`,
                  )
                }
                if (permissionRules?.length) {
                  await withRequest(
                    internalSignal,
                    deps.options.requestTimeoutMs,
                    (request) =>
                      deps.ctx.session.update(
                        {
                          sessionID: current.id,
                          permissions: permissionRules,
                        },
                        { signal: request },
                      ),
                  )
                  permissionsApplied = true
                }
              } catch (error) {
                if (!isNotFoundError(error)) throw error
              }
            }

            if (!created) {
              let fallback: { providerID: string; id: string; variant?: string } | undefined
              if (!explicitModel) {
                if (context.sessionID) {
                  const callerSessionID = context.sessionID
                  const caller = await withRequest(
                    internalSignal,
                    deps.options.requestTimeoutMs,
                    (request) =>
                      deps.ctx.session.get({ sessionID: callerSessionID }, { signal: request }),
                  ).catch(() => undefined)
                  fallback = modelRef(caller?.model)
                }
                if (!fallback) {
                  const preferred = await withRequest(
                    internalSignal,
                    deps.options.requestTimeoutMs,
                    (request) => deps.ctx.model.default(undefined, { signal: request }),
                  ).catch(() => undefined)
                  // `model.default` returns `{ location, data: ModelInfo | null }`.
                  fallback = modelRef(preferred?.data)
                }
              }

              try {
                type SessionCreateInput = Parameters<PluginContext["session"]["create"]>[0]
                const createInput = {
                  id: targetSessionID,
                  title,
                  agent: data.agent ?? "build",
                  model: explicitModel ?? fallback,
                  permissions: permissionRules,
                  location: { directory: targetDirectory },
                } as SessionCreateInput
                created = await withRequest(
                  internalSignal,
                  deps.options.requestTimeoutMs,
                  (request) => deps.ctx.session.create(createInput, { signal: request }),
                )
              } catch (error) {
                // A concurrent creator may have won the race for an explicit ID.
                if (targetSessionID && isAlreadyExistsError(error)) {
                  created = await withRequest(
                    internalSignal,
                    deps.options.requestTimeoutMs,
                    (request) =>
                      deps.ctx.session.get(
                        { sessionID: targetSessionID as string },
                        { signal: request },
                      ),
                  )
                  reused = true
                } else {
                  throw error
                }
              }
            }

            const createdSessionID = created.id
            targetSessionID = createdSessionID
            displayTitle = truncateCodePoints(
              sanitizeTitle(created.title ?? title),
              deps.options.maxTitleChars,
            )

            // Verify the location the host actually used. A session silently
            // created in another directory must not receive this prompt.
            const verified = await withRequest(
              internalSignal,
              deps.options.requestTimeoutMs,
              (request) =>
                deps.ctx.session.get({ sessionID: createdSessionID }, { signal: request }),
            )
            const verifiedDirectory = verified.location?.directory
            locationVerified = Boolean(verifiedDirectory)
            if (verifiedDirectory && !sameDirectory(verifiedDirectory, targetDirectory)) {
              await deps.ctx.session
                .remove({ sessionID: createdSessionID }, { signal: internalSignal })
                .catch(() => undefined)
              throw new ValidationError(
                `${t(lang, "openConflict")} (session location: ${verifiedDirectory}, requested: ${targetDirectory})`,
              )
            }
            created = verified
            displayTitle = truncateCodePoints(
              sanitizeTitle(created.title ?? title),
              deps.options.maxTitleChars,
            )

            const ownedMetadata = {
              ...(ownerSessionID ? { ownerSessionID } : {}),
              ...(runID ? { runID } : {}),
              ownerDirectory,
              targetDirectory,
              role,
            }
            if (data.messageID) {
              const mapping = {
                ...(ownerSessionID ? { ownerSessionID } : {}),
                ...(runID ? { runID } : {}),
                targetDirectory,
              }
              if (deps.registry) {
                deps.registry.rememberOpen(
                  data.messageID,
                  createdSessionID,
                  targetDirectory,
                  mapping,
                )
              } else {
                await rememberOpenSession(
                  deps.ctx,
                  openSessions,
                  data.messageID,
                  createdSessionID,
                  targetDirectory,
                  mapping,
                )
              }
            }
            if (deps.registry) {
              deps.registry.rememberOwned(createdSessionID, targetDirectory, ownedMetadata)
            } else {
              await rememberOwnedSession(
                deps.ctx,
                deps.ownedSessions,
                createdSessionID,
                targetDirectory,
                ownedMetadata,
              )
            }
            if (role === "worker" && deps.workerSessions) {
              await rememberWorkerSession(deps.ctx, deps.workerSessions, {
                sessionID: createdSessionID,
                targetDirectory,
                ...(ownerSessionID ? { ownerSessionID } : {}),
                ...(runID ? { runID } : {}),
                ownerDirectory,
              })
            }
            if (deps.worktrees) {
              await attachAndPersistSession(
                deps.ctx,
                deps.worktrees,
                targetDirectory,
                createdSessionID,
              )
            }

            const admitted = await withRequest(
              internalSignal,
              deps.options.requestTimeoutMs,
              (request) =>
                deps.ctx.session.prompt(
                  {
                    sessionID: createdSessionID,
                    text: data.prompt,
                    delivery: data.delivery,
                    id: promptMessageID(data.messageID, `open:${targetDirectory}`),
                  },
                  { signal: request },
                ),
            )
            return {
              ok: true,
              session: created,
              admitted,
              reused,
              title: displayTitle,
              directory: targetDirectory,
              role,
              ...(ownerSessionID ? { ownerSessionID } : {}),
              ...(runID ? { runID } : {}),
              permissionsApplied,
              locationVerified,
            }
          } catch (error) {
            return {
              ok: false,
              error,
              sessionID: created?.id ?? targetSessionID,
              title: displayTitle,
              messageID: data.messageID,
              directory: targetDirectory,
            }
          }
        })()

        if (openKey) {
          inFlightOpens.set(openKey, operation)
          const clear = () => {
            operation.settled = true
            if (inFlightOpens.get(openKey) === operation) inFlightOpens.delete(openKey)
          }
          void operation.promise.then(clear, clear)
          if (inFlightOpens.size > 100) {
            for (const [key, value] of inFlightOpens) {
              if (inFlightOpens.size <= 100) break
              if (key !== openKey && value.settled) inFlightOpens.delete(key)
            }
          }
        }
        inflight = operation
      }

      const release = () => {
        inflight.waiters = Math.max(0, inflight.waiters - 1)
        if (inflight.waiters === 0) inflight.controller.abort()
      }
      let admission: OpenAdmission
      try {
        admission = await awaitWithSignal(inflight.promise, signal)
      } finally {
        release()
      }

      const title = admission.title
      if (!admission.ok) {
        if (admission.error instanceof PermissionDenied) throw admission.error
        const errorID = admission.sessionID
        const suffix = errorID
          ? `\n${t(lang, "orphanSession", { id: oneLine(errorID, 256) })}`
          : ""
        return {
          content: `${t(lang, "couldNotOpen")}: ${oneLine(
            formatError(admission.error),
            deps.options.maxErrorChars,
          )}${suffix}`,
          output: errorOutput(admission.error, deps.options.maxErrorChars, {
            sessionID: errorID,
            messageID: admission.messageID ?? data.messageID,
            title: boundTitle(data.title ?? title, deps.options.maxTitleChars),
            directory: admission.directory,
          }),
        }
      }

      const created = admission.session
      const admitted = admission.admitted
      const reused = admission.reused
      const displayTitle = title
      const header = `${t(lang, reused ? "reused" : "created")}: ${oneLine(
        created.id,
        256,
      )}\n${t(lang, "title")}: ${displayTitle}\n${t(lang, "directory")}: ${oneLine(
        admission.directory,
        deps.options.maxPathChars,
      )}\n${t(lang, "role")}: ${admission.role}`
      if (!data.wait) {
        if (data.delivery === "queue") {
          enqueueQueuedPrompt(
            queuedPrompts,
            created.id,
            admitted.id,
            "queue",
            queueOptions(deps.options),
          )
        }
        const queued = data.delivery === "queue" ? `\n${t(lang, "messageQueued")}` : ""
        return {
          content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${oneLine(
            admitted.id,
            256,
          )}${queued}`,
          output: cleanOutput({
            sessionID: created.id,
            title: displayTitle,
            messageID: admitted.id,
            directory: admission.directory,
            role: admission.role,
            ownerSessionID: admission.ownerSessionID,
            runID: admission.runID,
            locationVerified: admission.locationVerified,
            permissionsApplied: admission.permissionsApplied,
            state: data.delivery === "queue" ? "queued" : "running",
            queued: data.delivery === "queue",
            pendingPermissions: [],
            pendingTotal: 0,
            pendingTruncated: false,
            textLength: 0,
            textTruncated: false,
            reused,
          }),
        }
      }

      const turn = await waitForTurn(deps.ctx, {
        sessionID: created.id,
        anchorID: admitted.id,
        promptText: data.prompt,
        admittedAt: admitted.time?.created ?? Date.now(),
        timeoutMs: data.timeoutMs,
        signal,
        requireAnchor: true,
        promptMessageID: admitted.id,
        ...waitConfig(deps, context, created.id),
      })
      if (turn.state === "aborted") throw abortError(signal)
      throwIfAborted(signal)
      if (turn.state === "idle") {
        removeQueuedPrompt(
          queuedPrompts,
          created.id,
          admitted.id,
          queueOptions(deps.options),
        )
        deps.liveState?.markDelivered(created.id, admitted.id)
        deps.liveState?.reconcile(created.id, turn.messages)
      }
      let content = renderTurn(lang, header, turn, data.maxOutputChars, deps.options)
      if (
        turn.state !== "idle" &&
        !turn.pendingPermissions?.length &&
        !(
          turn.permissionCheckedAt &&
          Date.now() - turn.permissionCheckedAt < deps.options.permissionPollMs
        )
      ) {
        content = await appendPermissionHint(
          deps,
          context,
          lang,
          created.id,
          content,
          data.maxOutputChars,
        )
      }
      return {
        content,
        output: turnOutputValue(created.id, displayTitle, turn, deps.options, {
          reused,
          directory: admission.directory,
          role: admission.role,
          ownerSessionID: admission.ownerSessionID,
          runID: admission.runID,
          locationVerified: admission.locationVerified,
          permissionsApplied: admission.permissionsApplied,
        }),
      }
    },
    "couldNotOpen",
    (error, input) => errorFor(deps, error, input, ["sessionID", "messageID", "title"]),
  )

  add(
    {
      name: "send",
      description:
        "Send a message to an existing OpenCode session. Can switch its agent or model, wait for the exact turn admitted by the server, and return the state, response, and actions performed.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "Target session ID, for example ses_abc123." },
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Message to send to the session." },
          agent: { type: "string", maxLength: deps.options.maxAgentChars, description: "Optional: switch the session's agent before sending." },
          model: { type: "string", maxLength: deps.options.maxModelChars, description: "Optional: switch the model (provider/model) before sending." },
          delivery: {
            type: "string",
            enum: ["steer", "queue"],
            description: "steer (default) interrupts/steers the current turn; queue waits for its turn.",
          },
          wait: {
            type: "boolean",
            description: "If true (default), wait for the turn to finish. Use false to avoid blocking.",
          },
          timeoutMs: timeoutSchema,
          messageID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Optional idempotency key. Reusing it does not create a second message.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID", "prompt"],
        additionalProperties: false,
      }),
      output: turnOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseSendInput(input, lang, deps.options)
      const signal = signalOf(context)
      const signature = sendSignature(data)
      const key = data.messageID ? `${data.sessionID}:${data.messageID}` : undefined
      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.send",
        [data.sessionID, data.messageID ?? "new-message", data.delivery],
        {
          sessionID: data.sessionID,
          delivery: data.delivery,
          wait: data.wait,
          hasMessageID: Boolean(data.messageID),
          ...(data.agent ? { agent: data.agent } : {}),
          ...(data.model ? { model: data.model } : {}),
        },
      )

      const recorded = key ? sentMessages.get(key) : undefined
      if (recorded && Date.now() - recorded.at > deps.options.queueTtlMs) {
        if (key) sentMessages.delete(key)
      } else if (recorded) {
        if (recorded.signature !== signature) {
          throw new ValidationError(t(lang, "sendConflict"))
        }
      }

      let admission: SendAdmission
      let applied: string[] = []
      const existingRecord = key ? sentMessages.get(key) : undefined
      if (existingRecord && existingRecord.signature === signature) {
        try {
          const session = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
            deps.ctx.session.get({ sessionID: data.sessionID }, { signal: request }),
          )
          admission = {
            ok: true,
            session,
            admittedID: existingRecord.admittedID ?? data.messageID ?? "",
            admittedAt: existingRecord.admittedAt ?? existingRecord.at,
            applied: [],
            alreadySent: true,
          }
        } catch (error) {
          admission = { ok: false, error, applied: [] }
        }
      } else {
        let inflight: SendInflight | undefined = key ? inFlightSends.get(key) : undefined
        if (inflight) {
          if (inflight.signature !== signature) {
            throw new ValidationError(t(lang, "sendConflict"))
          }
          inflight.waiters++
        } else {
          const controller = new AbortController()
          const operation: SendInflight = {
            signature,
            controller,
            waiters: 1,
            settled: false,
            promise: Promise.resolve({ ok: false, error: new Error("not started"), applied: [] }),
          }
          operation.promise = (async (): Promise<SendAdmission> => {
            const internalSignal = controller.signal
            const changes: string[] = []
            try {
              const session = await withRequest(
                internalSignal,
                deps.options.requestTimeoutMs,
                (request) =>
                  deps.ctx.session.get({ sessionID: data.sessionID }, { signal: request }),
              )
              const model = parseModel(data.model)
              if (model && !sameModel(modelRef(session.model), model)) {
                await withRequest(
                  internalSignal,
                  deps.options.requestTimeoutMs,
                  (request) =>
                    deps.ctx.session.switchModel(
                      { sessionID: data.sessionID, model },
                      { signal: request },
                    ),
                )
                changes.push(`${t(lang, "model")}: ${data.model}`)
              }
              if (data.agent && session.agent !== data.agent) {
                const agent = data.agent
                await withRequest(
                  internalSignal,
                  deps.options.requestTimeoutMs,
                  (request) =>
                    deps.ctx.session.switchAgent(
                      { sessionID: data.sessionID, agent },
                      { signal: request },
                    ),
                )
                changes.push(`${t(lang, "agent")}: ${agent}`)
              }

              const admitted = await withRequest(
                internalSignal,
                deps.options.requestTimeoutMs,
                (request) =>
                  deps.ctx.session.prompt(
                    {
                      sessionID: data.sessionID,
                      text: data.prompt,
                      delivery: data.delivery,
                      id: promptMessageID(data.messageID, `send:${data.sessionID}`),
                    },
                    { signal: request },
                  ),
              )
              const admittedAt = admitted.time?.created ?? Date.now()
              if (key) {
                rememberSentMessage(sentMessages, key, {
                  signature,
                  at: Date.now(),
                  admittedID: admitted.id,
                  admittedAt,
                })
              }
              return {
                ok: true,
                session,
                admittedID: admitted.id,
                admittedAt,
                applied: changes,
                alreadySent: false,
              }
            } catch (error) {
              return { ok: false, error, applied: changes }
            }
          })()

          if (key) {
            inFlightSends.set(key, operation)
            const clear = () => {
              operation.settled = true
              if (inFlightSends.get(key) === operation) inFlightSends.delete(key)
            }
            void operation.promise.then(clear, clear)
            if (inFlightSends.size > 100) {
              for (const [sendKey, value] of inFlightSends) {
                if (inFlightSends.size <= 100) break
                if (sendKey !== key && value.settled) inFlightSends.delete(sendKey)
              }
            }
          }
          inflight = operation
        }

        const release = () => {
          if (!inflight) return
          inflight.waiters = Math.max(0, inflight.waiters - 1)
          if (inflight.waiters === 0) inflight.controller.abort()
        }
        try {
          admission = await awaitWithSignal(inflight.promise, signal)
        } finally {
          release()
        }
        applied = admission.applied
      }

      if (!admission.ok) {
        if (admission.error instanceof PermissionDenied) throw admission.error
        throwIfAborted(signal)
        const suffix = applied.length
          ? `\n${t(lang, "appliedChanges", { changes: applied.join(", ") })}`
          : ""
        return {
          content: `${t(lang, "couldNotSend")}: ${oneLine(
            formatError(admission.error),
            deps.options.maxErrorChars,
          )}${suffix}`,
          output: errorOutput(admission.error, deps.options.maxErrorChars, {
            sessionID: data.sessionID,
            messageID: data.messageID,
          }),
        }
      }

      const session = admission.session
      const admittedID = admission.admittedID
      const header = sessionHeader(lang, session)
      if (!data.wait) {
        if (data.delivery === "queue") {
          enqueueQueuedPrompt(
            queuedPrompts,
            data.sessionID,
            admittedID,
            "queue",
            queueOptions(deps.options),
          )
        }
        const queued = data.delivery === "queue" ? `\n${t(lang, "messageQueued")}` : ""
        return {
          content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${oneLine(
            admittedID,
            256,
          )}${queued}`,
          output: cleanOutput({
            sessionID: data.sessionID,
            title: boundTitle(session.title, deps.options.maxTitleChars),
            messageID: admittedID,
            state: data.delivery === "queue" ? "queued" : "running",
            queued: data.delivery === "queue",
            pendingPermissions: [],
            pendingTotal: 0,
            pendingTruncated: false,
            textLength: 0,
            textTruncated: false,
            alreadySent: admission.alreadySent,
            reused: admission.alreadySent,
          }),
        }
      }

      const turn = await waitForTurn(deps.ctx, {
        sessionID: data.sessionID,
        anchorID: admittedID,
        promptText: admission.alreadySent ? undefined : data.prompt,
        admittedAt: admission.alreadySent ? undefined : admission.admittedAt,
        timeoutMs: data.timeoutMs,
        signal,
        requireAnchor: true,
        promptMessageID: admittedID,
        ...waitConfig(deps, context, data.sessionID),
      })
      if (turn.state === "aborted") throw abortError(signal)
      throwIfAborted(signal)
      if (turn.state === "idle") {
        removeQueuedPrompt(
          queuedPrompts,
          data.sessionID,
          admittedID,
          queueOptions(deps.options),
        )
        deps.liveState?.markDelivered(data.sessionID, admittedID)
        deps.liveState?.reconcile(data.sessionID, turn.messages)
      }
      let content = renderTurn(lang, header, turn, data.maxOutputChars, deps.options)
      if (
        turn.state !== "idle" &&
        !turn.pendingPermissions?.length &&
        !(
          turn.permissionCheckedAt &&
          Date.now() - turn.permissionCheckedAt < deps.options.permissionPollMs
        )
      ) {
        content = await appendPermissionHint(
          deps,
          context,
          lang,
          data.sessionID,
          content,
          data.maxOutputChars,
        )
      }
      return {
        content,
        output: turnOutputValue(data.sessionID, session.title, turn, deps.options, {
          alreadySent: admission.alreadySent,
          reused: admission.alreadySent,
        }),
      }
    },
    "couldNotSend",
    (error, input) => errorFor(deps, error, input, ["sessionID", "messageID"]),
  )

  add(
    {
      name: "status",
      description:
        "Check right now whether a session is running, queued, idle, or waiting for permission. Returns the result, last text, recent tools, and the last message ID for reading further. Set includeText/includeTools to false to skip the transcript read. Uses session timestamps and ignores control messages.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to inspect." },
          recent: recentSchema,
          verbose: {
            type: "boolean",
            description: "Include agent, model, cost, and token details. Defaults to false.",
          },
          includeText: {
            type: "boolean",
            description: "Include the last assistant text. Defaults to true.",
          },
          includeTools: {
            type: "boolean",
            description: "Include recent tools. Defaults to true. If it and includeText are false, the transcript is not read.",
          },
          maxText: maxTextSchemaFor(deps),
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: statusOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseStatusInput(input, lang, deps.options)
      const signal = signalOf(context)
      const includeTranscript = data.includeText || data.includeTools
      const [sessionResult, messagesResult, pendingResult] = await Promise.allSettled([
        withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
          deps.ctx.session.get({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
        includeTranscript
          ? withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
              deps.ctx.session.context(
                { sessionID: data.sessionID },
                { signal: requestSignalValue },
              ),
            )
          : Promise.resolve(undefined),
        withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
          deps.ctx.permission.list({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
      ])

      if (sessionResult.status === "rejected") throw sessionResult.reason
      const session = sessionResult.value
      const messages = messagesResult.status === "fulfilled" ? (messagesResult.value ?? []) : []
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
      const contextError =
        messagesResult.status === "rejected" ? formatError(messagesResult.reason) : undefined
      const permissionError =
        pendingResult.status === "rejected" ? formatError(pendingResult.reason) : undefined

      if (includeTranscript && messagesResult.status === "fulfilled") {
        deps.liveState?.reconcile(data.sessionID, messages)
      }
      const localQueue = listQueuedPrompts(
        queuedPrompts,
        data.sessionID,
        queueOptions(deps.options),
      )
      const live = liveQueue(deps, data.sessionID)
      const seen = new Set(localQueue.map((entry) => entry.messageID))
      let merged = [
        ...localQueue,
        ...live.pending
          .filter((entry) => !seen.has(entry.messageID))
          .map((entry) => ({
            messageID: entry.messageID,
            at: entry.at,
            delivery: entry.delivery,
          })),
      ]
      const latestUser = lastUser(messages)
      let tracked = merged[0]
      if (tracked) {
        const evaluation = evaluateTurn(messages, {
          sessionID: data.sessionID,
          anchorID: tracked.messageID,
          requireAnchor: true,
          timeoutMs: 1,
        })
        if (evaluation.done || evaluation.hasTurnAssistant) {
          removeQueuedPrompt(
            queuedPrompts,
            data.sessionID,
            tracked.messageID,
            queueOptions(deps.options),
          )
          deps.liveState?.markDelivered(data.sessionID, tracked.messageID)
          merged = merged.slice(1)
          tracked = merged[0]
        }
      }
      const anchorID = tracked?.messageID ?? latestUser?.id
      const evaluation = anchorID
        ? evaluateTurn(messages, {
            sessionID: data.sessionID,
            anchorID,
            requireAnchor: Boolean(tracked),
            timeoutMs: 1,
          })
        : undefined
      const evaluationQueued = Boolean(evaluation && !evaluation.done && evaluation.queued)
      const queueIDs = merged.length
        ? merged.map((entry) => entry.messageID)
        : evaluationQueued && latestUser?.id
          ? [latestUser.id]
          : []
      const queued = queueIDs.length > 0 || evaluationQueued
      const queuedCount = Math.max(queueIDs.length, evaluationQueued ? 1 : 0)
      // The last admitted prompt is useful even when the turn is already idle.
      const promptMessageID = queueIDs[0] ?? latestUser?.id

      const now = Date.now()
      const liveStatusAt = live.statusAt
      const liveFresh =
        Boolean(live.status) &&
        typeof liveStatusAt === "number" &&
        now - liveStatusAt <= 5_000 &&
        (typeof session.time?.updated !== "number" || liveStatusAt >= session.time.updated - 1_000)
      const liveStatus = liveFresh ? live.status : undefined
      const liveStale = Boolean(live.status) && !liveFresh
      const liveRetry: RetryInfo | undefined =
        liveStatus?.type === "retry"
          ? retryInfo(liveStatus.attempt, liveStatus.message, liveStatus.next, now)
          : undefined
      const liveRunning =
        liveStatus?.type === "busy" ? true : liveStatus?.type === "idle" ? false : undefined
      const running = liveRunning ?? isRunning(session, messages)
      const idle = lastIdle(messages)
      const assistant = lastAssistant(messages)
      const textInfo = data.includeText
        ? assistantTextInfo(assistant, data.maxText)
        : { text: undefined, length: 0, truncated: false }
      const allTools = data.includeTools ? collectRecentTools(messages, data.recent) : []
      const omittedTools = Math.max(0, allTools.length - deps.options.maxTools)
      const tools = omittedTools > 0 ? allTools.slice(-deps.options.maxTools) : allTools

      const stateValue: "permission" | "retrying" | "error" | "running" | "queued" | "idle" =
        pending.length
          ? "permission"
          : liveRetry
            ? "retrying"
            : running
              ? "running"
              : queued
                ? "queued"
                : contextError || permissionError
                  ? "error"
                  : "idle"
      const retryLabelText = liveRetry ? retryLabel(lang, liveRetry) : undefined
      const stateLabel = pending.length
        ? t(lang, "permissionState")
        : liveRetry
          ? retryLabelText
          : running && queued
            ? `${t(lang, "running")} · ${t(lang, "queued")}`
            : queued
              ? t(lang, "queued")
              : running
                ? t(lang, "running")
                : t(lang, "idle")

      const lastOutcome =
        idle?.outcome ?? session.outcome ?? (liveFresh ? live.lastOutcome : undefined)
      const resultLabel = liveRetry
        ? t(lang, "retrying")
        : running
          ? t(lang, "running")
          : lastOutcome
            ? oneLine(lastOutcome, 120)
            : t(lang, "unknown")

      const headerBudget = Math.max(160, Math.floor(data.maxOutputChars * 0.2))
      const lines = [
        truncateCodePoints(sessionHeader(lang, session), headerBudget),
        `${t(lang, "state")}: ${stateLabel}`,
        `${t(lang, "result")}: ${resultLabel}`,
        `${t(lang, "lastUpdate")}: ${formatTimestamp(session.time?.updated, lang)}`,
      ]
      if (promptMessageID) {
        lines.push(`${t(lang, "promptMessageID")}: ${oneLine(promptMessageID, 256)}`)
      }
      if (queuedCount > 1) {
        lines.push(
          `${t(lang, "queuedMessages", { count: queuedCount })}: ${queueIDs
            .slice(0, 20)
            .map((id) => oneLine(id, 256))
            .join(", ")}`,
        )
      }
      if (live.background?.length) {
        lines.push(
          `${t(lang, "backgroundWork")}: ${live.background
            .slice(0, 10)
            .map((entry) =>
              oneLine(
                [entry.kind, entry.command ?? entry.description ?? entry.childSessionID ?? ""]
                  .filter(Boolean)
                  .join(" "),
                200,
              ),
            )
            .join(", ")}`,
        )
      }

      const errorBudget = Math.min(
        deps.options.maxErrorChars,
        Math.max(80, Math.floor(data.maxOutputChars * 0.1)),
      )
      const error =
        assistant?.error?.message ??
        idle?.error?.message ??
        (liveFresh ? live.lastError : undefined)
      if (error) {
        lines.push(`${t(lang, "error")}: ${oneLine(compact(error, errorBudget), errorBudget)}`)
      }
      if (contextError) {
        lines.push(
          `${t(lang, "error")}: ${oneLine(compact(contextError, errorBudget), errorBudget)}`,
        )
      }
      if (permissionError) {
        lines.push(
          `${t(lang, "error")}: ${oneLine(compact(permissionError, errorBudget), errorBudget)}`,
        )
      }
      if (liveRetry) {
        lines.push(
          `${t(lang, "retryReason")}: ${oneLine(
            compact(liveRetry.message, errorBudget),
            errorBudget,
          )}`,
        )
      }
      const lastMessageID = messages.length ? messages[messages.length - 1]?.id : undefined
      if (lastMessageID) {
        lines.push(`${t(lang, "lastMessage")}: ${oneLine(lastMessageID, 256)}`)
      }

      if (pending.length) {
        const permBudget = Math.max(160, Math.floor(data.maxOutputChars * 0.2))
        const permHeader = t(lang, "pendingPermissionsCount", { count: pending.length })
        const hint = t(lang, "replyHint")
        const permLines = [permHeader]
        let used = permHeader.length + 1 + hint.length
        const shown = pending.slice(0, deps.options.maxPermissions)
        for (let index = 0; index < shown.length; index++) {
          const line = boundedPermissionLine(
            shown[index],
            lang,
            Math.max(100, Math.floor(permBudget / 2)),
          )
          const cost = line.length + 1
          if (index === 0 || used + cost <= permBudget) {
            permLines.push(line)
            used += cost
          } else {
            permLines.push("  · …")
            break
          }
        }
        permLines.push(hint)
        lines.push(permLines.join("\n"))
      }

      // Everything above is required to resume or answer the session. Text and
      // tools are optional and go last so a tight budget cannot hide the IDs.
      if (data.verbose) {
        lines.push(
          `${t(lang, "agent")}: ${oneLine(session.agent ?? t(lang, "unknown"), 256)}`,
        )
        lines.push(
          `${t(lang, "model")}: ${oneLine(modelLabel(session) || t(lang, "unknown"), 512)}`,
        )
        lines.push(`${t(lang, "cost")}: ${compact(session.cost, 100) || t(lang, "unknown")}`)
        lines.push(`${t(lang, "tokens")}: ${compact(session.tokens, 200) || t(lang, "unknown")}`)
      }

      if (data.includeText) {
        const textBudget = Math.min(
          data.maxText,
          Math.max(200, Math.floor(data.maxOutputChars / 3)),
        )
        lines.push(
          `${t(lang, "lastText")}: ${
            textInfo.text ? truncateCodePoints(textInfo.text, textBudget) : t(lang, "noText")
          }`,
        )
      }

      if (data.includeTools) {
        if (allTools.length) {
          lines.push(t(lang, "recentActionsCount", { count: allTools.length }))
          if (omittedTools > 0) {
            lines.push(t(lang, "actionsOmitted", { count: omittedTools }))
          }
          lines.push(
            tools
              .map((tool) => toolLine(tool, false, { maxLine: deps.options.maxToolLine }))
              .join("\n"),
          )
        } else {
          lines.push(`${t(lang, "recentActions")}: ${t(lang, "none")}`)
        }
      }

      const budget = outputBudget(deps.options)
      const pendingOutput = boundPendingPermissions(pending, budget.maxPermissions, lang)
      const boundedError = boundError(
        error ?? contextError ?? permissionError,
        budget.maxErrorChars,
      )
      return {
        content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
        output: cleanOutput({
          sessionID: data.sessionID,
          title: boundTitle(session.title, budget.maxTitleChars),
          state: stateValue,
          running,
          queued,
          queuedCount,
          queuedMessageIDs: queueIDs.slice(0, 20),
          queuedTruncated: queueIDs.length > 20,
          nextQueuedMessageID: queueIDs[0],
          outcome: running || liveRetry ? undefined : lastOutcome,
          lastOutcome,
          promptMessageID,
          lastMessageID,
          text: textInfo.text,
          textLength: textInfo.length,
          textTruncated: textInfo.truncated,
          tools: data.includeTools
            ? tools.map((tool) => toolLine(tool, false, { maxLine: deps.options.maxToolLine }))
            : undefined,
          toolsTruncated: omittedTools > 0,
          pendingPermissions: pendingOutput.pendingPermissions,
          pendingTotal: pendingOutput.pendingTotal,
          pendingTruncated: pendingOutput.pendingTruncated,
          retry: retryOutput(liveRetry, budget.maxErrorChars),
          contextError: contextError ? oneLine(contextError, budget.maxErrorChars) : undefined,
          permissionError: permissionError
            ? oneLine(permissionError, budget.maxErrorChars)
            : undefined,
          transcriptAvailable: !contextError,
          permissionsAvailable: !permissionError,
          liveStale,
          background: live.background,
          backgroundCount: live.background?.length ?? 0,
          statusAt: liveStatusAt,
          lastError:
            liveFresh && live.lastError
              ? oneLine(live.lastError, budget.maxErrorChars)
              : undefined,
          ...boundedError,
          includeTools: data.includeTools,
          includeText: data.includeText,
        }),
      }
    },
    "couldNotInspect",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )

  add(
    {
      name: "permissions",
      description:
        "List pending permission requests for a session, with their action, resources, and request ID. Use sessions.reply to approve or reject them.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session whose pending permissions should be listed." },
          limit: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Maximum requests to show. Defaults to 20; 0 also uses the default.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: permissionsOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parsePermissionsInput(input, lang, deps.options)
      const pending = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.permission.list({ sessionID: data.sessionID }, { signal }),
      )
      if (!pending.length) {
        return {
          content: `${t(lang, "session")} ${oneLine(
            data.sessionID,
            256,
          )}: ${t(lang, "noPendingPermissions")}`,
          output: {
            sessionID: data.sessionID,
            pending: [],
            pendingTotal: 0,
            pendingTruncated: false,
            hasMore: false,
            state: "ok",
          },
        }
      }
      const shown = pending.slice(0, data.limit)
      const lines = [
        t(lang, "pendingPermissionsCount", { count: pending.length }),
        ...shown.map((request) =>
          permissionLine(request, lang, { maxLine: deps.options.maxToolLine }),
        ),
      ]
      if (pending.length > shown.length) lines.push("…")
      lines.push(t(lang, "replyHint3"))
      const pendingOutput = boundPendingPermissions(shown, shown.length, lang)
      return {
        content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
        output: {
          sessionID: data.sessionID,
          pending: pendingOutput.pendingPermissions,
          pendingTotal: pending.length,
          pendingTruncated: pending.length > shown.length,
          hasMore: pending.length > shown.length,
          state: "ok",
        },
      }
    },
    "couldNotQueryPermissions",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )

  add(
    {
      name: "reply",
      description:
        "Approve or reject a pending permission request. once allows this request, always allows and saves it, reject denies it. Foreign sessions and always require explicit opt-in options.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session that owns the request." },
          requestID: { type: "string", maxLength: deps.options.maxIdChars, description: "Permission request ID, for example per_abc123." },
          decision: {
            type: "string",
            enum: ["once", "always", "reject"],
            description: "once allows this request, always allows and saves it, reject denies it.",
          },
          message: {
            type: "string",
            maxLength: deps.options.maxPromptChars,
            description: "Optional message to include with the decision, especially when rejecting.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID", "requestID", "decision"],
        additionalProperties: false,
      }),
      output: replyOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseReplyInput(input, lang, deps.options)
      if (data.decision === "always" && !deps.options.allowPersistentPermissions) {
        throw new ValidationError(`${t(lang, "alwaysBlocked")} ${t(lang, "alwaysHint")}`)
      }
      if (
        !isOwnedSession(
          deps.ownedSessions,
          data.sessionID,
          callerOf(deps, context),
          Date.now(),
          { allowCrossDirectoryManagement: deps.options.allowCrossDirectoryManagement },
        ) &&
        !deps.options.allowReplyToForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignSessionBlocked")} ${t(lang, "foreignSessionHint")}`)
      }

      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.reply",
        [data.sessionID, data.requestID, data.decision],
        {
          sessionID: data.sessionID,
          requestID: data.requestID,
          decision: data.decision,
        },
      )

      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.permission.reply(
          {
            sessionID: data.sessionID,
            requestID: data.requestID,
            decision: data.decision,
            message: data.message,
          },
          { signal },
        ),
      )

      const label =
        data.decision === "once"
          ? t(lang, "approvedOnce")
          : data.decision === "always"
            ? t(lang, "approvedSaved")
            : t(lang, "rejected")
      return {
        content: `${t(lang, "requestApproved", {
          id: oneLine(data.requestID, 256),
          label,
        })}\n${t(lang, "session")}: ${oneLine(data.sessionID, 256)}`,
        output: {
          sessionID: data.sessionID,
          requestID: data.requestID,
          decision: data.decision,
          approved: data.decision !== "reject",
          state: "ok",
        },
      }
    },
    "couldNotReplyPermission",
    (error, input) => errorFor(deps, error, input, ["sessionID", "requestID"]),
  )

  add(
    {
      name: "read",
      description:
        "Read a session's recent transcript: user messages, assistant text, executed tools (with optional input/output), shell, synthetic, compaction, and optional reasoning. Applies a bounded output budget.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to read." },
          limit: limitSchema,
          afterMessageID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description:
              "Optional: return only messages after this ID. If it does not exist, the result says so and shows the last N messages.",
          },
          includeTools: { type: "boolean", description: "Include executed tools. Defaults to true." },
          includeToolOutput: {
            type: "boolean",
            description: "Include an excerpt of each tool's output. Defaults to false.",
          },
          includeReasoning: {
            type: "boolean",
            description: "Include assistant reasoning parts. Defaults to false.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: readOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseReadInput(input, lang, deps.options)
      const messages = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.context({ sessionID: data.sessionID }, { signal }),
      )
      const result = renderTranscriptDetailed(messages, {
        lang,
        limit: data.limit,
        afterMessageID: data.afterMessageID,
        includeTools: data.includeTools,
        includeToolOutput: data.includeToolOutput,
        includeReasoning: data.includeReasoning,
        maxOutputChars: data.maxOutputChars,
        maxTextChars: deps.options.maxTextChars,
        maxToolLine: deps.options.maxToolLine,
        maxToolsPerMessage: deps.options.maxTools,
      })
      return {
        content: result.content,
        output: cleanOutput({
          sessionID: data.sessionID,
          lastMessageID: result.lastMessageID,
          nextAfterMessageID: result.nextAfterMessageID,
          hasMore: result.hasMore,
          truncated: result.truncated,
          count: result.count,
          partial: result.partial,
          partialMessageID: result.partialMessageID,
          state: "ok",
        }),
      }
    },
    "couldNotRead",
    (error, input) => errorFor(deps, error, input, ["sessionID", "afterMessageID"]),
  )

  add(
    {
      name: "wait",
      description:
        "Wait for the session to finish the current turn (or the last started turn) and return its result, final text, and actions. If it is already idle, returns immediately. Returns state permission as soon as a permission is pending.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to wait for." },
          messageID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description:
              "Optional prompt message ID (for example from send with wait: false) to wait for that specific turn.",
          },
          timeoutMs: timeoutSchema,
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: turnOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseWaitInput(input, lang, deps.options)
      const signal = signalOf(context)
      const deadline = Date.now() + data.timeoutMs
      const remainingMs = () => Math.max(1, deadline - Date.now())
      const preflightTimeout = () =>
        Math.max(1, Math.min(deps.options.requestTimeoutMs, remainingMs()))
      const [sessionResult, messagesResult, pendingResult] = await Promise.allSettled([
        withRequest(signal, preflightTimeout(), (requestSignalValue) =>
          deps.ctx.session.get({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
        withRequest(signal, preflightTimeout(), (requestSignalValue) =>
          deps.ctx.session.context({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
        withRequest(signal, preflightTimeout(), (requestSignalValue) =>
          deps.ctx.permission.list({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
      ])

      const contextFailed = messagesResult.status === "rejected"
      const messages = messagesResult.status === "fulfilled" ? messagesResult.value : []
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
      // The preflight always attempted the list; reuse that timestamp so
      // waitForTurn does not immediately list again (failed lists are retried
      // by the normal permission poll or the final read).
      const permissionCheckedAt = Date.now()

      if (sessionResult.status === "rejected") {
        // If the session lookup itself consumed the whole budget, report a
        // timeout (with whatever the other preflight calls already learned)
        // instead of turning the deadline into an opaque request error.
        if (!signal.aborted && Date.now() >= deadline) {
          const fallbackHeader = `${t(lang, "session")}: ${oneLine(data.sessionID, 256)}`
          const fetchCount = messagesResult.status === "fulfilled" ? 1 : 0
          if (pending.length) {
            const turn: TurnResult = {
              state: "permission",
              messages,
              startIndex: messages.length,
              pendingPermissions: pending,
              elapsedMs: data.timeoutMs,
              fetchCount,
              permissionCheckedAt,
            }
            return {
              content: renderTurn(lang, fallbackHeader, turn, data.maxOutputChars, deps.options),
              output: turnOutputValue(data.sessionID, undefined, turn, deps.options),
            }
          }
          const turn: TurnResult = {
            state: "timeout",
            messages,
            startIndex: 0,
            elapsedMs: data.timeoutMs,
            fetchCount,
            permissionCheckedAt,
          }
          return {
            content: renderTurn(lang, fallbackHeader, turn, data.maxOutputChars, deps.options),
            output: turnOutputValue(data.sessionID, undefined, turn, deps.options),
          }
        }
        throw sessionResult.reason
      }
      const session = sessionResult.value
      const header = sessionHeader(lang, session)
      deps.liveState?.reconcile(data.sessionID, messages)
      const localQueue = listQueuedPrompts(
        queuedPrompts,
        data.sessionID,
        queueOptions(deps.options),
      )
      const live = liveQueue(deps, data.sessionID)
      const now = Date.now()
      const liveFresh =
        Boolean(live.status) &&
        typeof live.statusAt === "number" &&
        now - live.statusAt <= 5_000 &&
        (typeof session.time?.updated !== "number" || live.statusAt >= session.time.updated - 1_000)
      const targetMessageID =
        data.messageID ?? localQueue[0]?.messageID ?? live.pending[0]?.messageID
      const liveRetry: RetryInfo | undefined =
        liveFresh && live.status?.type === "retry"
          ? retryInfo(live.status.attempt, live.status.message, live.status.next, now)
          : undefined
      const liveRunning =
        !liveFresh
          ? undefined
          : live.status?.type === "busy"
            ? true
            : live.status?.type === "idle"
              ? false
              : undefined

      if (pending.length) {
        const turn: TurnResult = {
          state: "permission",
          messages,
          startIndex: messages.length,
          pendingPermissions: pending,
          elapsedMs: 0,
          fetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
          promptMessageID: targetMessageID,
          retry: liveRetry,
        }
        return {
          content: renderTurn(lang, header, turn, data.maxOutputChars, deps.options),
          output: turnOutputValue(data.sessionID, session.title, turn, deps.options),
        }
      }

      const running = liveRunning ?? isRunning(session, messages)
      const user = lastUser(messages)
      const busySince =
        typeof session.time?.busy === "number" &&
        (typeof session.time?.idle !== "number" || session.time.busy > session.time.idle)
          ? session.time.busy
          : undefined
      const staleAnchor =
        !targetMessageID &&
        busySince !== undefined &&
        (user?.time?.created ?? 0) < busySince
      const minimumAnchorCreatedAt = staleAnchor ? busySince : undefined
      const anchorID = targetMessageID ?? user?.id
      const evaluation = anchorID
        ? evaluateTurn(messages, {
            sessionID: data.sessionID,
            anchorID,
            requireAnchor: Boolean(targetMessageID),
            promptMessageID: targetMessageID,
            timeoutMs: data.timeoutMs,
            ...(minimumAnchorCreatedAt !== undefined ? { minimumAnchorCreatedAt } : {}),
          })
        : undefined

      if (targetMessageID && evaluation?.done) {
        removeQueuedPrompt(
          queuedPrompts,
          data.sessionID,
          targetMessageID,
          queueOptions(deps.options),
        )
        deps.liveState?.markDelivered(data.sessionID, targetMessageID)
        const summary = summarizeTurn(
          messages,
          evaluation.startIndex,
          false,
          evaluation.endIndex,
          deps.options.maxTools,
          deps.options.maxTextChars,
        )
        const turn: TurnResult = {
          state: "idle",
          messages,
          startIndex: evaluation.startIndex,
          endIndex: evaluation.endIndex,
          idle: evaluation.idle,
          lastError: evaluation.idle?.error?.message,
          elapsedMs: 0,
          fetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
          promptMessageID: targetMessageID,
          queued: false,
          retry: liveRetry,
        }
        return {
          content: formatSummary(header, summary, {
            lang,
            maxOutputChars: data.maxOutputChars,
            maxTextChars: deps.options.maxTextChars,
            maxTools: deps.options.maxTools,
            maxToolLine: deps.options.maxToolLine,
            maxPermissions: deps.options.maxPermissions,
            promptMessageID: targetMessageID,
          }),
          output: turnOutputValue(data.sessionID, session.title, turn, deps.options),
        }
      }

      if (!targetMessageID && !running && !contextFailed && !staleAnchor && (!user || evaluation?.done)) {
        if (!user) {
          const idle = lastIdle(messages)
          const lastOutcome = idle?.outcome ?? session.outcome
          return {
            content: capOutput(
              `${header}\n${t(lang, "state")}: ${t(lang, "idle")}\n${t(lang, "result")}: ${
                lastOutcome ?? t(lang, "unknown")
              }\n${t(lang, "noPendingTurns")}`,
              data.maxOutputChars,
              lang,
            ),
            output: cleanOutput({
              sessionID: data.sessionID,
              title: boundTitle(session.title, deps.options.maxTitleChars),
              state: "idle",
              outcome: lastOutcome,
              lastMessageID: messages[messages.length - 1]?.id,
              pendingPermissions: [],
              pendingTotal: 0,
              pendingTruncated: false,
              textLength: 0,
              textTruncated: false,
              retry: retryOutput(liveRetry, deps.options.maxErrorChars),
            }),
          }
        }
        const startIndex =
          evaluation?.startIndex ?? Math.max(0, messages.findIndex((message) => message.id === user.id))
        const summary = summarizeTurn(
          messages,
          startIndex,
          false,
          evaluation?.endIndex,
          deps.options.maxTools,
          deps.options.maxTextChars,
        )
        const turn: TurnResult = {
          state: "idle",
          messages,
          startIndex,
          endIndex: evaluation?.endIndex,
          idle: evaluation?.idle,
          lastError: evaluation?.idle?.error?.message,
          elapsedMs: 0,
          fetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
          promptMessageID: targetMessageID ?? user.id,
          queued: false,
          retry: liveRetry,
        }
        return {
          content: formatSummary(header, summary, {
            lang,
            maxOutputChars: data.maxOutputChars,
            maxTextChars: deps.options.maxTextChars,
            maxTools: deps.options.maxTools,
            maxToolLine: deps.options.maxToolLine,
            maxPermissions: deps.options.maxPermissions,
          }),
          output: turnOutputValue(data.sessionID, session.title, turn, deps.options),
        }
      }

      const turn = await waitForTurn(deps.ctx, {
        sessionID: data.sessionID,
        anchorID: staleAnchor ? undefined : anchorID,
        promptText: targetMessageID || staleAnchor ? undefined : user?.text,
        admittedAt: targetMessageID || staleAnchor ? undefined : user?.time?.created,
        timeoutMs: remainingMs(),
        signal,
        initialMessages: contextFailed ? undefined : messages,
        initialFetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
        initialPermissions: pending,
        initialPermissionCheckAt: permissionCheckedAt,
        requireAnchor: !staleAnchor && Boolean(anchorID),
        promptMessageID: staleAnchor ? undefined : (targetMessageID ?? user?.id),
        ...(minimumAnchorCreatedAt !== undefined ? { minimumAnchorCreatedAt } : {}),
        ...waitConfig(deps, context, data.sessionID),
      })
      if (turn.state === "aborted") throw abortError(signal)
      throwIfAborted(signal)
      if (turn.state === "idle") {
        const completedID = turn.promptMessageID ?? targetMessageID
        removeQueuedPrompt(
          queuedPrompts,
          data.sessionID,
          completedID,
          queueOptions(deps.options),
        )
        if (completedID) deps.liveState?.markDelivered(data.sessionID, completedID)
        deps.liveState?.reconcile(data.sessionID, turn.messages)
      }
      const finalRetry = turn.retry ?? liveRetry
      if (!turn.retry && finalRetry) turn.retry = finalRetry
      let content = renderTurn(lang, header, turn, data.maxOutputChars, deps.options)
      if (finalRetry && turn.state !== "idle") {
        content = capOutput(
          `${content}\n${retryLabel(lang, finalRetry)}`,
          data.maxOutputChars,
          lang,
        )
      }
      if (
        turn.state !== "idle" &&
        !turn.pendingPermissions?.length &&
        !(
          turn.permissionCheckedAt &&
          Date.now() - turn.permissionCheckedAt < deps.options.permissionPollMs
        )
      ) {
        content = await appendPermissionHint(
          deps,
          context,
          lang,
          data.sessionID,
          content,
          data.maxOutputChars,
        )
      }
      return {
        content,
        output: turnOutputValue(data.sessionID, session.title, turn, deps.options, {
          ...(staleAnchor ? { anchorStale: true, waitingFor: "next-turn" } : {}),
        }),
      }
    },
    "couldNotWait",
    (error, input) => errorFor(deps, error, input, ["sessionID", "messageID"]),
  )

  add(
    {
      name: "compact",
      description:
        "Compact a session's context. Requires allowCompact: true. Optionally waits for the compaction turn. Use messageID/id for an exact anchor.",
      input: schema({
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "ID of the session to compact.",
          },
          id: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Optional idempotency key for the compaction message.",
          },
          delivery: {
            type: "string",
            enum: ["steer", "queue"],
            description: "steer (default) or queue behind the current turn.",
          },
          wait: {
            type: "boolean",
            description: "If true (default), wait for the compaction turn.",
          },
          timeoutMs: timeoutSchema,
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: turnOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseCompactInput(input, lang, deps.options)
      if (!deps.options.allowCompact) {
        throw new ValidationError(`${t(lang, "compactDisabled")} ${t(lang, "compactHint")}`)
      }
      if (
        !isOwnedSession(
          deps.ownedSessions,
          data.sessionID,
          callerOf(deps, context),
          Date.now(),
          { allowCrossDirectoryManagement: deps.options.allowCrossDirectoryManagement },
        ) &&
        !deps.options.allowUpdateForeignSessions
      ) {
        throw new ValidationError(
          `${t(lang, "foreignUpdateBlocked")} ${t(lang, "foreignUpdateHint")}`,
        )
      }
      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.compact",
        [data.sessionID, data.id ?? "new-compaction", data.delivery],
        {
          sessionID: data.sessionID,
          delivery: data.delivery,
          wait: data.wait,
          hasMessageID: Boolean(data.id),
        },
      )
      const signal = signalOf(context)
      const session = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
        deps.ctx.session.get({ sessionID: data.sessionID }, { signal: request }),
      )
      const result = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
        deps.ctx.session.compact(
          {
            sessionID: data.sessionID,
            id: data.id,
            delivery: data.delivery,
          },
          { signal: request },
        ),
      )
      const header = sessionHeader(lang, session)
      if (!data.wait) {
        if (data.delivery === "queue") {
          enqueueQueuedPrompt(
            queuedPrompts,
            data.sessionID,
            result.id,
            "queue",
            queueOptions(deps.options),
          )
        }
        return {
          content: `${header}\n\n${t(lang, "compacted")}\n${t(lang, "promptMessageID")}: ${oneLine(
            result.id,
            256,
          )}`,
          output: cleanOutput({
            sessionID: data.sessionID,
            title: boundTitle(session.title, deps.options.maxTitleChars),
            messageID: result.id,
            compactionID: result.id,
            state: data.delivery === "queue" ? "queued" : "running",
            queued: data.delivery === "queue",
            pendingPermissions: [],
            pendingTotal: 0,
            pendingTruncated: false,
            textLength: 0,
            textTruncated: false,
          }),
        }
      }

      const turn = await waitForTurn(deps.ctx, {
        sessionID: data.sessionID,
        anchorID: result.id,
        admittedAt: result.time?.created ?? Date.now(),
        timeoutMs: data.timeoutMs,
        signal,
        requireAnchor: true,
        promptMessageID: result.id,
        ...waitConfig(deps, context, data.sessionID),
      })
      if (turn.state === "aborted") throw abortError(signal)
      throwIfAborted(signal)
      if (turn.state === "idle") {
        removeQueuedPrompt(
          queuedPrompts,
          data.sessionID,
          result.id,
          queueOptions(deps.options),
        )
        deps.liveState?.markDelivered(data.sessionID, result.id)
        deps.liveState?.reconcile(data.sessionID, turn.messages)
      }
      return {
        content: renderTurn(lang, header, turn, data.maxOutputChars, deps.options),
        output: turnOutputValue(data.sessionID, session.title, turn, deps.options, {
          compactionID: result.id,
        }),
      }
    },
    "couldNotUpdate",
    (error, input) => errorFor(deps, error, input, ["sessionID", "id"]),
  )

  add(
    {
      name: "diagnostics",
      description:
        "Report plugin capabilities, registry/live/queue sizes, redacted option values, and the last live event time. Read-only.",
      input: schema({
        type: "object",
        properties: {
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: [],
        additionalProperties: false,
      }),
      output: diagnosticsOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, _context, lang) => {
      const data = parseDiagnosticsInput(input, lang, deps.options)
      const registry = deps.registry?.stats() ?? {
        owned: deps.ownedSessions.size,
        open: openSessions.size,
        dirtyOwned: false,
        dirtyOpen: false,
        flushPending: false,
      }
      const live = deps.liveState?.stats() ?? { sessions: 0, pending: 0 }
      let queueEntries = 0
      for (const entries of queuedPrompts.values()) queueEntries += entries.length
      const races = [...(deps.races ?? new Map()).values()]
        .filter((race) => {
          const projectID = deps.ctx.location?.project?.id
          return !race.projectID || !projectID || race.projectID === String(projectID)
        })
        .sort((left, right) => right.createdAt - left.createdAt)
      const worktrees = [...(deps.worktrees ?? new Map()).values()].filter((record) => {
        const projectID = deps.ctx.location?.project?.id
        return !record.projectID || !projectID || record.projectID === String(projectID)
      })
      const workers = [...(deps.workerSessions ?? getProcessWorkerSessions()).values()]
      const lastCleanupAt = races
        .map((race) => race.cleanup?.at)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => right - left)[0]
      const raceSummary = {
        count: races.length,
        running: races.filter((race) => race.status === "running").length,
        candidates: races.reduce((total, race) => total + race.candidates.length, 0),
        lastRaceID: races[0]?.raceID,
        lastCleanupAt,
      }
      const worktreeSummary = {
        tracked: worktrees.length,
        ready: worktrees.filter((record) => record.state === "ready").length,
        orphans: worktrees.filter((record) => record.state === "orphan").length,
      }
      const capabilities = {
        eventSubscribe: typeof deps.ctx.event?.subscribe === "function",
        sessionWait: typeof deps.ctx.session.wait === "function",
        sessionHook: typeof deps.ctx.session.hook === "function",
        sessionMove: typeof deps.ctx.session.move === "function",
        storage: Boolean(deps.ctx.storage),
        worktree: typeof deps.ctx.worktree?.create === "function",
        worktreeRemove: typeof deps.ctx.worktree?.remove === "function",
        vcsDiff: typeof deps.ctx.vcs?.diff === "function",
        vcsStatus: typeof deps.ctx.vcs?.status === "function",
      }
      const options = {
        maxOutputChars: deps.options.maxOutputChars,
        maxOutputTotalChars: deps.options.maxOutputTotalChars,
        maxTextChars: deps.options.maxTextChars,
        maxTools: deps.options.maxTools,
        maxPermissions: deps.options.maxPermissions,
        queueTtlMs: deps.options.queueTtlMs,
        livePendingTtlMs: deps.options.livePendingTtlMs,
        pollIntervalMs: deps.options.pollIntervalMs,
        maxPollIntervalMs: deps.options.maxPollIntervalMs,
        permissionPollMs: deps.options.permissionPollMs,
        requestTimeoutMs: deps.options.requestTimeoutMs,
        allowSessionRemoval: deps.options.allowSessionRemoval,
        allowRemoveForeignSessions: deps.options.allowRemoveForeignSessions,
        allowCompact: deps.options.allowCompact,
        allowWorkerOrchestration: deps.options.allowWorkerOrchestration,
        allowWorktreeManagement: deps.options.allowWorktreeManagement,
        allowTestCommands: deps.options.allowTestCommands,
        allowApplyCandidates: deps.options.allowApplyCandidates,
        allowPushCandidates: deps.options.allowPushCandidates,
        maxWorktrees: deps.options.maxWorktrees,
        maxRaceCandidates: deps.options.maxRaceCandidates,
        maxWaitSessions: deps.options.maxWaitSessions,
      }
      const lines = [
        `${t(lang, "session")}: session-bridge ${PLUGIN_VERSION}`,
        `${t(lang, "lastUpdate")}: ${formatTimestamp(live?.lastEventAt, lang)}`,
        `registry: owned=${registry?.owned ?? 0} open=${registry?.open ?? 0} dirty=${
          registry?.dirtyOwned || registry?.dirtyOpen ? "yes" : "no"
        } workers=${workers.length}`,
        `live: sessions=${live?.sessions ?? 0} pending=${live?.pending ?? 0}`,
        `queues: sessions=${queuedPrompts.size} entries=${queueEntries}`,
        `races: count=${raceSummary.count} running=${raceSummary.running} candidates=${
          raceSummary.candidates
        } last=${raceSummary.lastRaceID ?? "-"} cleanup=${formatTimestamp(
          raceSummary.lastCleanupAt,
          lang,
        )}`,
        `worktrees: tracked=${worktreeSummary.tracked} ready=${worktreeSummary.ready} orphans=${worktreeSummary.orphans}`,
        `capabilities: ${Object.entries(capabilities)
          .map(([key, value]) => `${key}=${value ? "yes" : "no"}`)
          .join(" ")}`,
      ]
      return {
        content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
        output: cleanOutput({
          version: PLUGIN_VERSION,
          capabilities,
          registry,
          live,
          queues: { sessions: queuedPrompts.size, entries: queueEntries },
          races: raceSummary,
          worktrees: worktreeSummary,
          workers: { count: workers.length },
          stream: {
            eventSubscribe: capabilities.eventSubscribe,
            lastEventAt: live?.lastEventAt,
          },
          storage: { available: capabilities.storage },
          options,
          state: "ok",
        }),
      }
    },
    "couldNotInspect",
    (error, input) => errorFor(deps, error, input, []),
  )

  add(
    {
      name: "interrupt",
      description: "Interrupt a session's running turn.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to interrupt." },
          resume: {
            type: "boolean",
            description: "If true, resume pending messages. Defaults to false.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: interruptOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseInterruptInput(input, lang, deps.options)
      if (
        !isOwnedSession(
          deps.ownedSessions,
          data.sessionID,
          callerOf(deps, context),
          Date.now(),
          { allowCrossDirectoryManagement: deps.options.allowCrossDirectoryManagement },
        ) &&
        !deps.options.allowInterruptForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignInterruptBlocked")} ${t(lang, "foreignInterruptHint")}`)
      }
      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.interrupt",
        [data.sessionID, String(data.resume)],
        { sessionID: data.sessionID, resume: data.resume },
      )
      const result = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.interrupt(
          { sessionID: data.sessionID, resume: data.resume },
          { signal },
        ),
      )
      const queueCleared = data.resume !== true
      if (queueCleared) {
        clearQueuedPrompts(queuedPrompts, data.sessionID)
        deps.liveState?.clearSession(data.sessionID)
      }
      const queuedCount = listQueuedPrompts(
        queuedPrompts,
        data.sessionID,
        queueOptions(deps.options),
      ).length
      return {
        content: t(lang, "sessionInterrupted", {
          id: oneLine(data.sessionID, 256),
          label: result?.interrupted ? t(lang, "interrupted") : t(lang, "noActiveTurn"),
        }),
        output: {
          sessionID: data.sessionID,
          interrupted: Boolean(result?.interrupted),
          queueCleared,
          queueResumed: queueCleared ? 0 : queuedCount,
          queuedCount,
          state: "ok",
        },
      }
    },
    "couldNotInterrupt",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )

  add(
    {
      name: "list",
      description:
        "List OpenCode sessions in the current directory with cursor pagination, filters, and a timestamp-based state snapshot. Use sessions.update to archive instead of deleting.",
      input: schema({
        type: "object",
        properties: {
          limit: listLimitSchema,
          search: { type: "string", maxLength: deps.options.maxSearchChars, description: "Text to filter by title." },
          directory: { type: "string", maxLength: deps.options.maxPathChars, description: "Directory whose sessions are listed. Defaults to the current one." },
          cursor: { type: "string", maxLength: deps.options.maxIdChars, description: "Cursor from a previous response." },
          order: { type: "string", enum: ["asc", "desc"], description: "Sort order." },
          archived: { type: "boolean", description: "List archived sessions instead of active ones." },
          parentID: { type: "string", maxLength: deps.options.maxIdChars, description: "Only list sessions with this parent ID." },
          subpath: { type: "string", maxLength: deps.options.maxPathChars, description: "Only list sessions for this subpath." },
          verbose: {
            type: "boolean",
            description: "Include agent, model, cost, and token details. Defaults to false.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: [],
        additionalProperties: false,
      }),
      output: listOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseListInput(input, lang, deps.options)
      let listDirectory: string | undefined = deps.ctx.location?.directory
      if (data.directory) {
        const validation = await (deps.validateDirectory ?? validateTargetDirectory)(
          data.directory,
          {
            projectDirectory: deps.ctx.location?.project?.directory,
            projectCanonical: deps.ctx.location?.project?.canonical,
            registeredDirectories: registeredWorktreeDirectories(deps),
            allowWorktreeDirectories: deps.options.allowWorktreeDirectories,
          },
        )
        if (!validation.ok) {
          throw new ValidationError(
            `${t(lang, "directoryInvalid", { reason: validation.error })} ${t(lang, "directoryOutsideProject")}`,
          )
        }
        listDirectory = validation.realDirectory
      }
      const page = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.list(
          {
            directory: listDirectory,
            limit: data.limit,
            search: data.search,
            cursor: data.cursor,
            order: data.order,
            archived: data.archived,
            parentID: data.parentID,
            subpath: data.subpath,
          },
          { signal },
        ),
      )
      const nextCursor = page.cursor?.next ?? undefined
      const shown = page.data.slice(0, data.limit)
      const entries = shown.map((session) => ({
        session,
        running: isRunning(session, []),
      }))
      const sessionsOutput = entries.map(({ session, running }) =>
        cleanOutput({
          id: session.id,
          title: boundTitle(session.title, deps.options.maxTitleChars),
          parentID: session.parentID,
          outcome: session.outcome,
          running,
          state: running ? "running" : "idle",
          updated: session.time?.updated,
          ...(data.verbose
            ? {
                agent: session.agent,
                model: modelLabel(session) || undefined,
                cost: session.cost,
                tokens: session.tokens,
              }
            : {}),
        }),
      )
      if (!shown.length) {
        return {
          content: t(lang, "noSessions"),
          output: cleanOutput({ sessions: [], nextCursor, count: 0, directory: listDirectory, state: "ok" }),
        }
      }

      const lines = entries.map(({ session, running }) => {
        const state = running ? t(lang, "running") : t(lang, "idle")
        const outcome = session.outcome ? ` (${oneLine(session.outcome, 120)})` : ""
        const parent = session.parentID
          ? ` | ${t(lang, "parent")}: ${oneLine(session.parentID, 256)}`
          : ""
        const title = truncateCodePoints(
          sanitizeTitle(session.title ?? t(lang, "noTitle")),
          deps.options.maxTitleChars,
        )
        const base = `- ${oneLine(session.id, 256)} | ${title} | ${state}${outcome} | ${formatTimestamp(
          session.time?.updated,
          lang,
        )}${parent}`
        if (!data.verbose) return base
        return `${base} | ${t(lang, "agent")}: ${oneLine(
          session.agent ?? t(lang, "unknown"),
          256,
        )} | ${t(lang, "model")}: ${oneLine(
          modelLabel(session) || t(lang, "unknown"),
          512,
        )} | ${t(lang, "cost")}: ${
          compact(session.cost, 100) || t(lang, "unknown")
        } | ${t(lang, "tokens")}: ${compact(session.tokens, 200) || t(lang, "unknown")}`
      })

      let content = `${t(lang, "sessions")}:\n${lines.join("\n")}\n\n${t(lang, "statusSnapshot")}`
      if (nextCursor) content += `\n${t(lang, "cursorNext")}: ${oneLine(nextCursor, 256)}`
      return {
        content: capOutput(content, data.maxOutputChars, lang),
        output: cleanOutput({
          sessions: sessionsOutput,
          nextCursor,
          count: sessionsOutput.length,
          directory: listDirectory,
          sessionsTruncated: page.data.length > shown.length,
          state: "ok",
        }),
      }
    },
    "couldNotList",
    (error, input) => errorFor(deps, error, input, ["cursor", "search"]),
  )

  add(
    {
      name: "language",
      description:
        "Get or set the output language of this plugin. Use es for Spanish or en for English. The setting persists across sessions.",
      input: schema({
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["es", "en"],
            description: "Output language: es (Spanish) or en (English). Omit to read the current setting.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: [],
        additionalProperties: false,
      }),
      output: languageOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, _context, lang) => {
      const data = parseLanguageInput(input, lang, deps.options)
      if (data.language) {
        await deps.setLanguage(data.language)
        return {
          content: data.language === "es" ? t("es", "languageSetEs") : t("en", "languageSetEn"),
          output: { language: data.language, changed: true, state: "ok" },
        }
      }
      return {
        content: lang === "es" ? t("es", "languageCurrentEs") : t("en", "languageCurrentEn"),
        output: { language: lang, changed: false, state: "ok" },
      }
    },
    undefined,
    (error, input) => errorFor(deps, error, input, ["language"]),
  )

  add(
    {
      name: "update",
      description:
        "Update an existing session without deleting it: rename, archive/unarchive, change metadata, or adjust permission rules. allow rules require allowPermissionRules.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to update." },
          title: { type: "string", maxLength: deps.options.maxTitleChars, description: "New session title." },
          archived: { type: "boolean", description: "Archive or unarchive the session." },
          metadata: { type: "object", description: "Session metadata object." },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            description: "New permission rules. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchemaFor(deps),
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: updateOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseUpdateInput(input, lang, deps.options)
      if (
        data.title === undefined &&
        data.archived === undefined &&
        data.metadata === undefined &&
        data.permissions === undefined
      ) {
        throw new ValidationError(t(lang, "noChanges"))
      }
      if (
        !isOwnedSession(
          deps.ownedSessions,
          data.sessionID,
          callerOf(deps, context),
          Date.now(),
          { allowCrossDirectoryManagement: deps.options.allowCrossDirectoryManagement },
        ) &&
        !deps.options.allowUpdateForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignUpdateBlocked")} ${t(lang, "foreignUpdateHint")}`)
      }
      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.update",
        [data.sessionID],
        {
          sessionID: data.sessionID,
          titleChanged: data.title !== undefined,
          archivedChanged: data.archived !== undefined,
          metadataChanged: data.metadata !== undefined,
          permissionsChanged: data.permissions !== undefined,
        },
      )
      type UpdateInput = Parameters<PluginContext["session"]["update"]>[0]
      const cleanTitle = data.title !== undefined ? sanitizeTitle(data.title) : undefined
      const update: UpdateInput = {
        sessionID: data.sessionID,
        title: cleanTitle,
        archived: data.archived,
        metadata: data.metadata as UpdateInput["metadata"],
        permissions: data.permissions,
      }
      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.update(update, { signal }),
      )

      const lines = [`${t(lang, "updated")}: ${oneLine(data.sessionID, 256)}`]
      if (data.title !== undefined) {
        lines.push(`${t(lang, "title")}: ${boundTitle(data.title, deps.options.maxTitleChars)}`)
      }
      if (data.archived !== undefined) {
        lines.push(
          `${t(lang, "archived")}: ${data.archived ? t(lang, "yes") : t(lang, "no")}`,
        )
      }
      if (data.permissions !== undefined) {
        lines.push(`${t(lang, "permissionRules")}: ${data.permissions.length}`)
      }
      return {
        content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
        output: cleanOutput({
          sessionID: data.sessionID,
          updated: true,
          title: boundTitle(data.title, deps.options.maxTitleChars),
          archived: data.archived,
          metadataChanged: data.metadata !== undefined,
          permissionsChanged: data.permissions !== undefined,
          state: "ok",
        }),
      }
    },
    "couldNotUpdate",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )

  add(
    {
      name: "remove",
      description:
        "Delete a session. Destructive: it stops execution. Requires confirm: true and allowSessionRemoval: true. Prefer sessions.update with archived: true.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: deps.options.maxIdChars, description: "ID of the session to delete." },
          confirm: {
            type: "boolean",
            description: "Must be true. Confirms the destructive deletion.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      output: removeOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseRemoveInput(input, lang, deps.options)
      if (!deps.options.allowSessionRemoval) {
        throw new ValidationError(`${t(lang, "removeDisabled")} ${t(lang, "removeHint")}`)
      }
      if (!data.confirm) throw new ValidationError(t(lang, "confirmRequired"))
      if (
        !isOwnedSession(
          deps.ownedSessions,
          data.sessionID,
          callerOf(deps, context),
          Date.now(),
          { allowCrossDirectoryManagement: deps.options.allowCrossDirectoryManagement },
        ) &&
        !deps.options.allowRemoveForeignSessions
      ) {
        throw new ValidationError(
          `${t(lang, "removeForeignBlocked")} ${t(lang, "removeForeignHint")}`,
        )
      }
      await assertPermission(
        deps.ctx,
        context,
        "session_bridge.remove",
        [data.sessionID],
        { sessionID: data.sessionID },
      )
      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.remove({ sessionID: data.sessionID }, { signal }),
      )
      if (deps.registry) {
        deps.registry.forgetOwned(data.sessionID)
        deps.registry.forgetOpenBySessionID(data.sessionID)
        await deps.registry.flush()
      } else {
        await forgetOwnedSession(deps.ctx, deps.ownedSessions, data.sessionID)
        await forgetOpenSessionsBySessionID(deps.ctx, openSessions, data.sessionID)
      }
      clearQueuedPrompts(queuedPrompts, data.sessionID)
      deps.liveState?.clearSession(data.sessionID)
      await forgetWorkerSession(
        deps.ctx,
        deps.workerSessions ?? getProcessWorkerSessions(),
        data.sessionID,
      )
      return {
        content: `${t(lang, "removed")}: ${oneLine(data.sessionID, 256)}`,
        output: { sessionID: data.sessionID, removed: true, state: "ok" },
      }
    },
    "couldNotRemove",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )

  add(
    {
      name: "worktrees",
      description:
        "Create, list, and remove project worktrees through ctx.worktree. Creation and removal are opt-in (allowWorktreeManagement), and removal requires confirm: true. Only worktrees created by this plugin are removed; dirty or active worktrees are preserved unless force: true.",
      input: schema({
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "remove"],
            description: "create, list, or remove. Defaults to list.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: deps.options.maxWorktrees,
            description: "Number of worktrees to create.",
          },
          base: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Starting git ref/SHA. Defaults to HEAD.",
          },
          namePrefix: {
            type: "string",
            maxLength: 64,
            description: "Prefix for generated worktree names. Defaults to sb.",
          },
          branch: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Optional starting branch/ref passed to ctx.worktree.create.",
          },
          runID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Optional run ID used to group and clean up worktrees.",
          },
          directories: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxPathChars },
            maxItems: Math.max(deps.options.maxWorktrees, 32),
            description: "Directories to remove. Only tracked worktrees are eligible.",
          },
          force: {
            type: "boolean",
            description: "Remove dirty worktrees or worktrees with active sessions. Defaults to false.",
          },
          confirm: {
            type: "boolean",
            description: "Must be true for remove.",
          },
          archiveSessions: {
            type: "boolean",
            description: "Archive associated sessions before removing a worktree. Defaults to true.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: [],
        additionalProperties: false,
      }),
      output: worktreesOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseWorktreesInput(input, lang, deps.options)
      const signal = signalOf(context)
      const orchestration = orchestrationDeps(deps)
      if (data.action === "list") {
        const worktrees = await listWorktrees(
          {
            ctx: deps.ctx,
            options: deps.options,
            worktrees: orchestration.worktrees,
            git: orchestration.git,
            liveState: deps.liveState,
          },
          signal,
        )
        const lines = worktrees.length
          ? worktrees.map(
              (worktree) =>
                `- ${oneLine(worktree.directory, deps.options.maxPathChars)} | ${
                  worktree.branch ?? t(lang, "unknown")
                } | ${worktree.strategy} | ${worktree.dirty ? "dirty" : "clean"}${
                  worktree.missing ? " | missing" : ""
                }`,
            )
          : [t(lang, "noWorktrees")]
        return {
          content: capOutput(
            `${t(lang, "worktreesListed")} (${worktrees.length}):\n${lines.join("\n")}`,
            data.maxOutputChars,
            lang,
          ),
          output: cleanOutput({
            action: data.action,
            worktrees,
            removed: [],
            orphans: [],
            state: "ok",
          }),
        }
      }

      if (!deps.options.allowWorktreeManagement) {
        throw new ValidationError(`${t(lang, "worktreesDisabled")} ${t(lang, "worktreesHint")}`)
      }
      await assertPermission(deps.ctx, context, "session_bridge.worktrees", [
        data.action,
        data.runID ?? "",
        ...(data.directories ?? []),
      ], {
        action: data.action,
        count: data.count,
        ...(data.base ? { base: data.base } : {}),
      })

      if (data.action === "create") {
        const created = await createWorktrees(
          {
            ctx: deps.ctx,
            options: deps.options,
            worktrees: orchestration.worktrees,
            git: orchestration.git,
            liveState: deps.liveState,
          },
          {
            count: data.count,
            base: data.base,
            namePrefix: data.namePrefix,
            branch: data.branch,
          },
          {
            runID: data.runID ?? createRaceID(),
            ownerSessionID: context.sessionID,
            ownerDirectory: deps.ctx.location?.directory,
          },
          signal,
        )
        return {
          content: capOutput(
            `${t(lang, "worktreesCreated")} (${created.length}):\n${created
              .map(
                (worktree) =>
                  `- ${oneLine(worktree.directory, deps.options.maxPathChars)} | ${
                    worktree.branch ?? t(lang, "unknown")
                  } | ${worktree.strategy} | ${worktree.runID}`,
              )
              .join("\n")}`,
            data.maxOutputChars,
            lang,
          ),
          output: cleanOutput({
            action: data.action,
            worktrees: created,
            removed: [],
            orphans: [],
            state: "ok",
          }),
        }
      }

      if (!data.confirm) throw new ValidationError(t(lang, "invalidConfirm"))
      if (!data.directories?.length) throw new ValidationError(t(lang, "invalidDirectories"))
      const removed = await removeWorktrees(
        {
          ctx: deps.ctx,
          options: deps.options,
          worktrees: orchestration.worktrees,
          git: orchestration.git,
          liveState: deps.liveState,
        },
        data.directories,
        { force: data.force, archiveSessions: data.archiveSessions },
        signal,
      )
      const orphans = removed
        .filter((entry) => entry.orphan)
        .map((entry) => entry.directory)
      const kept = removed
        .filter((entry) => !entry.removed && !entry.orphan)
        .map((entry) => entry.directory)
      return {
        content: capOutput(
          `${t(lang, "worktreesRemoved")} (${removed.filter((entry) => entry.removed).length}/${
            removed.length
          }):\n${removed
            .map(
              (entry) =>
                `- ${oneLine(entry.directory, deps.options.maxPathChars)} | ${
                  entry.removed ? "removed" : "kept"
                }${entry.reason ? ` | ${oneLine(entry.reason, 200)}` : ""}`,
            )
            .join("\n")}`,
          data.maxOutputChars,
          lang,
        ),
        output: cleanOutput({
          action: data.action,
          worktrees: [],
          removed,
          orphans,
          kept,
          state: "ok",
        }),
      }
    },
    "couldNotWorktrees",
    (error, input) => errorFor(deps, error, input, []),
  )

  const waitManyHandler = async (
    input: unknown,
    context: ToolExecuteContext,
    lang: Lang,
    modeOverride?: "any" | "all",
  ) => {
    const data = parseWaitManyInput(input, lang, deps.options)
    if (modeOverride) data.mode = modeOverride
    await assertPermission(deps.ctx, context, "session_bridge.waitAny", [
      ...data.sessionIDs,
      data.mode,
    ], { mode: data.mode, timeoutMs: data.timeoutMs })
    const result = await waitMany(orchestrationDeps(deps), context, {
      sessionIDs: data.sessionIDs,
      messageIDs: data.messageIDs,
      timeoutMs: data.timeoutMs,
      perSessionTimeoutMs: data.perSessionTimeoutMs,
      mode: data.mode,
      returnOnPermission: data.returnOnPermission,
    })
    const lines = [
      `${t(lang, "waitingSessions")} (${data.mode}) · ${result.elapsedMs}ms`,
      ...result.results.map(
        (entry) =>
          `- ${oneLine(entry.sessionID, 256)} | ${entry.state} | ${entry.elapsedMs}ms${
            entry.messageID ? ` | ${oneLine(entry.messageID, 256)}` : ""
          }${entry.outcome ? ` | ${oneLine(entry.outcome, 120)}` : ""}${
            entry.error ? ` | ${oneLine(entry.error, 300)}` : ""
          }`,
      ),
    ]
    if (result.pending.length) lines.push(`pending: ${result.pending.join(", ")}`)
    return {
      content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
      output: cleanOutput({
        mode: result.mode,
        sessions: result.results,
        pending: result.pending,
        elapsedMs: result.elapsedMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        state:
          result.state === "ok"
            ? "ok"
            : result.state === "permission"
              ? "permission"
              : result.state === "running"
                ? "running"
                : result.state === "timeout"
                  ? "timeout"
                  : "aborted",
      }),
    }
  }

  add(
    {
      name: "waitAny",
      description:
        "Wait for one or all background sessions. mode any returns the first session that finishes or needs permission; mode all returns every result, including partial results on timeout or abort. A pending permission is returned immediately so the orchestrator can reply and wait again.",
      input: schema({
        type: "object",
        properties: {
          sessionIDs: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxIdChars },
            minItems: 1,
            maxItems: deps.options.maxWaitSessions,
            description: "Session IDs to wait for.",
          },
          messageIDs: {
            type: "object",
            additionalProperties: { type: "string", maxLength: deps.options.maxIdChars },
            description: "Optional map from session ID to the exact prompt message ID.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 3_600_000,
            description: "Global timeout in milliseconds. Defaults to 120000.",
          },
          perSessionTimeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 600_000,
            description: "Optional timeout per session.",
          },
          mode: {
            type: "string",
            enum: ["any", "all"],
            description: "any (default) or all.",
          },
          returnOnPermission: {
            type: "boolean",
            description: "In all mode, return early when a permission is pending. Defaults to true.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionIDs"],
        additionalProperties: false,
      }),
      output: waitManyOutput,
      options: { namespace: "sessions", codemode: true },
    },
    (input, context, lang) => waitManyHandler(input, context, lang),
    "couldNotWaitAny",
    (error, input) => errorFor(deps, error, input, []),
  )

  add(
    {
      name: "waitAll",
      description:
        "Wait for all listed sessions. Alias of sessions.waitAny with mode: all; returns partial results on timeout or abort and never loses sessions that already finished.",
      input: schema({
        type: "object",
        properties: {
          sessionIDs: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxIdChars },
            minItems: 1,
            maxItems: deps.options.maxWaitSessions,
            description: "Session IDs to wait for.",
          },
          messageIDs: {
            type: "object",
            additionalProperties: { type: "string", maxLength: deps.options.maxIdChars },
            description: "Optional map from session ID to the exact prompt message ID.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 3_600_000,
            description: "Global timeout in milliseconds. Defaults to 120000.",
          },
          perSessionTimeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 600_000,
            description: "Optional timeout per session.",
          },
          returnOnPermission: {
            type: "boolean",
            description: "Return early when a permission is pending. Defaults to true.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["sessionIDs"],
        additionalProperties: false,
      }),
      output: waitManyOutput,
      options: { namespace: "sessions", codemode: true },
    },
    (input, context, lang) => waitManyHandler(input, context, lang, "all"),
    "couldNotWaitAny",
    (error, input) => errorFor(deps, error, input, []),
  )

  const raceHandler = async (
    input: unknown,
    context: ToolExecuteContext,
    lang: Lang,
    bestOf: boolean,
  ) => {
    const data = parseRaceInput(input, lang, deps.options)
    await assertPermission(deps.ctx, context, bestOf ? "session_bridge.bestOf" : "session_bridge.race", [
      data.mode,
      String(data.count),
      data.base ?? "HEAD",
    ], {
      mode: data.mode,
      count: data.count,
      testCommand: Boolean(data.testCommand),
      keepWorktrees: data.keepWorktrees,
    })
    const result = await runRace(orchestrationDeps(deps), context, data, signalOf(context))
    const ranking = bestOf || data.testCommand ? result.ranking : undefined
    const output = shapeRace(result.race, deps.options, ranking)
    const candidates = result.race.candidates
    const lines = [
      `${t(lang, "raceStatusLabel")}: ${result.race.status} · ${result.race.raceID}`,
      `${t(lang, "raceCandidates")}: ${candidates.length} · base: ${oneLine(
        result.race.base ?? "HEAD",
        64,
      )}`,
      ...candidates.map((candidate) => {
        const tests = candidate.tests
          ? candidate.tests.skipped
            ? t(lang, "testsSkipped")
            : candidate.tests.passed
              ? t(lang, "testsPassed")
              : t(lang, "testsFailed")
          : t(lang, "verificationUnknown")
        return `- ${candidate.candidateID} | ${oneLine(candidate.sessionID ?? "-", 256)} | ${
          candidate.state
        } | +${candidate.diffStats.additions}/-${candidate.diffStats.deletions} | ${tests} | ${
          candidate.verification
        }${candidate.error ? ` | ${oneLine(candidate.error, 300)}` : ""}`
      }),
    ]
    if (ranking?.recommended) {
      lines.push(
        `${t(lang, "raceRecommended")}: ${ranking.recommended} (${ranking.rankingReasons.join(", ")})`,
      )
    } else if (bestOf) {
      lines.push(t(lang, "raceNoRecommendation"))
    }
    return {
      content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
      output: cleanOutput({
        ...output,
        state: "ok",
      }),
    }
  }

  add(
    {
      name: "race",
      description:
        "Run the same prompt in N candidate sessions (worktrees by default), wait for them, snapshot commits/patches, optionally run tests serially, and return candidates with diffs and verification. Never applies changes. Worktrees are kept by default.",
      input: schema({
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Prompt sent to every candidate." },
          count: {
            type: "integer",
            minimum: 2,
            maximum: deps.options.maxRaceCandidates,
            description: "Number of candidates. Defaults to 3.",
          },
          mode: {
            type: "string",
            enum: ["worktrees", "same-directory"],
            description: "worktrees (default) or same-directory (review only).",
          },
          base: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Starting git ref/SHA. Defaults to HEAD.",
          },
          models: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxModelChars },
            maxItems: deps.options.maxRaceCandidates,
            description: "Optional model per candidate, in provider/model format.",
          },
          agents: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxAgentChars },
            maxItems: deps.options.maxRaceCandidates,
            description: "Optional agent per candidate.",
          },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            items: permissionRuleSchemaFor(deps),
            description: "Additional deny rules for worker sessions.",
          },
          testCommand: {
            type: "string",
            maxLength: 8_192,
            description: "Optional test command. Requires allowTestCommands: true; runs without a shell.",
          },
          setupCommand: {
            type: "string",
            maxLength: 8_192,
            description: "Optional setup command run before tests.",
          },
          teardownCommand: {
            type: "string",
            maxLength: 8_192,
            description: "Optional teardown command run after tests.",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string", maxLength: 4_096 },
            description: "Optional test environment variables (allowlisted; secret-like keys are skipped).",
          },
          cwd: {
            type: "string",
            maxLength: deps.options.maxPathChars,
            description: "Optional working directory relative to each candidate worktree.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: 3_600_000,
            description: "Wall-clock timeout for the race.",
          },
          testTimeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: 600_000,
            description: "Timeout for each test command.",
          },
          keepWorktrees: {
            type: "boolean",
            description: "Keep candidate worktrees after the snapshot. Defaults to true.",
          },
          snapshot: {
            type: "string",
            enum: ["auto", "commit", "patch"],
            description: "Snapshot strategy. auto commits when safe, otherwise captures a patch.",
          },
          maxDiffBytes: {
            type: "integer",
            minimum: 1_000,
            maximum: deps.options.maxDiffBytes,
            description: "Maximum displayed diff bytes per candidate.",
          },
          maxTestOutputChars: {
            type: "integer",
            minimum: 100,
            maximum: deps.options.maxTestOutputChars,
            description: "Maximum stdout/stderr characters per test command.",
          },
          runID: {
            type: "string",
            maxLength: deps.options.maxIdChars,
            description: "Optional run ID; the default is generated.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["prompt"],
        additionalProperties: false,
      }),
      output: raceOutput,
      options: { namespace: "sessions", codemode: true },
    },
    (input, context, lang) => raceHandler(input, context, lang, false),
    "couldNotRace",
    (error, input) => errorFor(deps, error, input, ["runID"]),
  )

  add(
    {
      name: "bestOf",
      description:
        "Run the same race as sessions.race and return a heuristic recommended candidate plus rankingReasons. Tests passed first, then smaller diff, then faster. No candidate is applied automatically.",
      input: schema({
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Prompt sent to every candidate." },
          count: {
            type: "integer",
            minimum: 2,
            maximum: deps.options.maxRaceCandidates,
            description: "Number of candidates. Defaults to 3.",
          },
          mode: {
            type: "string",
            enum: ["worktrees", "same-directory"],
            description: "worktrees (default) or same-directory (review only).",
          },
          base: { type: "string", maxLength: deps.options.maxIdChars, description: "Starting git ref/SHA." },
          models: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxModelChars },
            maxItems: deps.options.maxRaceCandidates,
          },
          agents: {
            type: "array",
            items: { type: "string", maxLength: deps.options.maxAgentChars },
            maxItems: deps.options.maxRaceCandidates,
          },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            items: permissionRuleSchemaFor(deps),
          },
          testCommand: { type: "string", maxLength: 8_192 },
          setupCommand: { type: "string", maxLength: 8_192 },
          teardownCommand: { type: "string", maxLength: 8_192 },
          env: { type: "object", additionalProperties: { type: "string", maxLength: 4_096 } },
          cwd: { type: "string", maxLength: deps.options.maxPathChars },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 3_600_000 },
          testTimeoutMs: { type: "integer", minimum: 1_000, maximum: 600_000 },
          keepWorktrees: { type: "boolean" },
          snapshot: { type: "string", enum: ["auto", "commit", "patch"] },
          maxDiffBytes: {
            type: "integer",
            minimum: 1_000,
            maximum: deps.options.maxDiffBytes,
          },
          maxTestOutputChars: {
            type: "integer",
            minimum: 100,
            maximum: deps.options.maxTestOutputChars,
          },
          runID: { type: "string", maxLength: deps.options.maxIdChars },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["prompt"],
        additionalProperties: false,
      }),
      output: raceOutput,
      options: { namespace: "sessions", codemode: true },
    },
    (input, context, lang) => raceHandler(input, context, lang, true),
    "couldNotRace",
    (error, input) => errorFor(deps, error, input, ["runID"]),
  )

  add(
    {
      name: "applyCandidate",
      description:
        "Apply a candidate from a registered race. Requires allowApplyCandidates: true and confirm: true. Dry-run is the default. Prefer an integration worktree plus verifyCommand; a failed verification leaves the target untouched. Commit and push are separate opt-ins.",
      input: schema({
        type: "object",
        properties: {
          raceID: { type: "string", maxLength: deps.options.maxIdChars, description: "Race ID." },
          candidateID: { type: "string", maxLength: deps.options.maxIdChars, description: "Candidate ID." },
          targetDirectory: {
            type: "string",
            maxLength: deps.options.maxPathChars,
            description: "Target directory. Defaults to the race target.",
          },
          strategy: {
            type: "string",
            enum: ["apply", "cherry-pick"],
            description: "apply (patch) or cherry-pick (requires a candidate commit). Defaults to apply.",
          },
          verifyCommand: {
            type: "string",
            maxLength: 8_192,
            description: "Optional command run in the integration worktree before touching the target.",
          },
          dryRun: {
            type: "boolean",
            description: "If true (default), verify in an integration worktree without modifying the target.",
          },
          commit: {
            type: "boolean",
            description: "Create a commit in the target after applying. Defaults to false.",
          },
          commitMessage: {
            type: "string",
            maxLength: deps.options.maxTitleChars,
            description: "Commit message when commit: true.",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to apply.",
          },
          push: {
            type: "boolean",
            description: "Push after a successful commit. Requires allowPushCandidates: true. No force push.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["raceID", "candidateID", "confirm"],
        additionalProperties: false,
      }),
      output: applyOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseApplyInput(input, lang, deps.options)
      if (!deps.options.allowApplyCandidates) {
        throw new ValidationError(`${t(lang, "applyDisabled")} ${t(lang, "applyHint")}`)
      }
      if (!data.confirm) throw new ValidationError(t(lang, "applyConfirm"))
      const result = await applyCandidate(
        orchestrationDeps(deps),
        context,
        {
          raceID: data.raceID,
          candidateID: data.candidateID,
          targetDirectory: data.targetDirectory,
          strategy: data.strategy,
          verifyCommand: data.verifyCommand,
          dryRun: data.dryRun,
          commit: data.commit,
          commitMessage: data.commitMessage,
          confirm: data.confirm,
          push: data.push,
        },
        signalOf(context),
      )
      const lines = [
        `${t(lang, "applyCandidate")}: ${data.raceID}/${data.candidateID}`,
        `${t(lang, "state")}: ${result.state}`,
        `${t(lang, "strategy")}: ${result.strategy}`,
        `${t(lang, "directory")}: ${oneLine(result.targetDirectory, deps.options.maxPathChars)}`,
        `${t(lang, "applyApplied")}: ${result.applied ? "yes" : "no"} | ${
          t(lang, "applyAlready")
        }: ${result.alreadyApplied ? "yes" : "no"}`,
      ]
      if (result.dryRun) lines.push(t(lang, "applyDryRun"))
      if (result.integrationDirectory) {
        lines.push(
          `${t(lang, "applyIntegration")}: ${oneLine(
            result.integrationDirectory,
            deps.options.maxPathChars,
          )}`,
        )
      }
      if (result.backup) lines.push(`${t(lang, "applyBackup")}: ${oneLine(result.backup, 256)}`)
      if (result.verification) {
        lines.push(
          `${t(lang, "applyVerification")}: ${
            result.verification.skipped
              ? t(lang, "testsSkipped")
              : result.verification.passed
                ? t(lang, "testsPassed")
                : t(lang, "testsFailed")
          }${result.verification.reason ? ` | ${oneLine(result.verification.reason, 300)}` : ""}`,
        )
      }
      if (result.pushError) {
        lines.push(`${t(lang, "applyPushFailed")}: ${oneLine(result.pushError, 500)}`)
      } else if (result.pushed !== undefined) {
        lines.push(`${t(lang, "applyPush")}: ${result.pushed ? t(lang, "applyPushed") : "no"}`)
      }
      if (result.reason) lines.push(`${t(lang, "result")}: ${oneLine(result.reason, 500)}`)
      return {
        content: capOutput(lines.join("\n"), data.maxOutputChars, lang),
        output: cleanOutput({
          raceID: data.raceID,
          candidateID: data.candidateID,
          ...result,
        }),
      }
    },
    "couldNotApply",
    (error, input) => errorFor(deps, error, input, ["raceID", "candidateID"]),
  )

  add(
    {
      name: "raceStatus",
      description:
        "Show one race or all registered races, including candidates, commits/patches, tests, verification, worktrees, and cleanup state. Read-only.",
      input: schema({
        type: "object",
        properties: {
          raceID: { type: "string", maxLength: deps.options.maxIdChars, description: "Optional race ID." },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: [],
        additionalProperties: false,
      }),
      output: raceStatusOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, _context, lang) => {
      const data = parseRaceStatusInput(input, lang, deps.options)
      const orchestration = orchestrationDeps(deps)
      if (data.raceID) {
        const race = raceStatus(orchestration, data.raceID) as import("./races.ts").RaceRecord
        const output = shapeRace(race, deps.options, rankCandidates(race.candidates))
        return {
          content: capOutput(
            `${t(lang, "raceStatusLabel")}: ${race.status} · ${race.raceID}\n${t(
              lang,
              "raceCandidates",
            )}: ${race.candidates.length}\n${t(lang, "directory")}: ${oneLine(
              race.targetDirectory,
              deps.options.maxPathChars,
            )}`,
            data.maxOutputChars,
            lang,
          ),
          output: cleanOutput({ race: output, state: "ok" }),
        }
      }
      const races = raceList(orchestration)
      return {
        content: capOutput(
          races.length
            ? races
                .map(
                  (race) =>
                    `- ${race.raceID} | ${race.status} | ${race.mode} | candidates=${
                      race.candidates
                    } | worktrees=${race.worktrees}`,
                )
                .join("\n")
            : t(lang, "raceNotFound"),
          data.maxOutputChars,
          lang,
        ),
        output: cleanOutput({ races, state: "ok" }),
      }
    },
    "couldNotRaceStatus",
    (error, input) => errorFor(deps, error, input, ["raceID"]),
  )

  add(
    {
      name: "raceList",
      description: "List registered races with status, candidate counts, worktrees, and cleanup state. Read-only.",
      input: schema({
        type: "object",
        properties: { maxOutputChars: maxOutputSchemaFor(deps) },
        required: [],
        additionalProperties: false,
      }),
      output: raceStatusOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, _context, lang) => {
      const data = parseRaceStatusInput(input, lang, deps.options)
      const races = raceList(orchestrationDeps(deps))
      return {
        content: capOutput(
          races.length
            ? races.map((race) => `- ${race.raceID} | ${race.status} | ${race.mode}`).join("\n")
            : t(lang, "raceNotFound"),
          data.maxOutputChars,
          lang,
        ),
        output: cleanOutput({ races, state: "ok" }),
      }
    },
    "couldNotRaceStatus",
    (error, input) => errorFor(deps, error, input, []),
  )

  add(
    {
      name: "raceCleanup",
      description:
        "Remove the worktrees created by a race. Requires allowWorktreeManagement: true and confirm: true. Dirty worktrees need force: true. Branches are kept.",
      input: schema({
        type: "object",
        properties: {
          raceID: { type: "string", maxLength: deps.options.maxIdChars, description: "Race ID to clean up." },
          confirm: { type: "boolean", description: "Must be true." },
          force: { type: "boolean", description: "Remove dirty worktrees. Defaults to false." },
          archiveSessions: {
            type: "boolean",
            description: "Archive associated sessions before removing worktrees. Defaults to true.",
          },
          maxOutputChars: maxOutputSchemaFor(deps),
        },
        required: ["raceID", "confirm"],
        additionalProperties: false,
      }),
      output: raceCleanupOutput,
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseRaceCleanupInput(input, lang, deps.options)
      if (!deps.options.allowWorktreeManagement) {
        throw new ValidationError(`${t(lang, "cleanupDisabled")} ${t(lang, "cleanupHint")}`)
      }
      await assertPermission(deps.ctx, context, "session_bridge.raceCleanup", [
        data.raceID,
        String(data.force),
      ], { raceID: data.raceID, force: data.force })
      const result = await raceCleanup(
        orchestrationDeps(deps),
        context,
        {
          raceID: data.raceID,
          confirm: data.confirm,
          force: data.force,
          archiveSessions: data.archiveSessions,
        },
        signalOf(context),
      )
      return {
        content: capOutput(
          `${t(lang, "worktreesRemoved")}: ${result.cleanup.removed.length} | ${
            t(lang, "error")
          }: ${result.cleanup.orphans.length}`,
          data.maxOutputChars,
          lang,
        ),
        output: cleanOutput({
          raceID: data.raceID,
          removed: result.cleanup.removed,
          orphans: result.cleanup.orphans,
          kept: result.cleanup.kept,
          state: "ok",
        }),
      }
    },
    "couldNotCleanup",
    (error, input) => errorFor(deps, error, input, ["raceID"]),
  )
}
