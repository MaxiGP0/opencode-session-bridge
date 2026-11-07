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
  parseModel,
  permissionLine,
  renderTranscriptDetailed,
  sanitizeTitle,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
  truncateCodePoints,
} from "./format.ts"
import { type LiveState, type LiveSnapshot } from "./live.ts"
import type { BridgeOptions } from "./options.ts"
import {
  boundError,
  boundPendingPermissions,
  boundTitle,
  boundedPermissionLine,
  cleanOutput,
  errorOutput,
  outputBudget,
  stringField,
  type OutputBudget,
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
  forgetOpenSessionsBySessionID,
  forgetOwnedSession,
  isOwnedSession,
  lookupOpenSession,
  rememberOpenSession,
  rememberOwnedSession,
  type OpenSessionMapping,
  type OwnedSessions,
} from "./registry.ts"
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
  parseInterruptInput,
  parseLanguageInput,
  parseListInput,
  parseOpenInput,
  parsePermissionsInput,
  parseReadInput,
  parseRemoveInput,
  parseReplyInput,
  parseSendInput,
  parseStatusInput,
  parseUpdateInput,
  parseWaitInput,
  ValidationError,
} from "./validation.ts"
import { evaluateTurn, requestSignal, waitForTurn } from "./wait.ts"

export type ToolDeps = {
  ctx: PluginContext
  options: BridgeOptions
  getLanguage: () => Lang
  setLanguage: (lang: Lang) => Promise<void>
  ownedSessions: OwnedSessions
  openSessions?: OpenSessionMapping
  queuedPrompts?: QueuedPrompts
  liveState?: LiveState
  inFlightOpens?: Map<string, Promise<ToolExecutionResult>>
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
 * Marker used to let host permission denials escape the tool wrapper. A denied
 * `ctx.permission.assert` must surface as a Tool.Error, never as normal content.
 */
class PermissionDenied extends Error {
  constructor(readonly cause: unknown) {
    super("Permission denied by the host")
    this.name = "PermissionDenied"
  }
}

/**
 * JSON Schema objects are validated by OpenCode before `execute` runs. The
 * cast is only at the registration boundary; tool bodies receive `unknown`
 * and validate every field at runtime.
 */
const schema = (value: Record<string, unknown>): ToolDefinition["input"] =>
  value as ToolDefinition["input"]

const outputSchema = (value: Record<string, unknown>): ToolDefinition["output"] =>
  value as ToolDefinition["output"]

const permissionRuleSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "Action to match, for example edit, shell, or webfetch." },
    resource: { type: "string", description: "Resource or glob pattern to match." },
    effect: {
      type: "string",
      enum: ["allow", "deny", "ask"],
      description: "Whether to allow, deny, or ask for matching actions.",
    },
  },
  required: ["action", "resource", "effect"],
  additionalProperties: false,
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
    next: { type: "number" },
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

function signalOf(context: ToolExecuteContext): AbortSignal {
  return context.signal ?? new AbortController().signal
}

/**
 * Evaluates the host's permission rules before a dangerous action. The marker
 * error is rethrown by the wrapper so `deny` and rejected `ask` responses are
 * visible to the caller instead of becoming a successful report.
 */
async function assertPermission(
  deps: ToolDeps,
  context: ToolExecuteContext,
  action: string,
  resources: string[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (typeof deps.ctx.permission.assert !== "function") return
  const source =
    context.messageID && context.id
      ? { type: "tool" as const, messageID: context.messageID, id: context.id }
      : undefined
  try {
    await deps.ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      action,
      resources,
      metadata,
      source,
    })
  } catch (error) {
    throw new PermissionDenied(error)
  }
}

async function withRequest<T>(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = requestSignal(signal, timeoutMs)
  try {
    return await fn(request.signal)
  } finally {
    request.cleanup()
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
      update.retryAttempt = info.retry.attempt
      update.retryNext = info.retry.next
      update.retryMessage = truncateCodePoints(info.retry.message, 1_000)
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
  return `${t(lang, "session")}: ${session.id}\n${t(lang, "title")}: ${title}`
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
  return {
    attempt: retry.attempt,
    message: truncateCodePoints(retry.message, maxChars),
    next: retry.next,
  }
}

function retryLabel(lang: Lang, retry: RetryInfo): string {
  return `${t(lang, "retrying")} (${t(lang, "retryAttempt", {
    attempt: retry.attempt,
  })}; ${t(lang, "retryNext", {
    seconds: Math.max(0, Math.ceil(retry.next / 1_000)),
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
    type: "integer",
    minimum: 0,
    maximum: deps.options.maxOutputChars,
    description: `Maximum output characters. 0 uses the plugin default (${deps.options.maxOutputChars}).`,
  }
}

function maxTextSchemaFor(deps: ToolDeps) {
  return {
    type: "integer",
    minimum: 0,
    maximum: deps.options.maxTextChars,
    description: `Maximum characters for the last text. 0 uses the plugin default (${deps.options.maxTextChars}).`,
  }
}

export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  const queuedPrompts: QueuedPrompts = deps.queuedPrompts ?? new Map()
  const openSessions: OpenSessionMapping = deps.openSessions ?? new Map()
  const inFlightOpens: Map<string, Promise<ToolExecutionResult>> =
    deps.inFlightOpens ?? new Map()
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
          const result = await execute(input, context, lang)
          return {
            content: capOutput(result.content, deps.options.maxOutputChars, lang),
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
          }
        } catch (error) {
          // A denied permission is a Tool.Error, not a successful report.
          if (error instanceof PermissionDenied) throw error.cause
          const prefix = errorKey ? `${t(lang, errorKey)}: ` : ""
          const output = buildErrorOutput
            ? buildErrorOutput(error, input)
            : errorFor(deps, error, input)
          return {
            content: capOutput(`${prefix}${formatError(error)}`, deps.options.maxOutputChars, lang),
            output,
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
        "Create or reuse an OpenCode session in the current directory, send it a message, and wait for its turn. Returns the final state, response text, and actions (tools) performed. Pass sessionID or reuse messageID to retry without duplicating the session. Permission rules with effect allow are rejected unless allowPermissionRules is enabled.",
      input: schema({
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            description:
              "Optional session ID to create or reuse. Retries with the same ID do not create a second session.",
          },
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Initial message to send to the new session." },
          title: { type: "string", maxLength: deps.options.maxTitleChars, description: "Session title. If omitted, it is derived from the message." },
          agent: { type: "string", description: "Agent ID. Defaults to build." },
          model: { type: "string", description: "Model in provider/model format. Defaults to this session's model." },
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
            description:
              "Optional idempotency key for the message and for the session mapping. Reusing it does not create a second message or session.",
          },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            description:
              "Optional permission rules for the new session. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchema,
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
      const openKey = data.messageID
        ? `message:${data.messageID}`
        : data.sessionID
          ? `session:${data.sessionID}`
          : undefined
      if (openKey) {
        const existing = inFlightOpens.get(openKey)
        if (existing) return existing
      }

      const operation = (async (): Promise<ToolExecutionResult> => {
        const explicitModel = parseModel(data.model)
        await assertPermission(
          deps,
          context,
          "session_bridge.open",
          [data.sessionID ?? data.messageID ?? "new-session"],
          {
            delivery: data.delivery,
            wait: data.wait,
            hasSessionID: Boolean(data.sessionID),
            hasMessageID: Boolean(data.messageID),
            ...(data.agent ? { agent: data.agent } : {}),
            ...(explicitModel ? { model: data.model } : {}),
          },
        )

        let created: SessionInfo | undefined
        let reused = false
        const directory = deps.ctx.location?.directory
        let targetSessionID =
          data.sessionID ?? lookupOpenSession(openSessions, data.messageID, directory)
        const title = titleFromPrompt(
          data.prompt,
          data.title,
          t(lang, "newSession"),
          deps.options.maxTitleChars,
        )
        try {
          if (targetSessionID) {
            try {
              created = await withRequest(
                signalOf(context),
                deps.options.requestTimeoutMs,
                (signal) => deps.ctx.session.get({ sessionID: targetSessionID as string }, { signal }),
              )
              reused = true
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
                  signalOf(context),
                  deps.options.requestTimeoutMs,
                  (signal) => deps.ctx.session.get({ sessionID: callerSessionID }, { signal }),
                ).catch(() => undefined)
                fallback = modelRef(caller?.model)
              }
              if (!fallback) {
                const preferred = await withRequest(
                  signalOf(context),
                  deps.options.requestTimeoutMs,
                  (signal) => deps.ctx.model.default(undefined, { signal }),
                ).catch(() => undefined)
                // `model.default` returns `{ location, data: ModelInfo | null }`.
                fallback = modelRef(preferred?.data)
              }
            }

            try {
              created = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
                deps.ctx.session.create(
                  {
                    id: targetSessionID,
                    title,
                    agent: data.agent ?? "build",
                    model: explicitModel ?? fallback,
                    permissions: data.permissions,
                  },
                  { signal },
                ),
              )
            } catch (error) {
              // A concurrent creator may have won the race for an explicit ID.
              if (targetSessionID && isAlreadyExistsError(error)) {
                created = await withRequest(
                  signalOf(context),
                  deps.options.requestTimeoutMs,
                  (signal) =>
                    deps.ctx.session.get({ sessionID: targetSessionID as string }, { signal }),
                )
                reused = true
              } else {
                throw error
              }
            }
          }

          const createdSessionID = created.id
          targetSessionID = createdSessionID
          if (data.messageID) {
            await rememberOpenSession(
              deps.ctx,
              openSessions,
              data.messageID,
              createdSessionID,
              directory,
            )
          }
          await rememberOwnedSession(
            deps.ctx,
            deps.ownedSessions,
            createdSessionID,
            directory,
          )

          const admitted = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
            deps.ctx.session.prompt(
              {
                sessionID: createdSessionID,
                text: data.prompt,
                delivery: data.delivery,
                id: data.messageID,
              },
              { signal },
            ),
          )

          const displayTitle = truncateCodePoints(
            sanitizeTitle(created.title ?? title),
            deps.options.maxTitleChars,
          )
          const header = `${t(lang, reused ? "reused" : "created")}: ${created.id}\n${t(
            lang,
            "title",
          )}: ${displayTitle}`
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
              content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${
                admitted.id
              }${queued}`,
              output: cleanOutput({
                sessionID: created.id,
                title: displayTitle,
                messageID: admitted.id,
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
            signal: signalOf(context),
            requireAnchor: true,
            promptMessageID: admitted.id,
            ...waitConfig(deps, context, created.id),
          })
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
          if (turn.state !== "idle" && !turn.pendingPermissions?.length) {
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
            }),
          }
        } catch (error) {
          if (error instanceof PermissionDenied) throw error
          const errorID = created?.id ?? targetSessionID
          const reason = formatError(error)
          const suffix = errorID ? `\n${t(lang, "orphanSession", { id: errorID })}` : ""
          return {
            content: `${t(lang, "couldNotOpen")}: ${reason}${suffix}`,
            output: errorOutput(error, deps.options.maxErrorChars, {
              sessionID: errorID,
              messageID: data.messageID,
              title: boundTitle(data.title ?? title, deps.options.maxTitleChars),
            }),
          }
        }
      })()

      if (openKey) {
        inFlightOpens.set(openKey, operation)
        const clear = () => {
          if (inFlightOpens.get(openKey) === operation) inFlightOpens.delete(openKey)
        }
        void operation.then(clear, clear)
        while (inFlightOpens.size > 100) {
          const oldest = inFlightOpens.keys().next().value
          if (typeof oldest !== "string" || oldest === openKey) break
          inFlightOpens.delete(oldest)
        }
      }
      return operation
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
          sessionID: { type: "string", description: "Target session ID, for example ses_abc123." },
          prompt: { type: "string", minLength: 1, maxLength: deps.options.maxPromptChars, description: "Message to send to the session." },
          agent: { type: "string", description: "Optional: switch the session's agent before sending." },
          model: { type: "string", description: "Optional: switch the model (provider/model) before sending." },
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
      const applied: string[] = []
      await assertPermission(
        deps,
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
      try {
        const session = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
          deps.ctx.session.get({ sessionID: data.sessionID }, { signal }),
        )
        const model = parseModel(data.model)
        if (model) {
          await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
            deps.ctx.session.switchModel({ sessionID: data.sessionID, model }, { signal }),
          )
          applied.push(`${t(lang, "model")}: ${data.model}`)
        }
        if (data.agent) {
          const agent = data.agent
          await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
            deps.ctx.session.switchAgent({ sessionID: data.sessionID, agent }, { signal }),
          )
          applied.push(`${t(lang, "agent")}: ${agent}`)
        }

        const admitted = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
          deps.ctx.session.prompt(
            {
              sessionID: data.sessionID,
              text: data.prompt,
              delivery: data.delivery,
              id: data.messageID,
            },
            { signal },
          ),
        )

        const header = sessionHeader(lang, session)
        if (!data.wait) {
          if (data.delivery === "queue") {
            enqueueQueuedPrompt(
              queuedPrompts,
              data.sessionID,
              admitted.id,
              "queue",
              queueOptions(deps.options),
            )
          }
          const queued = data.delivery === "queue" ? `\n${t(lang, "messageQueued")}` : ""
          return {
            content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${
              admitted.id
            }${queued}`,
            output: cleanOutput({
              sessionID: data.sessionID,
              title: boundTitle(session.title, deps.options.maxTitleChars),
              messageID: admitted.id,
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
          anchorID: admitted.id,
          promptText: data.prompt,
          admittedAt: admitted.time?.created ?? Date.now(),
          timeoutMs: data.timeoutMs,
          signal: signalOf(context),
          requireAnchor: true,
          promptMessageID: admitted.id,
          ...waitConfig(deps, context, data.sessionID),
        })
        if (turn.state === "idle") {
          removeQueuedPrompt(
            queuedPrompts,
            data.sessionID,
            admitted.id,
            queueOptions(deps.options),
          )
          deps.liveState?.markDelivered(data.sessionID, admitted.id)
          deps.liveState?.reconcile(data.sessionID, turn.messages)
        }
        let content = renderTurn(lang, header, turn, data.maxOutputChars, deps.options)
        if (turn.state !== "idle" && !turn.pendingPermissions?.length) {
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
          output: turnOutputValue(data.sessionID, session.title, turn, deps.options),
        }
      } catch (error) {
        if (error instanceof PermissionDenied) throw error
        const reason = formatError(error)
        const suffix = applied.length
          ? `\n${t(lang, "appliedChanges", { changes: applied.join(", ") })}`
          : ""
        return {
          content: `${t(lang, "couldNotSend")}: ${reason}${suffix}`,
          output: errorOutput(error, deps.options.maxErrorChars, {
            sessionID: data.sessionID,
            messageID: data.messageID,
          }),
        }
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
          sessionID: { type: "string", description: "ID of the session to inspect." },
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

      deps.liveState?.reconcile(data.sessionID, messages)
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

      const liveStatus = live.status
      const liveRetry: RetryInfo | undefined =
        liveStatus?.type === "retry"
          ? { attempt: liveStatus.attempt, message: liveStatus.message, next: liveStatus.next }
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
          : contextError
            ? "error"
            : liveRetry
              ? "retrying"
              : running
                ? "running"
                : queued
                  ? "queued"
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

      const lastOutcome = idle?.outcome ?? session.outcome
      const resultLabel = liveRetry
        ? t(lang, "retrying")
        : running
          ? t(lang, "running")
          : (lastOutcome ?? t(lang, "unknown"))

      const headerBudget = Math.max(160, Math.floor(data.maxOutputChars * 0.2))
      const lines = [
        truncateCodePoints(sessionHeader(lang, session), headerBudget),
        `${t(lang, "state")}: ${stateLabel}`,
        `${t(lang, "result")}: ${resultLabel}`,
        `${t(lang, "lastUpdate")}: ${formatTimestamp(session.time?.updated, lang)}`,
      ]
      if (promptMessageID) {
        lines.push(`${t(lang, "promptMessageID")}: ${promptMessageID}`)
      }
      if (queuedCount > 1) {
        lines.push(
          `${t(lang, "queuedMessages", { count: queuedCount })}: ${queueIDs
            .slice(0, 20)
            .join(", ")}`,
        )
      }

      const errorBudget = Math.min(
        deps.options.maxErrorChars,
        Math.max(80, Math.floor(data.maxOutputChars * 0.1)),
      )
      const error = assistant?.error?.message ?? idle?.error?.message
      if (error) lines.push(`${t(lang, "error")}: ${compact(error, errorBudget)}`)
      if (contextError) lines.push(`${t(lang, "error")}: ${compact(contextError, errorBudget)}`)
      if (permissionError) lines.push(`${t(lang, "error")}: ${compact(permissionError, errorBudget)}`)
      if (liveRetry) {
        lines.push(`${t(lang, "retryReason")}: ${compact(liveRetry.message, errorBudget)}`)
      }
      const lastMessageID = messages.length ? messages[messages.length - 1]?.id : undefined
      if (lastMessageID) {
        lines.push(`${t(lang, "lastMessage")}: ${lastMessageID}`)
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
        lines.push(`${t(lang, "agent")}: ${session.agent ?? t(lang, "unknown")}`)
        lines.push(`${t(lang, "model")}: ${modelLabel(session) || t(lang, "unknown")}`)
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
          pendingPermissions: pendingOutput.pendingPermissions,
          pendingTotal: pendingOutput.pendingTotal,
          pendingTruncated: pendingOutput.pendingTruncated,
          retry: retryOutput(liveRetry, budget.maxErrorChars),
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
          sessionID: { type: "string", description: "ID of the session whose pending permissions should be listed." },
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
          content: `${t(lang, "session")} ${data.sessionID}: ${t(lang, "noPendingPermissions")}`,
          output: {
            sessionID: data.sessionID,
            pending: [],
            pendingTotal: 0,
            pendingTruncated: false,
            hasMore: false,
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
          sessionID: { type: "string", description: "ID of the session that owns the request." },
          requestID: { type: "string", description: "Permission request ID, for example per_abc123." },
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
          deps.ctx.location?.directory,
        ) &&
        !deps.options.allowReplyToForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignSessionBlocked")} ${t(lang, "foreignSessionHint")}`)
      }

      await assertPermission(
        deps,
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
        content: `${t(lang, "requestApproved", { id: data.requestID, label })}\n${t(
          lang,
          "session",
        )}: ${data.sessionID}`,
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
          sessionID: { type: "string", description: "ID of the session to read." },
          limit: limitSchema,
          afterMessageID: {
            type: "string",
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
          sessionID: { type: "string", description: "ID of the session to wait for." },
          messageID: {
            type: "string",
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
      const [sessionResult, messagesResult, pendingResult] = await Promise.allSettled([
        withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
          deps.ctx.session.get({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
        withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
          deps.ctx.session.context({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
        withRequest(signal, deps.options.requestTimeoutMs, (requestSignalValue) =>
          deps.ctx.permission.list({ sessionID: data.sessionID }, { signal: requestSignalValue }),
        ),
      ])

      if (sessionResult.status === "rejected") throw sessionResult.reason
      const session = sessionResult.value
      const contextFailed = messagesResult.status === "rejected"
      const messages = messagesResult.status === "fulfilled" ? messagesResult.value : []
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
      const header = sessionHeader(lang, session)
      deps.liveState?.reconcile(data.sessionID, messages)
      const localQueue = listQueuedPrompts(
        queuedPrompts,
        data.sessionID,
        queueOptions(deps.options),
      )
      const live = liveQueue(deps, data.sessionID)
      const targetMessageID =
        data.messageID ?? localQueue[0]?.messageID ?? live.pending[0]?.messageID
      const liveRetry: RetryInfo | undefined =
        live.status?.type === "retry"
          ? {
              attempt: live.status.attempt,
              message: live.status.message,
              next: live.status.next,
            }
          : undefined
      const liveRunning =
        live.status?.type === "busy"
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
      const anchorID = targetMessageID ?? user?.id
      const evaluation = anchorID
        ? evaluateTurn(messages, {
            sessionID: data.sessionID,
            anchorID,
            requireAnchor: Boolean(targetMessageID),
            promptMessageID: targetMessageID,
            timeoutMs: data.timeoutMs,
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

      if (!targetMessageID && !running && !contextFailed && (!user || evaluation?.done)) {
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
        anchorID,
        promptText: targetMessageID ? undefined : user?.text,
        admittedAt: targetMessageID ? undefined : user?.time?.created,
        timeoutMs: data.timeoutMs,
        signal,
        initialMessages: contextFailed ? undefined : messages,
        initialFetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
        requireAnchor: Boolean(anchorID),
        promptMessageID: targetMessageID ?? user?.id,
        ...waitConfig(deps, context, data.sessionID),
      })
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
      if (turn.state !== "idle" && !turn.pendingPermissions?.length) {
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
        output: turnOutputValue(data.sessionID, session.title, turn, deps.options),
      }
    },
    "couldNotWait",
    (error, input) => errorFor(deps, error, input, ["sessionID", "messageID"]),
  )

  add(
    {
      name: "interrupt",
      description: "Interrupt a session's running turn.",
      input: schema({
        type: "object",
        properties: {
          sessionID: { type: "string", description: "ID of the session to interrupt." },
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
          deps.ctx.location?.directory,
        ) &&
        !deps.options.allowInterruptForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignInterruptBlocked")} ${t(lang, "foreignInterruptHint")}`)
      }
      await assertPermission(
        deps,
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
      clearQueuedPrompts(queuedPrompts, data.sessionID)
      deps.liveState?.clearSession(data.sessionID)
      return {
        content: t(lang, "sessionInterrupted", {
          id: data.sessionID,
          label: result?.interrupted ? t(lang, "interrupted") : t(lang, "noActiveTurn"),
        }),
        output: {
          sessionID: data.sessionID,
          interrupted: Boolean(result?.interrupted),
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
          directory: { type: "string", description: "Directory whose sessions are listed. Defaults to the current one." },
          cursor: { type: "string", description: "Cursor from a previous response." },
          order: { type: "string", enum: ["asc", "desc"], description: "Sort order." },
          archived: { type: "boolean", description: "List archived sessions instead of active ones." },
          parentID: { type: "string", description: "Only list sessions with this parent ID." },
          subpath: { type: "string", description: "Only list sessions for this subpath." },
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
      const page = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.list(
          {
            directory: data.directory ?? deps.ctx.location?.directory,
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
      const sessionsOutput = shown.map((session) => {
        const running = isRunning(session, [])
        return cleanOutput({
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
        })
      })
      if (!shown.length) {
        return {
          content: t(lang, "noSessions"),
          output: cleanOutput({ sessions: [], nextCursor, count: 0 }),
        }
      }

      const lines = shown.map((session) => {
        const state = isRunning(session, []) ? t(lang, "running") : t(lang, "idle")
        const outcome = session.outcome ? ` (${session.outcome})` : ""
        const parent = session.parentID ? ` | ${t(lang, "parent")}: ${session.parentID}` : ""
        const title = truncateCodePoints(
          sanitizeTitle(session.title ?? t(lang, "noTitle")),
          deps.options.maxTitleChars,
        )
        const base = `- ${session.id} | ${title} | ${state}${outcome} | ${formatTimestamp(
          session.time?.updated,
          lang,
        )}${parent}`
        if (!data.verbose) return base
        return `${base} | ${t(lang, "agent")}: ${session.agent ?? t(lang, "unknown")} | ${t(
          lang,
          "model",
        )}: ${modelLabel(session) || t(lang, "unknown")} | ${t(lang, "cost")}: ${
          compact(session.cost, 100) || t(lang, "unknown")
        } | ${t(lang, "tokens")}: ${compact(session.tokens, 200) || t(lang, "unknown")}`
      })

      let content = `${t(lang, "sessions")}:\n${lines.join("\n")}\n\n${t(lang, "statusSnapshot")}`
      if (nextCursor) content += `\n${t(lang, "cursorNext")}: ${nextCursor}`
      return {
        content: capOutput(content, data.maxOutputChars, lang),
        output: cleanOutput({
          sessions: sessionsOutput,
          nextCursor,
          count: sessionsOutput.length,
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
          sessionID: { type: "string", description: "ID of the session to update." },
          title: { type: "string", maxLength: deps.options.maxTitleChars, description: "New session title." },
          archived: { type: "boolean", description: "Archive or unarchive the session." },
          metadata: { type: "object", description: "Session metadata object." },
          permissions: {
            type: "array",
            maxItems: deps.options.maxPermissionRules,
            description: "New permission rules. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchema,
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
          deps.ctx.location?.directory,
        ) &&
        !deps.options.allowUpdateForeignSessions
      ) {
        throw new ValidationError(`${t(lang, "foreignUpdateBlocked")} ${t(lang, "foreignUpdateHint")}`)
      }
      await assertPermission(
        deps,
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
      const update: UpdateInput = {
        sessionID: data.sessionID,
        title: data.title,
        archived: data.archived,
        metadata: data.metadata as UpdateInput["metadata"],
        permissions: data.permissions,
      }
      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.update(update, { signal }),
      )

      const lines = [`${t(lang, "updated")}: ${data.sessionID}`]
      if (data.title !== undefined) {
        lines.push(
          `${t(lang, "title")}: ${truncateCodePoints(
            sanitizeTitle(data.title),
            deps.options.maxTitleChars,
          )}`,
        )
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
          sessionID: { type: "string", description: "ID of the session to delete." },
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
      await assertPermission(
        deps,
        context,
        "session_bridge.remove",
        [data.sessionID],
        { sessionID: data.sessionID },
      )
      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.remove({ sessionID: data.sessionID }, { signal }),
      )
      await forgetOwnedSession(deps.ctx, deps.ownedSessions, data.sessionID)
      await forgetOpenSessionsBySessionID(deps.ctx, openSessions, data.sessionID)
      clearQueuedPrompts(queuedPrompts, data.sessionID)
      deps.liveState?.clearSession(data.sessionID)
      return {
        content: `${t(lang, "removed")}: ${data.sessionID}`,
        output: { sessionID: data.sessionID, removed: true, state: "ok" },
      }
    },
    "couldNotRemove",
    (error, input) => errorFor(deps, error, input, ["sessionID"]),
  )
}
