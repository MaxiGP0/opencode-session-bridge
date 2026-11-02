import { t, type StringKey } from "./i18n.ts"
import {
  assistantText,
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
  renderTranscript,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
  truncateCodePoints,
} from "./format.ts"
import type { BridgeOptions } from "./options.ts"
import { forgetOwnedSession, rememberOwnedSession } from "./registry.ts"
import type {
  Lang,
  PermissionLike,
  PluginContext,
  ProgressInfo,
  RegisteredTool,
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
import { requestSignal, waitForTurn } from "./wait.ts"

export type ToolDeps = {
  ctx: PluginContext
  options: BridgeOptions
  getLanguage: () => Lang
  setLanguage: (lang: Lang) => Promise<void>
  ownedSessions: Set<string>
}

type ToolDefinition = Omit<RegisteredTool, "execute">
type ToolExecute = (
  input: unknown,
  context: ToolExecuteContext,
  lang: Lang,
) => Promise<{ content: string }>

/**
 * JSON Schema objects are validated by OpenCode before `execute` runs. The
 * cast is only at the registration boundary; tool bodies receive `unknown`
 * and validate every field at runtime.
 */
const schema = (value: Record<string, unknown>): ToolDefinition["input"] =>
  value as ToolDefinition["input"]

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

const maxOutputSchema = {
  type: "integer",
  minimum: 1_000,
  maximum: 200_000,
  description: "Maximum output characters. Defaults to the plugin budget (20000).",
}

const timeoutSchema = {
  type: "integer",
  minimum: 1,
  maximum: 600_000,
  description: "Maximum wait time in milliseconds. Defaults to 120000.",
}

const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: 200,
  description: "Number of recent messages. Defaults to 30; 0 also uses the default.",
}

const recentSchema = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Number of recent actions. Defaults to 8; 0 also uses the default.",
}

const listLimitSchema = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Maximum number of sessions. Defaults to 10; 0 also uses the default.",
}

function signalOf(context: ToolExecuteContext): AbortSignal {
  return context.signal ?? new AbortController().signal
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
  return `${t(lang, "session")}: ${session.id}\n${t(lang, "title")}: ${
    session.title ?? t(lang, "noTitle")
  }`
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
  const summary = summarizeTurn(turn.messages, turn.startIndex)
  return formatSummary(header, summary, {
    lang,
    state: turnStateLabel(lang, turn),
    maxOutputChars,
    maxTextChars: options.maxTextChars,
    maxTools: options.maxTools,
    maxToolLine: options.maxToolLine,
    maxPermissions: options.maxPermissions,
    promptMessageID: turn.promptMessageID,
    lastError: turn.state === "idle" ? undefined : turn.lastError,
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
    const lines = [
      t(lang, "pendingPermissionsCount", { count: pending.length }),
      ...pending.slice(0, deps.options.maxPermissions).map((request) => permissionLine(request, lang)),
      t(lang, "replyHint"),
    ]
    return capOutput(`${content}\n\n${lines.join("\n")}`, maxOutputChars, lang)
  } catch {
    return content
  }
}

function formatTimestamp(value: number | undefined, lang: Lang): string {
  return value ? new Date(value).toISOString() : t(lang, "unknownF")
}

export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  const add = (definition: ToolDefinition, execute: ToolExecute, errorKey?: StringKey) => {
    const tool = {
      ...definition,
      execute: async (input: unknown, context: ToolExecuteContext) => {
        const lang = deps.getLanguage()
        try {
          const result = await execute(input, context, lang)
          return { content: capOutput(result.content, deps.options.maxOutputChars, lang) }
        } catch (error) {
          const prefix = errorKey ? `${t(lang, errorKey)}: ` : ""
          return {
            content: capOutput(`${prefix}${formatError(error)}`, deps.options.maxOutputChars, lang),
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
        "Create a NEW OpenCode session in the current directory, send it a message, and wait for its turn. Returns the final state, response text, and actions (tools) performed. The prompt ID returned by the server anchors the exact turn. Permission rules with effect allow are rejected unless allowPermissionRules is enabled.",
      input: schema({
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1, description: "Initial message to send to the new session." },
          title: { type: "string", description: "Session title. If omitted, it is derived from the message." },
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
            description: "Optional idempotency key. Reusing it does not create a second message.",
          },
          permissions: {
            type: "array",
            description:
              "Optional permission rules for the new session. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchema,
          },
          maxOutputChars: maxOutputSchema,
        },
        required: ["prompt"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseOpenInput(input, lang, deps.options)
      let created: SessionInfo | undefined
      try {
        let fallback: { providerID: string; id: string } | undefined
        if (context.sessionID) {
          const caller = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
            deps.ctx.session.get({ sessionID: context.sessionID as string }, { signal }),
          ).catch(() => undefined)
          fallback = modelRef(caller?.model)
        }
        if (!fallback) {
          const preferred = await withRequest(
            signalOf(context),
            deps.options.requestTimeoutMs,
            (signal) => deps.ctx.model.default(undefined, { signal }),
          ).catch(() => undefined)
          fallback = modelRef(preferred)
        }

        const title = titleFromPrompt(data.prompt, data.title, t(lang, "newSession"))
        created = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
          deps.ctx.session.create(
            {
              title,
              agent: data.agent ?? "build",
              model: parseModel(data.model) ?? fallback,
              permissions: data.permissions,
            },
            { signal },
          ),
        )
        await rememberOwnedSession(deps.ctx, deps.ownedSessions, created.id)

        const admitted = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
          deps.ctx.session.prompt(
            {
              sessionID: created?.id as string,
              text: data.prompt,
              delivery: data.delivery,
              id: data.messageID,
            },
            { signal },
          ),
        )

        const header = `${t(lang, "created")}: ${created.id}\n${t(lang, "title")}: ${
          created.title ?? title
        }`
        if (!data.wait) {
          const queued = data.delivery === "queue" ? `\n${t(lang, "messageQueued")}` : ""
          return {
            content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${
              admitted.id
            }${queued}`,
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
        return { content }
      } catch (error) {
        const suffix = created ? `\n${t(lang, "orphanSession", { id: created.id })}` : ""
        return { content: `${t(lang, "couldNotOpen")}: ${formatError(error)}${suffix}` }
      }
    },
    "couldNotOpen",
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
          prompt: { type: "string", minLength: 1, description: "Message to send to the session." },
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
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID", "prompt"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseSendInput(input, lang, deps.options)
      const applied: string[] = []
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
          await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
            deps.ctx.session.switchAgent(
              { sessionID: data.sessionID, agent: data.agent as string },
              { signal },
            ),
          )
          applied.push(`${t(lang, "agent")}: ${data.agent}`)
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
          const queued = data.delivery === "queue" ? `\n${t(lang, "messageQueued")}` : ""
          return {
            content: `${header}\n\n${t(lang, "background")}\n${t(lang, "promptMessageID")}: ${
              admitted.id
            }${queued}`,
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
        return { content }
      } catch (error) {
        const suffix = applied.length
          ? `\n${t(lang, "appliedChanges", { changes: applied.join(", ") })}`
          : ""
        return { content: `${t(lang, "couldNotSend")}: ${formatError(error)}${suffix}` }
      }
    },
    "couldNotSend",
  )

  add(
    {
      name: "status",
      description:
        "Check right now whether a session is running or idle, its result, the last text it produced, recent tools, and the last message ID for reading further. Uses session timestamps and ignores control messages. State is a snapshot.",
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
          maxText: {
            type: "integer",
            minimum: 100,
            maximum: 50_000,
            description: "Maximum characters for the last text. Defaults to 4000.",
          },
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseStatusInput(input, lang, deps.options)
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
      const messages = messagesResult.status === "fulfilled" ? messagesResult.value : []
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
      const contextError =
        messagesResult.status === "rejected" ? formatError(messagesResult.reason) : undefined
      const permissionError =
        pendingResult.status === "rejected" ? formatError(pendingResult.reason) : undefined

      const running = isRunning(session, messages)
      const idle = lastIdle(messages)
      const assistant = lastAssistant(messages)
      const text = assistantText(assistant)
      const allTools = collectRecentTools(messages, data.recent)
      const omittedTools = Math.max(0, allTools.length - deps.options.maxTools)
      const tools =
        omittedTools > 0 ? allTools.slice(-deps.options.maxTools) : allTools

      const lines = [
        sessionHeader(lang, session),
        `${t(lang, "state")}: ${
          pending.length ? t(lang, "permissionState") : running ? t(lang, "running") : t(lang, "idle")
        }`,
        `${t(lang, "result")}: ${idle?.outcome ?? session.outcome ?? t(lang, "unknown")}`,
        `${t(lang, "lastUpdate")}: ${formatTimestamp(session.time?.updated, lang)}`,
      ]

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
            text ? truncateCodePoints(text, textBudget) : t(lang, "noText")
          }`,
        )
      }

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

      if (pending.length) {
        lines.push(t(lang, "pendingPermissionsCount", { count: pending.length }))
        lines.push(
          pending
            .slice(0, deps.options.maxPermissions)
            .map((request) => permissionLine(request, lang))
            .join("\n"),
        )
        lines.push(t(lang, "replyHint"))
      }

      const error = assistant?.error?.message ?? idle?.error?.message
      if (error) lines.push(`${t(lang, "error")}: ${compact(error, 1_000)}`)
      if (contextError) lines.push(`${t(lang, "error")}: ${compact(contextError, 1_000)}`)
      if (permissionError) lines.push(`${t(lang, "error")}: ${compact(permissionError, 1_000)}`)
      if (messages.length) {
        lines.push(`${t(lang, "lastMessage")}: ${messages[messages.length - 1]?.id ?? ""}`)
      }
      return { content: capOutput(lines.join("\n"), data.maxOutputChars, lang) }
    },
    "couldNotInspect",
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
            minimum: 1,
            maximum: 100,
            description: "Maximum requests to show. Defaults to 20; 0 also uses the default.",
          },
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
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
        }
      }
      const shown = pending.slice(0, data.limit)
      const lines = [
        t(lang, "pendingPermissionsCount", { count: pending.length }),
        ...shown.map((request) => permissionLine(request, lang)),
      ]
      if (pending.length > shown.length) lines.push("…")
      lines.push(t(lang, "replyHint3"))
      return { content: capOutput(lines.join("\n"), data.maxOutputChars, lang) }
    },
    "couldNotQueryPermissions",
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
            description: "Optional message to include with the decision, especially when rejecting.",
          },
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID", "requestID", "decision"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseReplyInput(input, lang, deps.options)
      if (data.decision === "always" && !deps.options.allowPersistentPermissions) {
        throw new ValidationError(`${t(lang, "alwaysBlocked")} ${t(lang, "alwaysHint")}`)
      }
      if (!deps.ownedSessions.has(data.sessionID) && !deps.options.allowReplyToForeignSessions) {
        throw new ValidationError(`${t(lang, "foreignSessionBlocked")} ${t(lang, "foreignSessionHint")}`)
      }

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
      }
    },
    "couldNotReplyPermission",
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
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseReadInput(input, lang, deps.options)
      const messages = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.context({ sessionID: data.sessionID }, { signal }),
      )
      return {
        content: renderTranscript(messages, {
          lang,
          limit: data.limit,
          afterMessageID: data.afterMessageID,
          includeTools: data.includeTools,
          includeToolOutput: data.includeToolOutput,
          includeReasoning: data.includeReasoning,
          maxOutputChars: data.maxOutputChars,
          maxTextChars: deps.options.maxTextChars,
          maxToolLine: deps.options.maxToolLine,
        }),
      }
    },
    "couldNotRead",
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
          timeoutMs: timeoutSchema,
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
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
      const messages = messagesResult.status === "fulfilled" ? messagesResult.value : []
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
      const header = sessionHeader(lang, session)

      if (pending.length) {
        const turn: TurnResult = {
          state: "permission",
          messages,
          startIndex: messages.length,
          pendingPermissions: pending,
          elapsedMs: 0,
          fetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
        }
        return { content: renderTurn(lang, header, turn, data.maxOutputChars, deps.options) }
      }

      const running = isRunning(session, messages)
      const user = lastUser(messages)

      if (!running) {
        if (!user) {
          const idle = lastIdle(messages)
          return {
            content: capOutput(
              `${header}\n${t(lang, "state")}: ${t(lang, "idle")}\n${t(lang, "result")}: ${
                idle?.outcome ?? session.outcome ?? t(lang, "unknown")
              }\n${t(lang, "noPendingTurns")}`,
              data.maxOutputChars,
              lang,
            ),
          }
        }
        const startIndex = messages.findIndex((message) => message.id === user.id)
        const summary = summarizeTurn(messages, Math.max(0, startIndex))
        return {
          content: formatSummary(header, summary, {
            lang,
            maxOutputChars: data.maxOutputChars,
            maxTextChars: deps.options.maxTextChars,
            maxTools: deps.options.maxTools,
            maxToolLine: deps.options.maxToolLine,
            maxPermissions: deps.options.maxPermissions,
          }),
        }
      }

      const turn = await waitForTurn(deps.ctx, {
        sessionID: data.sessionID,
        anchorID: user?.id,
        timeoutMs: data.timeoutMs,
        signal,
        initialMessages: messages,
        initialFetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
        requireAnchor: Boolean(user?.id),
        ...waitConfig(deps, context, data.sessionID),
      })
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
      return { content }
    },
    "couldNotWait",
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
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseInterruptInput(input, lang, deps.options)
      const result = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.interrupt(
          { sessionID: data.sessionID, resume: data.resume },
          { signal },
        ),
      )
      return {
        content: t(lang, "sessionInterrupted", {
          id: data.sessionID,
          label: result?.interrupted ? t(lang, "interrupted") : t(lang, "noActiveTurn"),
        }),
      }
    },
    "couldNotInterrupt",
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
          search: { type: "string", description: "Text to filter by title." },
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
          maxOutputChars: maxOutputSchema,
        },
        required: [],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseListInput(input, lang, deps.options)
      const page = await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.list(
          {
            directory: data.directory ?? deps.ctx.location.directory,
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
      if (!page.data.length) return { content: t(lang, "noSessions") }

      const lines = page.data.map((session) => {
        const state = isRunning(session, []) ? t(lang, "running") : t(lang, "idle")
        const outcome = session.outcome ? ` (${session.outcome})` : ""
        const parent = session.parentID ? ` | ${t(lang, "parent")}: ${session.parentID}` : ""
        const base = `- ${session.id} | ${session.title ?? t(lang, "noTitle")} | ${state}${outcome} | ${formatTimestamp(
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
      if (page.cursor?.next) content += `\n${t(lang, "cursorNext")}: ${page.cursor.next}`
      return { content: capOutput(content, data.maxOutputChars, lang) }
    },
    "couldNotList",
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
          maxOutputChars: maxOutputSchema,
        },
        required: [],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, _context, lang) => {
      const data = parseLanguageInput(input, lang, deps.options)
      if (data.language) {
        await deps.setLanguage(data.language)
        return {
          content: data.language === "es" ? t("es", "languageSetEs") : t("en", "languageSetEn"),
        }
      }
      return { content: lang === "es" ? t("es", "languageCurrentEs") : t("en", "languageCurrentEn") }
    },
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
          title: { type: "string", description: "New session title." },
          archived: { type: "boolean", description: "Archive or unarchive the session." },
          metadata: { type: "object", description: "Session metadata object." },
          permissions: {
            type: "array",
            description: "New permission rules. allow rules require allowPermissionRules: true.",
            items: permissionRuleSchema,
          },
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
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
      if (data.title !== undefined) lines.push(`${t(lang, "title")}: ${data.title}`)
      if (data.archived !== undefined) {
        lines.push(
          `${t(lang, "archived")}: ${data.archived ? t(lang, "yes") : t(lang, "no")}`,
        )
      }
      if (data.permissions !== undefined) {
        lines.push(`${t(lang, "permissionRules")}: ${data.permissions.length}`)
      }
      return { content: capOutput(lines.join("\n"), data.maxOutputChars, lang) }
    },
    "couldNotUpdate",
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
          maxOutputChars: maxOutputSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      }),
      options: { namespace: "sessions", codemode: true },
    },
    async (input, context, lang) => {
      const data = parseRemoveInput(input, lang, deps.options)
      if (!deps.options.allowSessionRemoval) {
        throw new ValidationError(`${t(lang, "removeDisabled")} ${t(lang, "removeHint")}`)
      }
      if (!data.confirm) throw new ValidationError(t(lang, "confirmRequired"))
      await withRequest(signalOf(context), deps.options.requestTimeoutMs, (signal) =>
        deps.ctx.session.remove({ sessionID: data.sessionID }, { signal }),
      )
      await forgetOwnedSession(deps.ctx, deps.ownedSessions, data.sessionID)
      return { content: `${t(lang, "removed")}: ${data.sessionID}` }
    },
    "couldNotRemove",
  )
}
