import { t } from "./i18n.ts"
import type {
  Lang,
  MessageLike,
  PermissionLike,
  SessionTimeLike,
  ToolPartLike,
} from "./types.ts"

export const DEFAULT_MAX_OUTPUT = 20_000
export const DEFAULT_MAX_TEXT = 4_000
export const DEFAULT_MAX_TOOLS = 40
export const DEFAULT_MAX_TOOL_LINE = 500
export const DEFAULT_MAX_PERMISSIONS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * Truncates by Unicode code points, never splitting a surrogate pair.
 */
export function truncateCodePoints(text: string, max: number, marker = "…"): string {
  if (max <= 0) return ""
  const points = Array.from(text)
  if (points.length <= max) return text
  const markerPoints = Array.from(marker)
  if (max <= markerPoints.length) return points.slice(0, max).join("")
  return points.slice(0, max - markerPoints.length).join("") + marker
}

export function fitBudget(text: string, max: number, marker = "…"): string {
  if (max <= 0) return ""
  if (codePointLength(text) <= max) return text
  const markerLength = codePointLength(marker)
  if (max <= markerLength) return truncateCodePoints(text, max, "")
  return truncateCodePoints(text, max - markerLength, "") + marker
}

export function capOutput(text: string, max: number, lang: Lang = "en"): string {
  return fitBudget(text, max, t(lang, "outputTruncated"))
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "[unserializable]"
  }
}

export function compact(value: unknown, max = 200): string {
  if (value === undefined || value === null) return ""
  let text: string
  if (typeof value === "string") {
    text = value
  } else if (typeof value === "bigint") {
    text = value.toString()
  } else {
    try {
      const json = JSON.stringify(value)
      text = typeof json === "string" ? json : safeString(value)
    } catch {
      text = safeString(value)
    }
  }
  if (!text || text === "{}") return ""
  text = text.replace(/\s+/g, " ").trim()
  return truncateCodePoints(text, max)
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error)
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    const message = typeof record.message === "string" ? record.message : undefined
    const status = typeof record.status === "number" ? record.status : undefined
    const response = record.response
    const body =
      isRecord(response) && typeof response.body === "string" ? compact(response.body, 500) : undefined
    const fallback = message ?? compact(error, 500)
    const parts = [fallback]
    if (status !== undefined) parts.push(`status ${status}`)
    if (body) parts.push(body)
    return parts.filter(Boolean).join(" | ") || "Unknown error"
  }
  return error === undefined || error === null ? "Unknown error" : safeString(error)
}

export function parseModel(value?: string): { providerID: string; id: string } | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const providerID = trimmed.slice(0, slash)
  const id = trimmed.slice(slash + 1)
  if (/\s/.test(providerID) || /\s/.test(id)) return undefined
  return { providerID, id }
}

export function modelRef(value: unknown): { providerID: string; id: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const providerID = typeof record.providerID === "string" ? record.providerID.trim() : ""
  const rawID =
    typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : ""
  const id = rawID.trim()
  if (!providerID || !id) return undefined
  return { providerID, id }
}

export function titleFromPrompt(prompt: string, title?: string, fallback = "Nueva sesión"): string {
  if (title?.trim()) return truncateCodePoints(title.trim(), 200)
  const firstLine = prompt.trim().split(/\r?\n/)[0] || fallback
  return truncateCodePoints(firstLine, 60, "...")
}

function isContentPart(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

export function assistantText(message: MessageLike | undefined): string | undefined {
  if (!message || message.type !== "assistant") return undefined
  const text = (message.content ?? [])
    .filter(isContentPart)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
  return text || undefined
}

export function reasoningText(message: MessageLike | undefined): string | undefined {
  if (!message || message.type !== "assistant") return undefined
  const text = (message.content ?? [])
    .filter(isContentPart)
    .filter((part) => part.type === "reasoning" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
  return text || undefined
}

export function lastAssistant(messages: MessageLike[]): MessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "assistant") return messages[index]
  }
  return undefined
}

export function lastIdle(messages: MessageLike[]): MessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "idle") return messages[index]
  }
  return undefined
}

export function lastUser(messages: MessageLike[]): MessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "user") return messages[index]
  }
  return undefined
}

function isRelevantTurnMessage(message: MessageLike | undefined): boolean {
  return message?.type === "user" || message?.type === "assistant" || message?.type === "compaction"
}

/**
 * State detection based on session timestamps first, then relevant transcript
 * messages. Control messages (agent/model switches, system, skill, shell) are
 * deliberately ignored so an idle session does not look busy forever.
 */
export function isRunning(session: SessionTimeLike | undefined, messages: MessageLike[]): boolean {
  const busy = session?.time?.busy
  const idle = session?.time?.idle
  if (typeof busy === "number" && (typeof idle !== "number" || busy > idle)) return true
  if (typeof idle === "number" && (typeof busy !== "number" || idle >= busy)) return false
  if (messages.length === 0) return false

  let lastIdleIndex = -1
  let lastRelevantIndex = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message?.type === "idle") lastIdleIndex = index
    if (isRelevantTurnMessage(message)) lastRelevantIndex = index
  }
  if (lastRelevantIndex < 0) return false
  return lastRelevantIndex > lastIdleIndex
}

export function toolsOf(message: MessageLike | undefined): ToolPartLike[] {
  if (!message || message.type !== "assistant") return []
  return (message.content ?? []).filter(
    (part): part is ToolPartLike => isRecord(part) && part.type === "tool",
  )
}

export type ToolLineOptions = {
  maxInputChars?: number
  maxErrorChars?: number
  maxOutputChars?: number
  maxLine?: number
}

export function toolLine(tool: ToolPartLike, includeOutput: boolean, options: ToolLineOptions = {}): string {
  const state = tool.state ?? {}
  const status = state.status ?? "unknown"
  const input = compact(state.input, options.maxInputChars ?? 220)
  let line = `  · ${tool.name ?? "tool"} [${status}]`
  if (input) line += ` ${input}`
  if (state.status === "error" && state.error?.message) {
    line += ` → error: ${compact(state.error.message, options.maxErrorChars ?? 300)}`
  }
  if (includeOutput && Array.isArray(state.content)) {
    const output = state.content
      .filter(isRecord)
      .map((part) =>
        part.type === "text" && typeof part.text === "string"
          ? part.text
          : part.type === "file" && typeof part.uri === "string"
            ? part.uri
            : "",
      )
      .filter(Boolean)
      .join("\n")
    if (output) line += ` → ${compact(output, options.maxOutputChars ?? 400)}`
  }
  return options.maxLine ? truncateCodePoints(line, options.maxLine) : line
}

export function summarizeTurn(messages: MessageLike[], startIndex = 0, includeOutput = false) {
  const slice = messages.slice(startIndex)
  const user = slice.find((message) => message.type === "user")
  const assistant = lastAssistant(slice)
  const idle = lastIdle(slice)
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
    includeOutput,
  }
}

export type Summary = ReturnType<typeof summarizeTurn>

export type SummaryOptions = {
  lang?: Lang
  state?: string
  maxOutputChars?: number
  maxTextChars?: number
  maxTools?: number
  maxToolLine?: number
  maxPermissions?: number
  promptMessageID?: string
  lastError?: string
  pendingPermissions?: PermissionLike[]
}

export function formatSummary(title: string, summary: Summary, options: SummaryOptions = {}): string {
  const lang = options.lang ?? "es"
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT
  const maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS
  const maxToolLine = options.maxToolLine ?? DEFAULT_MAX_TOOL_LINE
  const maxPermissions = options.maxPermissions ?? DEFAULT_MAX_PERMISSIONS
  const textBudget = Math.min(maxTextChars, Math.max(200, Math.floor(maxOutputChars / 3)))

  const lines = [title]
  if (summary.user?.text) {
    lines.push(`${t(lang, "messageSent")}: ${compact(summary.user.text, 500)}`)
  }

  const status =
    options.state ??
    (summary.outcome
      ? `${t(lang, "idle")} (${summary.outcome})`
      : summary.idle
        ? t(lang, "idle")
        : summary.slice.some(isRelevantTurnMessage)
          ? t(lang, "running")
          : t(lang, "noTurns"))
  lines.push(`${t(lang, "state")}: ${status}`)

  if (summary.text) {
    lines.push(`${t(lang, "finalText")}:\n${truncateCodePoints(summary.text, textBudget)}`)
  } else {
    lines.push(`${t(lang, "finalText")}: ${t(lang, "noText")}`)
  }

  if (summary.tools.length) {
    const omitted = Math.max(0, summary.tools.length - maxTools)
    const shown = omitted > 0 ? summary.tools.slice(-maxTools) : summary.tools
    lines.push(t(lang, "actionsCount", { count: summary.tools.length }))
    if (omitted > 0) lines.push(t(lang, "actionsOmitted", { count: omitted }))
    lines.push(shown.map((tool) => toolLine(tool, false, { maxLine: maxToolLine })).join("\n"))
  } else {
    lines.push(`${t(lang, "actions")}: ${t(lang, "none")}`)
  }

  if (summary.error) lines.push(`${t(lang, "error")}: ${compact(summary.error, 1_000)}`)
  if (options.lastError && options.lastError !== summary.error) {
    lines.push(`${t(lang, "error")}: ${compact(options.lastError, 1_000)}`)
  }
  if (summary.lastMessageID) lines.push(`${t(lang, "lastMessage")}: ${summary.lastMessageID}`)
  if (options.promptMessageID) {
    lines.push(`${t(lang, "promptMessageID")}: ${options.promptMessageID}`)
  }

  if (options.pendingPermissions?.length) {
    const pending = options.pendingPermissions.slice(0, maxPermissions)
    lines.push(t(lang, "pendingPermissionsCount", { count: options.pendingPermissions.length }))
    lines.push(pending.map((request) => permissionLine(request, lang)).join("\n"))
    lines.push(t(lang, "replyHint"))
  }

  return fitBudget(lines.join("\n"), maxOutputChars)
}

export function permissionLine(request: PermissionLike, lang: Lang = "es"): string {
  const resources =
    Array.isArray(request.resources) && request.resources.length
      ? request.resources.join(", ")
      : t(lang, "noResources")
  const save =
    Array.isArray(request.save) && request.save.length
      ? ` | ${t(lang, "remember")}: ${request.save.join(", ")}`
      : ""
  const metadata = request.metadata ? ` | metadata: ${compact(request.metadata, 160)}` : ""
  const message = request.message ? ` | ${compact(request.message, 200)}` : ""
  return `  · ${request.id} | ${request.action} | ${resources}${save}${metadata}${message}`
}

/**
 * Returns the most recent `count` tools without flat-mapping the whole
 * transcript. Useful for `status`, which must stay compact with 500+ messages.
 */
export function collectRecentTools(messages: MessageLike[], count: number): ToolPartLike[] {
  if (count <= 0) return []
  const result: ToolPartLike[] = []
  for (let index = messages.length - 1; index >= 0 && result.length < count; index--) {
    const tools = toolsOf(messages[index])
    for (let toolIndex = tools.length - 1; toolIndex >= 0 && result.length < count; toolIndex--) {
      result.push(tools[toolIndex])
    }
  }
  return result.reverse()
}

export type TranscriptOptions = {
  lang: Lang
  limit: number
  afterMessageID?: string
  includeTools: boolean
  includeToolOutput: boolean
  includeReasoning: boolean
  maxOutputChars: number
  maxTextChars: number
  maxToolLine: number
}

function fileLine(file: unknown, lang: Lang): string | undefined {
  if (!isRecord(file)) return undefined
  const name = typeof file.name === "string" ? file.name : undefined
  const description = typeof file.description === "string" ? file.description : undefined
  const directURI = typeof file.uri === "string" ? file.uri : undefined
  const source = isRecord(file.source) ? file.source : undefined
  const sourceURI = source && typeof source.uri === "string" ? source.uri : undefined
  const uri = directURI ?? sourceURI
  if (!name && !description && !uri) return undefined
  const label = name ?? description ?? uri
  return `${t(lang, "files")}: ${label}${uri && uri !== label ? ` (${uri})` : ""}`
}

/**
 * Builds a bounded transcript. The complete transcript is still read once
 * because 2.2.5 does not expose paginated message reads from the plugin
 * context, but only the selected tail is rendered.
 */
export function renderTranscript(messages: MessageLike[], options: TranscriptOptions): string {
  const {
    lang,
    limit,
    afterMessageID,
    includeTools,
    includeToolOutput,
    includeReasoning,
    maxOutputChars,
    maxTextChars,
    maxToolLine,
  } = options

  let selected: MessageLike[]
  let warning: string | undefined
  if (afterMessageID) {
    const index = messages.findIndex((message) => message.id === afterMessageID)
    if (index >= 0) {
      selected = messages.slice(index + 1)
    } else {
      warning = t(lang, "afterNotFound", { id: afterMessageID, limit })
      selected = messages.slice(-limit)
    }
  } else {
    selected = messages.slice(-limit)
  }

  let content = ""
  let truncated = false
  const append = (block: string): boolean => {
    if (!block) return true
    const addition = content ? `\n\n${block}` : block
    const remaining = maxOutputChars - codePointLength(content)
    if (codePointLength(addition) > remaining) {
      const available = Math.max(0, remaining - 1)
      if (available > 0) content += truncateCodePoints(addition, available, "…")
      truncated = true
      return false
    }
    content += addition
    return true
  }

  if (warning) append(warning)

  for (const message of selected) {
    if (message.type === "user") {
      const text = message.text ? truncateCodePoints(message.text, maxTextChars) : ""
      const files = (message.files ?? []).map((file) => fileLine(file, lang)).filter(Boolean)
      const block = [`${t(lang, "user")}: ${text}`, ...files].filter(Boolean).join("\n")
      if (!append(block)) break
    } else if (message.type === "assistant") {
      const parts: string[] = []
      const text = assistantText(message)
      if (text) parts.push(`${t(lang, "assistant")}: ${truncateCodePoints(text, maxTextChars)}`)
      if (includeReasoning) {
        const reasoning = reasoningText(message)
        if (reasoning) {
          parts.push(`${t(lang, "reasoning")}: ${truncateCodePoints(reasoning, maxTextChars)}`)
        }
      }
      if (includeTools) {
        for (const tool of toolsOf(message)) {
          parts.push(toolLine(tool, includeToolOutput, { maxLine: maxToolLine }))
        }
      }
      if (message.error?.message) {
        parts.push(`${t(lang, "assistantError")}: ${compact(message.error.message, 1_000)}`)
      }
      if (!append(parts.join("\n"))) break
    } else if (message.type === "idle") {
      const error = message.error?.message ? ` (${compact(message.error.message, 500)})` : ""
      if (!append(`${t(lang, "endOfTurn")}: ${message.outcome ?? ""}${error}`)) break
    } else if (message.type === "shell") {
      const output = message.output?.output ? `\n${truncateCodePoints(message.output.output, maxTextChars)}` : ""
      if (!append(`${t(lang, "shell")}: ${message.command ?? ""} [${message.status ?? "unknown"}]${output}`)) {
        break
      }
    } else if (message.type === "synthetic") {
      if (!append(`${t(lang, "synthetic")}: ${truncateCodePoints(message.text ?? "", maxTextChars)}`)) {
        break
      }
    } else if (message.type === "compaction") {
      const detail = message.summary ?? message.error?.message ?? ""
      if (!append(`${t(lang, "compaction")} [${message.status ?? "unknown"}]: ${compact(detail, maxTextChars)}`)) {
        break
      }
    }
  }

  if (!content && !warning) content = t(lang, "noMessages")
  if (truncated) {
    const marker = `\n\n${t(lang, "transcriptTruncated")}`
    content = fitBudget(content + marker, maxOutputChars, t(lang, "outputTruncated"))
  }
  if (messages.length) {
    const last = `\n\n${t(lang, "lastMessage")}: ${messages[messages.length - 1]?.id ?? ""}`
    if (codePointLength(content) + codePointLength(last) <= maxOutputChars) content += last
  }
  return fitBudget(content, maxOutputChars, t(lang, "outputTruncated"))
}
