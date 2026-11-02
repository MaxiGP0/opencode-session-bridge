import { Plugin } from "@opencode/plugin"

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_MS = 250
const MAX_TEXT = 4_000
const MAX_TOTAL = 20_000

type OpenInput = {
  prompt: string
  title?: string
  agent?: string
  model?: string
  wait?: boolean
  timeoutMs?: number
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
      // La sesión puede estar entre estados; se reintenta hasta el límite.
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
      const anchorIndex = anchorID ? messages.findIndex((message) => message.id === anchorID) : -1
      const startIndex = anchorIndex >= 0 ? anchorIndex + 1 : beforeCount
      if (messages.slice(startIndex).some((message) => message.type === "user")) return true
    } catch {
      // Se reintenta hasta el límite.
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
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "sessions",
        description: "Abrir, observar y controlar otras sesiones de OpenCode",
      })

      editor.add({
        name: "open",
        description:
          "Crea una sesión NUEVA de OpenCode en el directorio actual, le envía un mensaje y espera su turno. Devuelve el estado final, el texto de la respuesta y las acciones (herramientas) realizadas. Hereda el modelo de la sesión actual si no se indica otro.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Mensaje inicial que se enviará a la sesión nueva." },
            title: { type: "string", description: "Título de la sesión. Si se omite, se deriva del mensaje." },
            agent: { type: "string", description: "ID del agente. Por defecto build." },
            model: { type: "string", description: "Modelo en formato provider/model. Por defecto, el de esta sesión." },
            wait: {
              type: "boolean",
              description:
                "Si es true (por defecto), espera a que termine el turno. Usa false para seguir en segundo plano y consultar luego con sessions.status.",
            },
            timeoutMs: { type: "integer", description: "Tiempo máximo de espera en milisegundos. Por defecto 120000." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input, context) => {
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
            return { content: formatSummary(header, summary, state) }
          } catch (error) {
            return { content: `No se pudo abrir la sesión: ${formatError(error)}` }
          }
        },
      })

      editor.add({
        name: "send",
        description:
          "Envía un mensaje a una sesión de OpenCode existente. Puede cambiar su agente o modelo, esperar el turno y devolver el estado, la respuesta y las acciones realizadas.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID de la sesión destino, por ejemplo ses_abc123." },
            prompt: { type: "string", description: "Mensaje que se enviará a la sesión." },
            agent: { type: "string", description: "Opcional: cambia el agente de la sesión antes de enviar." },
            model: { type: "string", description: "Opcional: cambia el modelo (provider/model) antes de enviar." },
            delivery: {
              type: "string",
              enum: ["steer", "queue"],
              description: "steer (por defecto) interrumpe/guía el turno actual; queue espera su turno.",
            },
            wait: {
              type: "boolean",
              description: "Si es true (por defecto), espera a que termine el turno. Usa false para no bloquear.",
            },
            timeoutMs: { type: "integer", description: "Tiempo máximo de espera en milisegundos. Por defecto 120000." },
          },
          required: ["sessionID", "prompt"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input, context) => {
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
            return { content: formatSummary(header, summary, state) }
          } catch (error) {
            return { content: `No se pudo enviar el mensaje: ${formatError(error)}` }
          }
        },
      })

      editor.add({
        name: "status",
        description:
          "Consulta ahora mismo si una sesión está en ejecución o inactiva, su resultado, el último texto que produjo, las herramientas recientes y el ID del último mensaje para seguir leyendo.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID de la sesión a consultar." },
            recent: { type: "integer", description: "Número de acciones recientes a mostrar. Por defecto 8." },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input) => {
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
            const error = assistant?.error?.message ?? idle?.error?.message
            if (error) lines.push(`Error: ${compact(error, 1_000)}`)
            if (messages.length) lines.push(`Último mensaje: ${messages[messages.length - 1].id}`)
            return { content: lines.join("\n") }
          } catch (error) {
            return { content: `No se pudo consultar la sesión: ${formatError(error)}` }
          }
        },
      })

      editor.add({
        name: "read",
        description:
          "Lee la transcripción reciente de una sesión: mensajes del usuario, texto del asistente, herramientas ejecutadas (con su entrada/salida) y el resultado de cada turno.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID de la sesión a leer." },
            limit: { type: "integer", description: "Cantidad de mensajes recientes. Por defecto 30." },
            afterMessageID: {
              type: "string",
              description: "Opcional: devuelve solo los mensajes posteriores a este ID.",
            },
            includeTools: { type: "boolean", description: "Incluir herramientas ejecutadas. Por defecto true." },
            includeToolOutput: {
              type: "boolean",
              description: "Incluir un extracto de la salida de cada herramienta. Por defecto false.",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input) => {
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
      })

      editor.add({
        name: "wait",
        description:
          "Espera a que la sesión termine el turno actual (o el último turno iniciado) y devuelve su resultado, texto final y acciones. Si ya está inactiva, responde de inmediato.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID de la sesión a esperar." },
            timeoutMs: { type: "integer", description: "Tiempo máximo de espera en milisegundos. Por defecto 120000." },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input, context) => {
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
            return {
              content: formatSummary(
                `Sesión: ${session.id}\nTítulo: ${session.title ?? "(sin título)"}`,
                summary,
                state,
              ),
            }
          } catch (error) {
            return { content: `No se pudo esperar la sesión: ${formatError(error)}` }
          }
        },
      })

      editor.add({
        name: "interrupt",
        description: "Interrumpe el turno en ejecución de una sesión.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID de la sesión a interrumpir." },
            resume: {
              type: "boolean",
              description: "Si es true, reanuda los mensajes pendientes. Por defecto false.",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input) => {
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
      })

      editor.add({
        name: "list",
        description:
          "Lista las sesiones de OpenCode del directorio actual, con su ID, título, estado, resultado y última actualización.",
        input: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Número máximo de sesiones. Por defecto 10." },
            search: { type: "string", description: "Texto para filtrar por título." },
            directory: { type: "string", description: "Directorio cuyas sesiones se listan. Por defecto, el actual." },
          },
          required: [],
          additionalProperties: false,
        },
        options: { namespace: "sessions", codemode: true },
        execute: async (input) => {
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
      })
    })
  },
})
