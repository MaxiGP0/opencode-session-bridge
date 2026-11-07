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
export const DEFAULT_MAX_ERROR = 1_000
export const DEFAULT_MAX_TITLE = 500
export const DEFAULT_MAX_RESOURCES = 10
export const DEFAULT_MAX_RESOURCE_CHARS = 200

type BoundedJsonState = {
  parts: string[]
  length: number
  limit: number
  truncated: boolean
  path: WeakSet<object>
}

function boundedJsonPush(state: BoundedJsonState, value: string): void {
  if (state.truncated) return
  const remaining = state.limit - state.length
  if (value.length <= remaining) {
    state.parts.push(value)
    state.length += value.length
    return
  }
  if (remaining > 0) {
    state.parts.push(value.slice(0, remaining))
    state.length = state.limit
  }
  state.truncated = true
}

function boundedJsonValue(state: BoundedJsonState, value: unknown, depth: number): void {
  if (state.truncated) return
  if (depth > 6) {
    boundedJsonPush(state, "…")
    return
  }
  if (value === null) {
    boundedJsonPush(state, "null")
    return
  }
  const type = typeof value
  if (type === "string") {
    boundedJsonPush(state, JSON.stringify(truncateCodePoints(value as string, 240)))
    return
  }
  if (type === "number" || type === "boolean") {
    boundedJsonPush(state, String(value))
    return
  }
  if (type === "bigint") {
    boundedJsonPush(state, JSON.stringify((value as bigint).toString()))
    return
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    boundedJsonPush(state, "null")
    return
  }
  if (Array.isArray(value)) {
    boundedJsonPush(state, "[")
    const max = Math.min(value.length, 20)
    for (let index = 0; index < max; index++) {
      if (index > 0) boundedJsonPush(state, ",")
      boundedJsonValue(state, value[index], depth + 1)
    }
    if (value.length > max) boundedJsonPush(state, ",…")
    boundedJsonPush(state, "]")
    return
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    if (state.path.has(object)) {
      boundedJsonPush(state, '"[Circular]"')
      return
    }
    state.path.add(object)
    boundedJsonPush(state, "{")
    const keys = Object.keys(object)
    const max = Math.min(keys.length, 50)
    for (let index = 0; index < max; index++) {
      if (index > 0) boundedJsonPush(state, ",")
      const key = keys[index]
      boundedJsonPush(state, `${JSON.stringify(truncateCodePoints(key, 80))}:`)
      boundedJsonValue(state, object[key], depth + 1)
    }
    if (keys.length > max) boundedJsonPush(state, ',"…"')
    boundedJsonPush(state, "}")
    state.path.delete(object)
    return
  }
  boundedJsonPush(state, JSON.stringify(String(value)))
}

/**
 * JSON-like serializer with a hard character budget. Unlike JSON.stringify it
 * stops visiting arrays/objects/strings once the budget is exhausted, so a
 * multi-megabyte tool input cannot be materialized just to show 200 chars.
 */
function stringifyBounded(value: unknown, limit: number): string {
  const state: BoundedJsonState = {
    parts: [],
    length: 0,
    limit: Math.max(16, limit),
    truncated: false,
    path: new WeakSet(),
  }
  boundedJsonValue(state, value, 0)
  return state.parts.join("")
}

function compactString(value: string, max: number): string {
  const sourceLimit = Math.max(4_096, max * 8)
  const truncated = value.length > sourceLimit
  const source = truncated ? value.slice(0, sourceLimit) : value
  const normalized = source.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (!truncated) return truncateCodePoints(normalized, max)
  if (max <= 1) return "…"
  return `${truncateCodePoints(normalized, max - 1, "")}…`
}

export function compact(value: unknown, max = 200): string {
  if (value === undefined || value === null) return ""
  let text: string
  if (typeof value === "string") {
    text = compactString(value, max)
  } else if (typeof value === "bigint") {
    text = value.toString()
  } else {
    try {
      const json = stringifyBounded(value, Math.max(1_024, max * 8))
      text = json || safeString(value)
    } catch {
      text = safeString(value)
    }
  }
  if (!text || text === "{}") return ""
  if (typeof value !== "string") {
    text = text.replace(/\s+/g, " ").trim()
    text = truncateCodePoints(text, max)
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function codePointLength(value: string): number {
  let count = 0
  const len = value.length
  for (let index = 0; index < len; index++) {
    const high = value.charCodeAt(index)
    if (high >= 0xd800 && high <= 0xdbff && index + 1 < len) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) index++
    }
    count++
  }
  return count
}

function codeUnitIndexForPoints(
  text: string,
  maxPoints: number,
): { index: number; hasMore: boolean } {
  if (maxPoints <= 0) return { index: 0, hasMore: text.length > 0 }
  const len = text.length
  if (len <= maxPoints) return { index: len, hasMore: false }
  let index = 0
  let count = 0
  while (index < len && count < maxPoints) {
    const high = text.charCodeAt(index)
    if (high >= 0xd800 && high <= 0xdbff && index + 1 < len) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        index += 2
        count++
        continue
      }
    }
    index++
    count++
  }
  return { index, hasMore: index < len }
}

/**
 * Truncates by Unicode code points in O(max) time without allocating an array
 * for the full string, never splitting a surrogate pair.
 */
export function truncateCodePoints(text: string, max: number, marker = "…"): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  const probe = codeUnitIndexForPoints(text, max)
  if (!probe.hasMore) return text
  const markerLength = codePointLength(marker)
  if (max <= markerLength) return text.slice(0, probe.index)
  const cut = codeUnitIndexForPoints(text, max - markerLength)
  return text.slice(0, cut.index) + marker
}

export function fitBudget(text: string, max: number, marker = "…"): string {
  return truncateCodePoints(text, max, marker)
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

export function parseModel(
  value?: string,
): { providerID: string; id: string; variant?: string } | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const providerID = trimmed.slice(0, slash)
  const rest = trimmed.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash === 0 || hash === rest.length - 1) return undefined
  const id = hash > 0 ? rest.slice(0, hash) : rest
  const variant = hash > 0 ? rest.slice(hash + 1) : undefined
  if (!id || /\s/.test(providerID) || /\s/.test(id) || (variant !== undefined && /\s/.test(variant))) {
    return undefined
  }
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function modelRef(
  value: unknown,
): { providerID: string; id: string; variant?: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const providerID = typeof record.providerID === "string" ? record.providerID.trim() : ""
  const rawID =
    typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : ""
  const id = rawID.trim()
  const variant = typeof record.variant === "string" ? record.variant.trim() : ""
  if (!providerID || !id) return undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function sanitizeTitle(value: string): string {
  return value.replace(/\r?\n/g, " ").trim()
}

export function titleFromPrompt(
  prompt: string,
  title?: string,
  fallback = "Nueva sesión",
  maxTitleChars = 200,
): string {
  if (title?.trim()) return truncateCodePoints(sanitizeTitle(title), maxTitleChars)
  const firstLine = prompt.trim().split(/\r?\n/)[0] || fallback
  return truncateCodePoints(firstLine, 60, "...")
}

function isContentPart(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

export type TextExtraction = {
  text?: string
  length: number
  truncated: boolean
}

/**
 * Joins text parts until `maxChars` is reached. The full code-point length is
 * counted without building the joined string, so a 5 MB answer never becomes a
 * 5 MB allocation just to be truncated afterwards.
 */
export function extractText(
  message: MessageLike | undefined,
  partType: "text" | "reasoning",
  maxChars?: number,
): TextExtraction {
  if (!message || message.type !== "assistant") return { length: 0, truncated: false }
  const parts = (message.content ?? []).filter(isContentPart)
  let total = 0
  let hasPart = false
  let out = ""
  let outLength = 0
  let truncated = false
  for (const part of parts) {
    if (part.type !== partType || typeof part.text !== "string") continue
    const text = part.text as string
    const textLength = codePointLength(text)
    total += textLength + (hasPart ? 1 : 0)
    const separator = hasPart ? 1 : 0
    if (maxChars === undefined) {
      out += `${hasPart ? "\n" : ""}${text}`
      outLength += separator + textLength
    } else {
      const remaining = maxChars - outLength - separator
      if (remaining <= 0) {
        truncated = true
      } else {
        const piece = truncateCodePoints(text, remaining)
        const pieceLength = codePointLength(piece)
        if (pieceLength < textLength) truncated = true
        out += `${hasPart ? "\n" : ""}${piece}`
        outLength += separator + pieceLength
      }
    }
    hasPart = true
  }
  const trimmed = out.trim()
  return {
    text: trimmed || undefined,
    length: total,
    truncated: truncated || (maxChars !== undefined && total > maxChars),
  }
}

export function assistantText(message: MessageLike | undefined, maxChars?: number): string | undefined {
  return extractText(message, "text", maxChars).text
}

export function assistantTextInfo(message: MessageLike | undefined, maxChars?: number): TextExtraction {
  return extractText(message, "text", maxChars)
}

export function reasoningText(message: MessageLike | undefined, maxChars?: number): string | undefined {
  return extractText(message, "reasoning", maxChars).text
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

function messageTimestamp(message: MessageLike): number | undefined {
  const created = message.time?.created
  const completed = message.time?.completed
  if (typeof completed === "number" && typeof created === "number") {
    return Math.max(created, completed)
  }
  return completed ?? created
}

/**
 * State detection based on session timestamps first, then relevant transcript
 * messages. Control messages (agent/model switches, system, skill, shell) are
 * deliberately ignored so an idle session does not look busy forever.
 *
 * Timestamps and transcript messages can use slightly different clocks, so the
 * comparison keeps a one-second margin and only uses the transcript when one of
 * the session timestamps is missing.
 */
export function isRunning(session: SessionTimeLike | undefined, messages: MessageLike[]): boolean {
  const busy = session?.time?.busy
  const idle = session?.time?.idle
  const hasBusy = typeof busy === "number"
  const hasIdle = typeof idle === "number"

  if (hasBusy && hasIdle) {
    if (busy > idle) return true
    if (idle >= busy) return false
  }

  let lastTurnAt: number | undefined
  let lastIdleAt: number | undefined
  for (const message of messages) {
    const at = messageTimestamp(message)
    if (message.type === "idle") {
      if (at !== undefined && (lastIdleAt === undefined || at > lastIdleAt)) lastIdleAt = at
    } else if (isRelevantTurnMessage(message)) {
      if (at !== undefined && (lastTurnAt === undefined || at > lastTurnAt)) lastTurnAt = at
    }
  }

  if (hasIdle) {
    if (lastTurnAt !== undefined && lastTurnAt > idle) return true
    return false
  }
  if (hasBusy) {
    if (lastIdleAt !== undefined && lastIdleAt >= busy) return false
    if (lastTurnAt !== undefined && lastTurnAt >= busy) return true
    // An empty transcript cannot prove the busy mark is orphaned; keep the
    // historical behavior for a freshly created session.
    return messages.length === 0
  }

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
    const budget = options.maxOutputChars ?? 400
    let output = ""
    for (const part of state.content) {
      if (!isRecord(part)) continue
      const piece =
        part.type === "text" && typeof part.text === "string"
          ? part.text
          : part.type === "file" && typeof part.uri === "string"
            ? part.uri
            : ""
      if (!piece) continue
      if (output.length > budget * 8) {
        output += "…"
        break
      }
      output += `${output ? "\n" : ""}${piece}`
    }
    if (output) line += ` → ${compact(output, budget)}`
  }
  return options.maxLine ? truncateCodePoints(line, options.maxLine) : line
}

export function summarizeTurn(
  messages: MessageLike[],
  startIndex = 0,
  includeOutput = false,
  endIndex?: number,
  maxTools?: number,
  maxTextChars?: number,
) {
  const slice =
    endIndex !== undefined ? messages.slice(startIndex, endIndex + 1) : messages.slice(startIndex)
  const user = slice.find((message) => message.type === "user")
  const assistant = lastAssistant(slice)
  const idle = lastIdle(slice)
  let tools: ToolPartLike[] = []
  let toolCount = 0
  if (maxTools && maxTools > 0) {
    for (const message of slice) {
      for (const tool of toolsOf(message)) {
        toolCount++
        tools.push(tool)
        if (tools.length > maxTools) tools.shift()
      }
    }
  } else {
    tools = slice.flatMap(toolsOf)
    toolCount = tools.length
  }
  const extraction = extractText(assistant, "text", maxTextChars)
  const error =
    assistant?.error?.message ??
    (assistant?.finish === "error" ? assistant?.error?.message : undefined) ??
    idle?.error?.message
  return {
    slice,
    user,
    idle,
    tools,
    toolCount,
    text: extraction.text,
    textLength: extraction.length,
    textTruncated: extraction.truncated,
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
  const maxOutputChars =
    options.maxOutputChars && options.maxOutputChars > 0
      ? options.maxOutputChars
      : DEFAULT_MAX_OUTPUT
  const maxTextChars =
    options.maxTextChars && options.maxTextChars > 0 ? options.maxTextChars : DEFAULT_MAX_TEXT
  const maxTools = options.maxTools && options.maxTools > 0 ? options.maxTools : DEFAULT_MAX_TOOLS
  const maxToolLine =
    options.maxToolLine && options.maxToolLine > 0 ? options.maxToolLine : DEFAULT_MAX_TOOL_LINE
  const maxPermissions =
    options.maxPermissions && options.maxPermissions > 0
      ? options.maxPermissions
      : DEFAULT_MAX_PERMISSIONS

  const status =
    options.state ??
    (summary.outcome
      ? `${t(lang, "idle")} (${summary.outcome})`
      : summary.idle
        ? t(lang, "idle")
        : summary.slice.some(isRelevantTurnMessage)
          ? t(lang, "running")
          : t(lang, "noTurns"))

  const headerLine = truncateCodePoints(title, Math.max(120, Math.floor(maxOutputChars * 0.2)))
  const stateLine = `${t(lang, "state")}: ${status}`

  // Build mandatory bottom lines first so IDs, errors, and permissions never get cut off.
  const errorBudget = Math.min(1_000, Math.max(120, Math.floor(maxOutputChars * 0.2)))
  const bottomLines: string[] = []
  if (summary.error) bottomLines.push(`${t(lang, "error")}: ${compact(summary.error, errorBudget)}`)
  if (options.lastError && options.lastError !== summary.error) {
    bottomLines.push(`${t(lang, "error")}: ${compact(options.lastError, errorBudget)}`)
  }
  if (summary.lastMessageID) bottomLines.push(`${t(lang, "lastMessage")}: ${summary.lastMessageID}`)
  if (options.promptMessageID) {
    bottomLines.push(`${t(lang, "promptMessageID")}: ${options.promptMessageID}`)
  }

  if (options.pendingPermissions?.length) {
    const pending = options.pendingPermissions.slice(0, maxPermissions)
    const permHeader = t(lang, "pendingPermissionsCount", { count: options.pendingPermissions.length })
    const hint = t(lang, "replyHint")
    const permBudget = Math.max(160, Math.floor(maxOutputChars * 0.25))
    const permLines: string[] = [permHeader]
    let usedPerm = codePointLength(permHeader) + 1 + codePointLength(hint)
    for (let i = 0; i < pending.length; i++) {
      const line = truncateCodePoints(
        permissionLine(pending[i], lang),
        Math.max(100, Math.floor(permBudget / 2)),
      )
      const lineLen = codePointLength(line) + 1
      if (i === 0 || usedPerm + lineLen <= permBudget) {
        permLines.push(line)
        usedPerm += lineLen
      } else {
        permLines.push("  · …")
        break
      }
    }
    permLines.push(hint)
    bottomLines.push(permLines.join("\n"))
  }

  const bottomBlock = bottomLines.join("\n")
  const mandatoryLength =
    codePointLength(headerLine) +
    1 +
    codePointLength(stateLine) +
    (bottomBlock ? 1 + codePointLength(bottomBlock) : 0)

  let remainingOptional = Math.max(0, maxOutputChars - mandatoryLength)

  const topLines = [headerLine]
  if (summary.user?.text && remainingOptional > 80) {
    const sentBudget = Math.min(500, Math.max(40, Math.floor(remainingOptional * 0.15)))
    const sentLine = `${t(lang, "messageSent")}: ${compact(summary.user.text, sentBudget)}`
    const sentCost = codePointLength(sentLine) + 1
    if (sentCost <= remainingOptional) {
      topLines.push(sentLine)
      remainingOptional -= sentCost
    }
  }
  topLines.push(stateLine)

  const totalTools = summary.toolCount ?? summary.tools.length
  const omitted = Math.max(0, totalTools - maxTools)
  const shown = omitted > 0 ? summary.tools.slice(-maxTools) : summary.tools

  let toolsMinReserve = 0
  const noToolsLine = `${t(lang, "actions")}: ${t(lang, "none")}`
  const actionsHeader = totalTools > 0 ? t(lang, "actionsCount", { count: totalTools }) : noToolsLine
  const omittedHeader = omitted > 0 ? t(lang, "actionsOmitted", { count: omitted }) : undefined

  if (totalTools > 0) {
    const baseHeaderLen =
      codePointLength(actionsHeader) +
      1 +
      (omittedHeader ? codePointLength(omittedHeader) + 1 : 0)
    toolsMinReserve = Math.min(
      remainingOptional,
      baseHeaderLen + Math.min(Math.floor(remainingOptional * 0.45), 600),
    )
  } else {
    toolsMinReserve = Math.min(remainingOptional, codePointLength(noToolsLine) + 1)
  }

  const middleLines: string[] = []
  const textMaxAvailable = Math.max(0, remainingOptional - toolsMinReserve - 1)
  const textPrefix = summary.text ? `${t(lang, "finalText")}:\n` : `${t(lang, "finalText")}: `
  const textPrefixLen = codePointLength(textPrefix)
  if (summary.text) {
    const textBudget = Math.min(
      maxTextChars,
      Math.max(20, Math.min(Math.floor(maxOutputChars / 3), textMaxAvailable - textPrefixLen)),
    )
    const textLine =
      textBudget > 0
        ? `${textPrefix}${truncateCodePoints(summary.text, textBudget)}`
        : `${t(lang, "finalText")}: …`
    const cost = codePointLength(textLine) + 1
    if (cost <= remainingOptional) {
      middleLines.push(textLine)
      remainingOptional -= cost
    }
  } else {
    const noTextLine = `${t(lang, "finalText")}: ${t(lang, "noText")}`
    const cost = codePointLength(noTextLine) + 1
    if (cost <= remainingOptional) {
      middleLines.push(noTextLine)
      remainingOptional -= cost
    }
  }

  if (totalTools > 0) {
    const toolLines: string[] = []
    let toolChars = 0
    const addToolLine = (line: string): boolean => {
      const cost = (toolLines.length > 0 ? 1 : 0) + codePointLength(line)
      if (toolChars + cost + 1 > remainingOptional) return false
      toolLines.push(line)
      toolChars += cost
      return true
    }
    addToolLine(actionsHeader)
    if (omittedHeader) addToolLine(omittedHeader)
    for (const tool of shown) {
      const formatted = toolLine(tool, false, { maxLine: maxToolLine })
      if (!addToolLine(formatted)) {
        const remainingForLine = remainingOptional - toolChars - 2
        if (remainingForLine > 12) {
          addToolLine(truncateCodePoints(formatted, remainingForLine))
        }
        break
      }
    }
    if (toolLines.length) {
      middleLines.push(toolLines.join("\n"))
    }
  } else if (codePointLength(noToolsLine) + 1 <= remainingOptional) {
    middleLines.push(noToolsLine)
  }

  const allLines = [...topLines, ...middleLines, ...(bottomBlock ? [bottomBlock] : [])]
  return fitBudget(allLines.join("\n"), maxOutputChars)
}

export type PermissionLineOptions = {
  maxResources?: number
  maxResourceChars?: number
  maxSaveChars?: number
  maxMetadataChars?: number
  maxMessageChars?: number
  maxLine?: number
}

function boundedList(
  values: string[] | undefined,
  maxItems: number,
  maxChars: number,
  separator = ", ",
): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const shown = values
    .slice(0, Math.max(1, maxItems))
    .map((value) => truncateCodePoints(String(value), maxChars))
  const suffix = values.length > shown.length ? `, …` : ""
  return `${shown.join(separator)}${suffix}`
}

export function permissionLine(
  request: PermissionLike,
  lang: Lang = "es",
  options: PermissionLineOptions = {},
): string {
  const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES
  const maxResourceChars = options.maxResourceChars ?? DEFAULT_MAX_RESOURCE_CHARS
  const resources =
    boundedList(request.resources, maxResources, maxResourceChars) ?? t(lang, "noResources")
  const saveList = boundedList(request.save, maxResources, maxResourceChars)
  const save = saveList ? ` | ${t(lang, "remember")}: ${saveList}` : ""
  const metadata = request.metadata
    ? ` | metadata: ${compact(request.metadata, options.maxMetadataChars ?? 160)}`
    : ""
  const message = request.message
    ? ` | ${compact(request.message, options.maxMessageChars ?? 200)}`
    : ""
  const action = compact(request.action, 120)
  const line = `  · ${request.id} | ${action} | ${resources}${save}${metadata}${message}`
  return options.maxLine ? truncateCodePoints(line, options.maxLine) : line
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
  maxToolsPerMessage?: number
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

export type TranscriptRenderResult = {
  content: string
  lastMessageID?: string
  hasMore: boolean
  nextAfterMessageID?: string
  truncated: boolean
  count: number
}

/**
 * Builds a bounded transcript with metadata for pagination and Code Mode.
 */
export function renderTranscriptDetailed(
  messages: MessageLike[],
  options: TranscriptOptions,
): TranscriptRenderResult {
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

  const effectiveLimit = limit > 0 ? limit : 30
  const lastMessageID = messages[messages.length - 1]?.id
  let selected: MessageLike[]
  let warning: string | undefined
  let emptyAfterNotice: string | undefined
  let hasMore = false

  if (afterMessageID) {
    const index = messages.findIndex((message) => message.id === afterMessageID)
    if (index >= 0) {
      const afterAll = messages.slice(index + 1)
      selected = afterAll.slice(0, effectiveLimit)
      hasMore = afterAll.length > selected.length
      if (selected.length === 0) {
        emptyAfterNotice = t(lang, "noNewMessagesAfter", { id: afterMessageID })
      }
    } else {
      warning = t(lang, "afterNotFound", { id: afterMessageID, limit: effectiveLimit })
      selected = messages.slice(-effectiveLimit)
      hasMore = false
    }
  } else {
    selected = messages.slice(-effectiveLimit)
    hasMore = messages.length > selected.length
  }

  const sampleLastLine = lastMessageID ? `\n\n${t(lang, "lastMessage")}: ${lastMessageID}` : ""
  const samplePaginationLine =
    afterMessageID || hasMore
      ? `\n${t(lang, "nextAfterMessage")}: ${selected[selected.length - 1]?.id ?? afterMessageID ?? ""}\n${t(lang, "hasMore")}: true`
      : ""
  const sampleTruncatedLine = `\n\n${t(lang, "transcriptTruncated")}`
  const footerReserve = Math.min(
    Math.floor(maxOutputChars * 0.4),
    codePointLength(sampleLastLine) +
      codePointLength(samplePaginationLine) +
      codePointLength(sampleTruncatedLine) +
      16,
  )
  const bodyBudget = Math.max(80, maxOutputChars - footerReserve)

  let content = ""
  let contentLength = 0
  let truncated = false
  let renderedCount = 0
  let lastRenderedID: string | undefined

  const append = (block: string): boolean => {
    if (!block) return true
    const addition = content ? `\n\n${block}` : block
    const additionLength = codePointLength(addition)
    const remaining = bodyBudget - contentLength
    if (additionLength > remaining) {
      const available = Math.max(0, remaining - 1)
      if (available > 0) {
        const clipped = truncateCodePoints(addition, available, "…")
        content += clipped
        contentLength += codePointLength(clipped)
      }
      truncated = true
      return false
    }
    content += addition
    contentLength += additionLength
    return true
  }

  if (warning) append(warning)
  if (emptyAfterNotice) append(emptyAfterNotice)

  for (const message of selected) {
    let block = ""
    if (message.type === "user") {
      const text = message.text ? truncateCodePoints(message.text, maxTextChars) : ""
      const files = (message.files ?? []).map((file) => fileLine(file, lang)).filter(Boolean)
      block = [`${t(lang, "user")}: ${text}`, ...files].filter(Boolean).join("\n")
    } else if (message.type === "assistant") {
      const parts: string[] = []
      const text = assistantText(message, maxTextChars)
      if (text) parts.push(`${t(lang, "assistant")}: ${text}`)
      if (includeReasoning) {
        const reasoning = reasoningText(message, maxTextChars)
        if (reasoning) {
          parts.push(`${t(lang, "reasoning")}: ${reasoning}`)
        }
      }
      if (includeTools) {
        const allTools = toolsOf(message)
        const maxTools = options.maxToolsPerMessage ?? DEFAULT_MAX_TOOLS
        const shownTools = maxTools > 0 ? allTools.slice(0, maxTools) : allTools
        for (const tool of shownTools) {
          parts.push(toolLine(tool, includeToolOutput, { maxLine: maxToolLine }))
        }
        if (allTools.length > shownTools.length) {
          parts.push(t(lang, "actionsOmitted", { count: allTools.length - shownTools.length }))
        }
      }
      if (message.error?.message) {
        parts.push(`${t(lang, "assistantError")}: ${compact(message.error.message, 1_000)}`)
      }
      block = parts.join("\n")
    } else if (message.type === "idle") {
      const error = message.error?.message ? ` (${compact(message.error.message, 500)})` : ""
      block = `${t(lang, "endOfTurn")}: ${message.outcome ?? ""}${error}`
    } else if (message.type === "shell") {
      const output = message.output?.output ? `\n${truncateCodePoints(message.output.output, maxTextChars)}` : ""
      block = `${t(lang, "shell")}: ${message.command ?? ""} [${message.status ?? "unknown"}]${output}`
    } else if (message.type === "synthetic") {
      block = `${t(lang, "synthetic")}: ${truncateCodePoints(message.text ?? "", maxTextChars)}`
    } else if (message.type === "compaction") {
      const detail = message.summary ?? message.error?.message ?? ""
      block = `${t(lang, "compaction")} [${message.status ?? "unknown"}]: ${compact(detail, maxTextChars)}`
    }

    if (!append(block)) {
      if (renderedCount === 0 && message.id) lastRenderedID = message.id
      break
    }
    renderedCount++
    if (message.id) lastRenderedID = message.id
  }

  if (renderedCount < selected.length && selected.length > 0) {
    hasMore = true
  }

  const nextAfterMessageID =
    lastRenderedID ??
    selected[selected.length - 1]?.id ??
    (afterMessageID && !warning ? afterMessageID : lastMessageID)

  if (!content && !warning && !emptyAfterNotice) {
    content = t(lang, "noMessages")
    contentLength = codePointLength(content)
  }

  const footerLines: string[] = []
  if (truncated) {
    footerLines.push(t(lang, "transcriptTruncated"))
  }
  const metaLines: string[] = []
  if (lastMessageID) {
    metaLines.push(`${t(lang, "lastMessage")}: ${lastMessageID}`)
  }
  if ((afterMessageID && !warning) || hasMore) {
    if (nextAfterMessageID) {
      metaLines.push(`${t(lang, "nextAfterMessage")}: ${nextAfterMessageID}`)
    }
    metaLines.push(`${t(lang, "hasMore")}: ${hasMore ? "true" : "false"}`)
  }
  if (metaLines.length) {
    footerLines.push(metaLines.join("\n"))
  }

  if (footerLines.length) {
    const footer = `\n\n${footerLines.join("\n\n")}`
    const footerLength = codePointLength(footer)
    if (contentLength + footerLength > maxOutputChars) {
      const allowedBody = Math.max(0, maxOutputChars - footerLength)
      content = fitBudget(content, allowedBody, "…")
    }
    content += footer
  }

  return {
    content: fitBudget(content, maxOutputChars, t(lang, "outputTruncated")),
    lastMessageID,
    hasMore,
    nextAfterMessageID,
    truncated,
    count: renderedCount,
  }
}

/**
 * Builds a bounded transcript. The complete transcript is still read once
 * because 2.2.5 does not expose paginated message reads from the plugin
 * context, but only the selected window is rendered.
 */
export function renderTranscript(messages: MessageLike[], options: TranscriptOptions): string {
  return renderTranscriptDetailed(messages, options).content
}
