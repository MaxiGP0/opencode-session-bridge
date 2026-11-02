import { Plugin } from "@opencode/plugin"

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_MS = 250
const MAX_TEXT = 4_000
const MAX_TOTAL = 20_000

type Lang = "es" | "en"

const ES_TO_EN: Array<[string, string]> = [
  ["Mensaje enviado. La sesión sigue en segundo plano.", "Message sent. The session continues in the background."],
  [
    "Usa sessions.reply con el ID de la solicitud para aprobar o rechazar.",
    "Use sessions.reply with the request ID to approve or reject.",
  ],
  ["Usa sessions.reply con el ID de la solicitud para responder.", "Use sessions.reply with the request ID to respond."],
  ["Usa sessions.reply con sessionID y requestID para responder.", "Use sessions.reply with sessionID and requestID to respond."],
  ["No se pudo abrir la sesión: ", "Could not open the session: "],
  ["No se pudo enviar el mensaje: ", "Could not send the message: "],
  ["No se pudo consultar la sesión: ", "Could not inspect the session: "],
  ["No se pudieron consultar los permisos: ", "Could not query permissions: "],
  ["No se pudo responder al permiso: ", "Could not reply to permission: "],
  ["No se pudo leer la sesión: ", "Could not read the session: "],
  ["No se pudo esperar la sesión: ", "Could not wait for the session: "],
  ["No se pudo interrumpir la sesión: ", "Could not interrupt the session: "],
  ["No se pudieron listar las sesiones: ", "Could not list sessions: "],
  ["Sesión creada: ", "Session created: "],
  ["Sesión: ", "Session: "],
  ["Sesión ", "Session "],
  ["Título: ", "Title: "],
  ["Mensaje enviado: ", "Message sent: "],
  ["Estado: ", "State: "],
  ["Resultado: ", "Result: "],
  ["Última actualización: ", "Last update: "],
  ["Último texto: ", "Last text: "],
  ["Último mensaje: ", "Last message: "],
  ["Texto final: (sin texto)", "Final text: (no text)"],
  ["Texto final:\n", "Final text:\n"],
  ["Acciones recientes: (ninguna)", "Recent actions: (none)"],
  ["Acciones: (ninguna)", "Actions: (none)"],
  ["Acciones recientes (", "Recent actions ("],
  ["Acciones (", "Actions ("],
  ["Permisos pendientes (", "Pending permissions ("],
  ["sigue en ejecución (tiempo agotado)", "still running (timed out)"],
  ["espera cancelada", "wait cancelled"],
  ["inactiva (sin turnos)", "idle (no turns)"],
  ["en ejecución", "running"],
  ["inactiva", "idle"],
  ["No hay turnos pendientes.", "No pending turns."],
  ["No hay sesiones.", "No sessions."],
  ["Sesiones:\n", "Sessions:\n"],
  ["Usuario: ", "User: "],
  ["Asistente [error]: ", "Assistant [error]: "],
  ["Asistente: ", "Assistant: "],
  ["— Fin de turno: ", "— End of turn: "],
  ["(sin mensajes)", "(no messages)"],
  ["… (transcripción recortada)", "… (transcript truncated)"],
  ["(sin título)", "(untitled)"],
  ["(sin texto)", "(no text)"],
  ["(desconocido)", "(unknown)"],
  ["Nueva sesión", "New session"],
  ["(sin recursos)", "(no resources)"],
  ["recordar: ", "remember: "],
  [" | padre: ", " | parent: "],
  ["Solicitud ", "Request "],
  ["aprobada una vez", "approved once"],
  ["aprobada y recordada", "approved and saved"],
  ["rechazada", "rejected"],
  ["no hay solicitudes de permiso pendientes.", "no pending permission requests."],
  ["interrumpida", "interrupted"],
  ["no había un turno activo", "there was no active turn"],
]

function localize(content: string, language: Lang) {
  if (language !== "en") return content
  let result = content
  for (const [spanish, english] of ES_TO_EN) {
    result = result.split(spanish).join(english)
  }
  return result
}

type PermissionRule = {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

type OpenInput = {
  prompt: string
  title?: string
  agent?: string
  model?: string
  wait?: boolean
  timeoutMs?: number
  permissions?: PermissionRule[]
}

type PermissionsInput = {
  sessionID: string
}

type ReplyInput = {
  sessionID: string
  requestID: string
  decision: "once" | "always" | "reject"
  message?: string
}

type SendInput = {
  sessionID: string
  prompt: string
  agent?: string
  model?: string
  delivery?: "steer" | "queue"
  wait?: boolean
  timeoutMs?: number
}

type WaitInput = {
  sessionID: string
  timeoutMs?: number
}

type StatusInput = {
  sessionID: string
  recent?: number
}

type ReadInput = {
  sessionID: string
  limit?: number
  afterMessageID?: string
  includeTools?: boolean
  includeToolOutput?: boolean
}

type InterruptInput = {
  sessionID: string
  resume?: boolean
}

type ListInput = {
  limit?: number
  search?: string
  directory?: string
}

type LanguageInput = {
  language?: Lang
}

type TurnResult = {
  state: "idle" | "timeout" | "aborted"
  messages: any[]
  startIndex: number
  idle?: any
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function parseModel(value?: string) {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

function modelRef(value: any) {
  if (!value) return undefined
  if (value.id) return { providerID: value.providerID, id: value.id }
  if (value.modelID) return { providerID: value.providerID, id: value.modelID }
  return undefined
}

function titleFromPrompt(prompt: string, title?: string) {
  if (title?.trim()) return title.trim()
  const firstLine = prompt.trim().split(/\r?\n/)[0] || "Nueva sesión"
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
}

function compact(value: unknown, max = 200) {
  if (value === undefined || value === null) return ""
  let text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text || text === "{}") return ""
  text = text.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function assistantText(message: any): string | undefined {
  if (!message || message.type !== "assistant") return undefined
  const text = (message.content ?? [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

function lastAssistant(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === "assistant") return messages[index]
  }
  return undefined
}

function lastIdle(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === "idle") return messages[index]
  }
  return undefined
}

function lastUser(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === "user") return messages[index]
  }
  return undefined
}

function isRunning(session: any, messages: any[]) {
  if (session?.time?.busy && (!session.time.idle || session.time.busy > session.time.idle)) return true
  if (messages.length === 0) return false
  return messages[messages.length - 1].type !== "idle"
}

function toolsOf(message: any) {
  if (!message || message.type !== "assistant") return []
  return (message.content ?? []).filter((part: any) => part?.type === "tool")
}

function toolLine(tool: any, includeOutput: boolean) {
  const state = tool.state ?? {}
  const status = state.status ?? "unknown"
  const input = compact(state.input, 220)
  let line = `  · ${tool.name} [${status}]`
  if (input) line += ` ${input}`
  if (state.status === "error" && state.error?.message) {
    line += ` → error: ${compact(state.error.message, 300)}`
  }
  if (includeOutput && Array.isArray(state.content)) {
    const output = state.content
      .map((part: any) => (part?.type === "text" ? part.text : part?.type === "file" ? part.uri : ""))
      .filter(Boolean)
      .join("\n")
    if (output) line += ` → ${compact(output, 400)}`
  }
  return line
}

function summarizeTurn(messages: any[], startIndex = 0, includeOutput = false) {
  const slice = messages.slice(startIndex)
  const user = slice.find((message) => message.type === "user")
  const assistant = lastAssistant(slice)
  const idle = [...slice].reverse().find((message) => message.type === "idle")
  const tools = slice.flatMap(toolsOf)
  const text = assistantText(assistant)
  const error =
    assistant?.error?.message ??
    (assistant?.finish === "error" ? assistant?.error?.message : undefined) ??
    idle?.error?.message
  return {
    slice,
    user,
    idle,
    tools,
    text,
    error,
    outcome: idle?.outcome,
    lastMessageID: messages[messages.length - 1]?.id,
  }
}

function formatSummary(title: string, summary: ReturnType<typeof summarizeTurn>, state?: string) {
  const lines = [title]
  if (summary.user?.text) lines.push(`Mensaje enviado: ${compact(summary.user.text, 500)}`)
  const status = state
    ? state
    : summary.outcome
      ? `inactiva (${summary.outcome})`
      : summary.idle
        ? "inactiva"
        : summary.slice.some((message: any) => message.type === "user" || message.type === "assistant")
          ? "en ejecución"
          : "inactiva (sin turnos)"
  lines.push(`Estado: ${status}`)
  if (summary.text) {
    lines.push(`Texto final:\n${summary.text.slice(0, MAX_TEXT)}`)
  } else {
    lines.push("Texto final: (sin texto)")
  }
  if (summary.tools.length) {
    lines.push(`Acciones (${summary.tools.length}):`)
    lines.push(summary.tools.map((tool) => toolLine(tool, false)).join("\n"))
  } else {
    lines.push("Acciones: (ninguna)")
  }
  if (summary.error) lines.push(`Error: ${compact(summary.error, 1_000)}`)
  if (summary.lastMessageID) lines.push(`Último mensaje: ${summary.lastMessageID}`)
  return lines.join("\n")
}

function permissionLine(request: any) {
  const resources = Array.isArray(request.resources) && request.resources.length ? request.resources.join(", ") : "(sin recursos)"
  const save = Array.isArray(request.save) && request.save.length ? ` | recordar: ${request.save.join(", ")}` : ""
  const metadata = request.metadata ? ` | metadata: ${compact(request.metadata, 160)}` : ""
  const message = request.message ? ` | ${compact(request.message, 200)}` : ""
  return `  · ${request.id} | ${request.action} | ${resources}${save}${metadata}${message}`
}

async function permissionHint(ctx: any, sessionID: string) {
  try {
    const pending = await ctx.permission.list({ sessionID })
    if (!pending.length) return ""
    return `\n\nPermisos pendientes (${pending.length}):\n${pending
      .slice(0, 5)
      .map(permissionLine)
      .join("\n")}\nUsa sessions.reply con el ID de la solicitud para aprobar o rechazar.`
  } catch {
    return ""
  }
}

async function waitForTurn(
  ctx: any,
  sessionID: string,
  anchorID: string | undefined,
  beforeCount: number,
  timeoutMs: number,
  signal?: AbortSignal,
  requireUser = false,
): Promise<TurnResult> {
  const deadline = Date.now() + timeoutMs
  let messages: any[] = []
  let startIndex = beforeCount
  while (true) {
    if (signal?.aborted) return { state: "aborted", messages, startIndex }
    try {
      messages = await ctx.session.context({ sessionID })
    } catch {
      // The session may be between states; retry until the deadline.
    }

    const anchorIndex = anchorID ? messages.findIndex((message) => message.id === anchorID) : -1
    if (anchorIndex >= 0) startIndex = anchorIndex + 1
    else if (messages.length >= beforeCount) startIndex = beforeCount
    else startIndex = 0

    const slice = messages.slice(startIndex)
    const userIndex = slice.findIndex((message) => message.type === "user")
    const idleIndex = slice.findIndex(
      (message, index) => message.type === "idle" && (!requireUser || (userIndex >= 0 && index > userIndex)),
    )
    if (idleIndex >= 0) return { state: "idle", messages, startIndex, idle: slice[idleIndex] }
    if (Date.now() >= deadline) return { state: "timeout", messages, startIndex }
    await sleep(POLL_MS)
  }
}

async function waitForPrompt(
  ctx: any,
  sessionID: string,
  anchorID: string | undefined,
  beforeCount: number,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const messages = await ctx.session.context({ sessionID })
      const anchorIndex = anchorID ? messages.findIndex((message: any) => message.id === anchorID) : -1
      const startIndex = anchorIndex >= 0 ? anchorIndex + 1 : beforeCount
      if (messages.slice(startIndex).some((message: any) => message.type === "user")) return true
    } catch {
      // Retry until the deadline.
    }
    await sleep(150)
  }
  return false
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export default Plugin.define({
  id: "session-bridge",
  async setup(ctx) {
    const configured = ctx.options?.language
    const stored = await ctx.storage?.get("language").catch(() => undefined)
    let language: Lang =
      stored === "es" || stored === "en"
        ? stored
        : configured === "es" || configured === "en"
          ? configured
          : "en"

    const localized = (definition: any) => ({
      ...definition,
      execute: async (input: any, context: any) => {
        const result = await definition.execute(input, context)
        if (result && typeof result.content === "string") {
          return { ...result, content: localize(result.content, language) }
        }
        return result
      },
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "sessions",
        description: "Open, observe, and control other OpenCode sessions",
      })

      editor.add(localized({
        name: "open",
        description:
          "Create a NEW OpenCode session in the current directory, send it a message, and wait for its turn. Returns the final state, response text, and actions (tools) performed. Inherits the current session's model unless another one is specified.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Initial message to send to the new session." },
            title: { type: "string", description: "Session title. If omitted, it is derived from the message." },
            agent: { type: "string", description: "Agent ID. Defaults to build." },
            model: { type: "string", description: "Model in provider/model format. Defaults to this session's model." },
            wait: {
              type: "boolean",
              description:
                "If true (default), wait for the turn to finish. Use false to keep working in the background and check later with sessions.status.",
            },
            timeoutMs: { type: "integer", description: "Maximum wait time in milliseconds. Defaults to 120000." },
            permissions: {
              type: "array",
              description: "Optional permission rules for the new session.",
              items: {
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
              },
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any, context: any) => {
          const data = input as OpenInput
          try {
            let fallback: any
            if (context?.sessionID) {
              const caller = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
              fallback = modelRef(caller?.model)
            }
            if (!fallback) {
              const preferred = await ctx.model.default().catch(() => undefined)
              fallback = modelRef(preferred)
            }

            const created = await ctx.session.create({
              title: titleFromPrompt(data.prompt, data.title),
              agent: data.agent ?? "build",
              model: parseModel(data.model) ?? fallback,
              permissions: data.permissions,
            } as any)

            const before = await ctx.session.context({ sessionID: created.id }).catch(() => [])
            const anchorID = before[before.length - 1]?.id
            await ctx.session.prompt({ sessionID: created.id, text: data.prompt })
            await waitForPrompt(ctx, created.id, anchorID, before.length)
            const header = `Sesión creada: ${created.id}\nTítulo: ${created.title ?? titleFromPrompt(data.prompt, data.title)}`

            if (data.wait === false) {
              return { content: `${header}\n\nMensaje enviado. La sesión sigue en segundo plano.` }
            }

            const timeoutMs = data.timeoutMs ?? DEFAULT_TIMEOUT_MS
            const turn = await waitForTurn(
              ctx,
              created.id,
              anchorID,
              before.length,
              timeoutMs,
              context?.signal,
              true,
            )
            const summary = summarizeTurn(turn.messages, turn.startIndex)
            const state =
              turn.state === "idle" ? undefined : turn.state === "timeout" ? "sigue en ejecución (tiempo agotado)" : "espera cancelada"
            let content = formatSummary(header, summary, state)
            if (turn.state !== "idle") content += await permissionHint(ctx, created.id)
            return { content }
          } catch (error) {
            return { content: `No se pudo abrir la sesión: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "send",
        description:
          "Send a message to an existing OpenCode session. Can switch its agent or model, wait for the turn, and return the state, response, and actions performed.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Target session ID, for example ses_abc123." },
            prompt: { type: "string", description: "Message to send to the session." },
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
            timeoutMs: { type: "integer", description: "Maximum wait time in milliseconds. Defaults to 120000." },
          },
          required: ["sessionID", "prompt"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any, context: any) => {
          const data = input as SendInput
          try {
            const session = await ctx.session.get({ sessionID: data.sessionID })
            const model = parseModel(data.model)
            if (model) await ctx.session.switchModel({ sessionID: data.sessionID, model })
            if (data.agent) await ctx.session.switchAgent({ sessionID: data.sessionID, agent: data.agent })

            const before = await ctx.session.context({ sessionID: data.sessionID }).catch(() => [])
            const anchorID = before[before.length - 1]?.id
            await ctx.session.prompt({
              sessionID: data.sessionID,
              text: data.prompt,
              delivery: data.delivery,
            })
            await waitForPrompt(ctx, data.sessionID, anchorID, before.length)
            const header = `Sesión: ${session.id}\nTítulo: ${session.title ?? "(sin título)"}`

            if (data.wait === false) {
              return { content: `${header}\n\nMensaje enviado. La sesión sigue en segundo plano.` }
            }

            const timeoutMs = data.timeoutMs ?? DEFAULT_TIMEOUT_MS
            const turn = await waitForTurn(
              ctx,
              data.sessionID,
              anchorID,
              before.length,
              timeoutMs,
              context?.signal,
              true,
            )
            const summary = summarizeTurn(turn.messages, turn.startIndex)
            const state =
              turn.state === "idle" ? undefined : turn.state === "timeout" ? "sigue en ejecución (tiempo agotado)" : "espera cancelada"
            let content = formatSummary(header, summary, state)
            if (turn.state !== "idle") content += await permissionHint(ctx, data.sessionID)
            return { content }
          } catch (error) {
            return { content: `No se pudo enviar el mensaje: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "status",
        description:
          "Check right now whether a session is running or idle, its result, the last text it produced, recent tools, and the last message ID for reading further.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session to inspect." },
            recent: { type: "integer", description: "Number of recent actions to show. Defaults to 8." },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as StatusInput
          try {
            const session = await ctx.session.get({ sessionID: data.sessionID })
            const messages = await ctx.session.context({ sessionID: data.sessionID })
            const running = isRunning(session, messages)
            const idle = lastIdle(messages)
            const assistant = lastAssistant(messages)
            const text = assistantText(assistant)
            const recent = (data.recent ?? 8)
            const tools = messages.flatMap(toolsOf).slice(-recent)
            let pending: any[] = []
            try {
              pending = await ctx.permission.list({ sessionID: data.sessionID })
            } catch {
              pending = []
            }

            const lines = [
              `Sesión: ${session.id}`,
              `Título: ${session.title ?? "(sin título)"}`,
              `Estado: ${running ? "en ejecución" : "inactiva"}`,
              `Resultado: ${idle?.outcome ?? session.outcome ?? "(desconocido)"}`,
              `Última actualización: ${session.time?.updated ? new Date(session.time.updated).toISOString() : "(desconocida)"}`,
              `Último texto: ${text ? text.slice(0, MAX_TEXT) : "(sin texto)"}`,
            ]
            if (tools.length) {
              lines.push(`Acciones recientes (${tools.length}):`)
              lines.push(tools.map((tool) => toolLine(tool, false)).join("\n"))
            } else {
              lines.push("Acciones recientes: (ninguna)")
            }
            if (pending.length) {
              lines.push(`Permisos pendientes (${pending.length}):`)
              lines.push(pending.slice(0, 8).map(permissionLine).join("\n"))
              lines.push("Usa sessions.reply con el ID de la solicitud para responder.")
            }
            const error = assistant?.error?.message ?? idle?.error?.message
            if (error) lines.push(`Error: ${compact(error, 1_000)}`)
            if (messages.length) lines.push(`Último mensaje: ${messages[messages.length - 1].id}`)
            return { content: lines.join("\n") }
          } catch (error) {
            return { content: `No se pudo consultar la sesión: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "permissions",
        description:
          "List pending permission requests for a session, with their action, resources, and request ID. Use sessions.reply to approve or reject them.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session whose pending permissions should be listed." },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as PermissionsInput
          try {
            const pending = await ctx.permission.list({ sessionID: data.sessionID })
            if (!pending.length) {
              return { content: `Sesión ${data.sessionID}: no hay solicitudes de permiso pendientes.` }
            }
            return {
              content: `Permisos pendientes (${pending.length}):\n${pending
                .map(permissionLine)
                .join("\n")}\n\nUsa sessions.reply con sessionID y requestID para responder.`,
            }
          } catch (error) {
            return { content: `No se pudieron consultar los permisos: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "reply",
        description:
          "Approve or reject a pending permission request. Use once to allow this time, always to allow and save the rule, or reject to deny it.",
        input: {
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
          },
          required: ["sessionID", "requestID", "decision"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as ReplyInput
          try {
            const payload: any = {
              sessionID: data.sessionID,
              requestID: data.requestID,
              decision: data.decision,
            }
            if (data.message) payload.message = data.message
            await ctx.permission.reply(payload)
            const labels = {
              once: "aprobada una vez",
              always: "aprobada y recordada",
              reject: "rechazada",
            }
            return { content: `Solicitud ${data.requestID}: ${labels[data.decision]}.` }
          } catch (error) {
            return { content: `No se pudo responder al permiso: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "read",
        description:
          "Read a session's recent transcript: user messages, assistant text, executed tools (with their input/output), and the result of each turn.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session to read." },
            limit: { type: "integer", description: "Number of recent messages. Defaults to 30." },
            afterMessageID: {
              type: "string",
              description: "Optional: return only messages after this ID.",
            },
            includeTools: { type: "boolean", description: "Include executed tools. Defaults to true." },
            includeToolOutput: {
              type: "boolean",
              description: "Include an excerpt of each tool's output. Defaults to false.",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as ReadInput
          try {
            const messages = await ctx.session.context({ sessionID: data.sessionID })
            let selected = messages
            if (data.afterMessageID) {
              const index = messages.findIndex((message) => message.id === data.afterMessageID)
              if (index >= 0) selected = messages.slice(index + 1)
            } else if (data.limit && data.limit > 0) {
              selected = messages.slice(-data.limit)
            }

            const includeTools = data.includeTools !== false
            const lines: string[] = []
            for (const message of selected) {
              if (message.type === "user" && message.text) {
                lines.push(`Usuario: ${message.text.slice(0, MAX_TEXT)}`)
              } else if (message.type === "assistant") {
                const text = assistantText(message)
                if (text) lines.push(`Asistente: ${text.slice(0, MAX_TEXT)}`)
                if (includeTools) {
                  for (const tool of toolsOf(message)) lines.push(toolLine(tool, data.includeToolOutput === true))
                }
                if (message.error?.message) lines.push(`Asistente [error]: ${compact(message.error.message, 1_000)}`)
              } else if (message.type === "idle") {
                const error = message.error?.message ? ` (${compact(message.error.message, 500)})` : ""
                lines.push(`— Fin de turno: ${message.outcome}${error}`)
              }
            }

            let content = lines.join("\n\n") || "(sin mensajes)"
            if (content.length > MAX_TOTAL) content = `${content.slice(0, MAX_TOTAL)}\n… (transcripción recortada)`
            if (messages.length) content += `\n\nÚltimo mensaje: ${messages[messages.length - 1].id}`
            return { content }
          } catch (error) {
            return { content: `No se pudo leer la sesión: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "wait",
        description:
          "Wait for the session to finish the current turn (or the last started turn) and return its result, final text, and actions. If it is already idle, returns immediately.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session to wait for." },
            timeoutMs: { type: "integer", description: "Maximum wait time in milliseconds. Defaults to 120000." },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any, context: any) => {
          const data = input as WaitInput
          try {
            let session = await ctx.session.get({ sessionID: data.sessionID })
            const timeoutMs = data.timeoutMs ?? DEFAULT_TIMEOUT_MS
            let messages = await ctx.session.context({ sessionID: data.sessionID })
            let running = isRunning(session, messages)
            let startIndex = 0
            let turn: TurnResult

            if (!running && !lastUser(messages)) {
              const anchorID = messages[messages.length - 1]?.id
              const admitted = await waitForPrompt(ctx, data.sessionID, anchorID, messages.length, 3_000)
              if (admitted) {
                session = await ctx.session.get({ sessionID: data.sessionID })
                messages = await ctx.session.context({ sessionID: data.sessionID })
                running = isRunning(session, messages)
              }
            }

            if (running) {
              const anchorID = messages[messages.length - 1]?.id
              turn = await waitForTurn(
                ctx,
                data.sessionID,
                anchorID,
                messages.length,
                timeoutMs,
                context?.signal,
                false,
              )
              messages = turn.messages
              const user = lastUser(messages)
              startIndex = user ? messages.findIndex((message) => message.id === user.id) : turn.startIndex
            } else {
              const user = lastUser(messages)
              if (!user) {
                const idle = lastIdle(messages)
                return {
                  content: `Sesión: ${session.id}\nTítulo: ${session.title ?? "(sin título)"}\nEstado: inactiva\nResultado: ${
                    idle?.outcome ?? session.outcome ?? "(desconocido)"
                  }\nNo hay turnos pendientes.`,
                }
              }
              startIndex = messages.findIndex((message) => message.id === user.id)
              turn = { state: "idle", messages, startIndex, idle: lastIdle(messages) }
            }

            const summary = summarizeTurn(turn.messages, Math.max(0, startIndex))
            const state =
              turn.state === "idle" ? undefined : turn.state === "timeout" ? "sigue en ejecución (tiempo agotado)" : "espera cancelada"
            let content = formatSummary(
              `Sesión: ${session.id}\nTítulo: ${session.title ?? "(sin título)"}`,
              summary,
              state,
            )
            if (turn.state !== "idle") content += await permissionHint(ctx, data.sessionID)
            return { content }
          } catch (error) {
            return { content: `No se pudo esperar la sesión: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "interrupt",
        description: "Interrupt a session's running turn.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session to interrupt." },
            resume: {
              type: "boolean",
              description: "If true, resume pending messages. Defaults to false.",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as InterruptInput
          try {
            const result = await ctx.session.interrupt({ sessionID: data.sessionID, resume: data.resume ?? false })
            return {
              content: `Sesión ${data.sessionID}: ${result?.interrupted ? "interrumpida" : "no había un turno activo"}.`,
            }
          } catch (error) {
            return { content: `No se pudo interrumpir la sesión: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "list",
        description:
          "List OpenCode sessions in the current directory, with their ID, title, state, result, and last update.",
        input: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Maximum number of sessions. Defaults to 10." },
            search: { type: "string", description: "Text to filter by title." },
            directory: { type: "string", description: "Directory whose sessions are listed. Defaults to the current one." },
          },
          required: [],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as ListInput
          try {
            const page = await ctx.session.list({
              directory: data.directory ?? ctx.location.directory,
              limit: data.limit ?? 10,
              search: data.search,
            })
            if (!page.data.length) return { content: "No hay sesiones." }
            const lines = page.data.map((session: any) => {
              const updated = session.time?.updated ? new Date(session.time.updated).toISOString() : "?"
              const busy = session.time?.busy && (!session.time?.idle || session.time.busy > session.time.idle)
              const state = busy ? "en ejecución" : "inactiva"
              const outcome = session.outcome ? ` (${session.outcome})` : ""
              const parent = session.parentID ? ` | padre: ${session.parentID}` : ""
              return `- ${session.id} | ${session.title ?? "(sin título)"} | ${state}${outcome} | ${updated}${parent}`
            })
            return { content: `Sesiones:\n${lines.join("\n")}` }
          } catch (error) {
            return { content: `No se pudieron listar las sesiones: ${formatError(error)}` }
          }
        },
      }))

      editor.add(localized({
        name: "language",
        description:
          "Get or set the output language of this plugin. Use es for Spanish or en for English. The setting persists across sessions.",
        input: {
          type: "object",
          properties: {
            language: {
              type: "string",
              enum: ["es", "en"],
              description: "Output language: es (Spanish) or en (English). Omit to read the current setting.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input: any) => {
          const data = input as LanguageInput
          if (data.language === "es" || data.language === "en") {
            language = data.language
            await ctx.storage?.set("language", language).catch(() => undefined)
            return {
              content: language === "es" ? "Idioma de salida: español." : "Output language: English.",
            }
          }
          return {
            content:
              language === "es"
                ? 'Idioma de salida actual: español. Usa sessions.language con language: "en" para cambiarlo.'
                : 'Current output language: English. Use sessions.language with language: "es" to change it.',
          }
        },
      }))
    })
  },
})

export {
  parseModel,
  modelRef,
  titleFromPrompt,
  compact,
  assistantText,
  lastAssistant,
  lastIdle,
  lastUser,
  isRunning,
  toolsOf,
  toolLine,
  summarizeTurn,
  formatSummary,
  permissionLine,
  localize,
  formatError,
}
