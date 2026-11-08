import {
  compact,
  codePointLength,
  formatError,
  oneLine,
  permissionLine,
  sanitizeTitle,
  truncateCodePoints,
} from "./format.ts"
import type { BridgeOptions } from "./options.ts"
import type { Lang, PermissionLike } from "./types.ts"

export type OutputBudget = {
  maxTextChars: number
  maxErrorChars: number
  maxTitleChars: number
  maxPermissions: number
  maxTools: number
  maxToolLine: number
}

export function outputBudget(options: BridgeOptions): OutputBudget {
  return {
    maxTextChars: options.maxTextChars,
    maxErrorChars: options.maxErrorChars,
    maxTitleChars: options.maxTitleChars,
    maxPermissions: options.maxPermissions,
    maxTools: options.maxTools,
    maxToolLine: options.maxToolLine,
  }
}

export type BoundedText = {
  text?: string
  textLength: number
  textTruncated: boolean
}

export function boundText(text: string | undefined, maxChars: number): BoundedText {
  if (!text) return { text: undefined, textLength: 0, textTruncated: false }
  const length = codePointLength(text)
  if (length <= maxChars) return { text, textLength: length, textTruncated: false }
  return {
    text: truncateCodePoints(text, maxChars),
    textLength: length,
    textTruncated: true,
  }
}

export type BoundedError = {
  error?: string
  errorTruncated?: boolean
}

export function boundError(error: string | undefined, maxChars: number): BoundedError {
  if (!error) return {}
  const length = codePointLength(error)
  if (length <= maxChars) return { error }
  return { error: truncateCodePoints(error, maxChars), errorTruncated: true }
}

export function boundTitle(title: string | undefined, maxChars: number): string | undefined {
  if (!title) return undefined
  return truncateCodePoints(sanitizeTitle(title), maxChars)
}

export type PendingOutputItem = {
  id: string
  action: string
  resources?: string[]
  save?: string[]
  message?: string
}

export type BoundedPending = {
  pendingPermissions: PendingOutputItem[]
  pendingTotal: number
  pendingTruncated: boolean
}

function boundedStringArray(
  values: string[] | undefined,
  maxItems: number,
  maxChars: number,
): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const shown = values
    .slice(0, Math.max(1, maxItems))
    .map((value) => oneLine(String(value), maxChars))
  if (values.length > shown.length) shown.push("…")
  return shown
}

export function boundPendingPermissions(
  pending: PermissionLike[] | undefined,
  maxItems: number,
  lang: Lang,
): BoundedPending {
  const all = pending ?? []
  const shown = all.slice(0, Math.max(0, maxItems))
  return {
    pendingPermissions: shown.map((request) =>
      cleanOutput({
        id: oneLine(request.id, 256),
        action: oneLine(compact(request.action, 120), 120),
        resources: boundedStringArray(request.resources, 10, 200),
        save: boundedStringArray(request.save, 10, 200),
        message: request.message ? oneLine(request.message, 200) : undefined,
      }),
    ) as PendingOutputItem[],
    pendingTotal: all.length,
    pendingTruncated: all.length > shown.length,
  }
}

/**
 * Every tool output is built from scratch on errors so Code Mode always
 * receives a structured value instead of `undefined`.
 */
export function errorOutput(
  error: unknown,
  maxErrorChars: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const bounded = boundError(formatError(error) || "Unknown error", maxErrorChars)
  const output: Record<string, unknown> = { state: "error" }
  if (bounded.error) output.error = bounded.error
  if (bounded.errorTruncated) output.errorTruncated = true
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) output[key] = value
  }
  return output
}

export function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

export function cleanOutput(output: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(output)) {
    if (value !== undefined && value !== null) cleaned[key] = value
  }
  return cleaned
}

export function boundedPermissionLine(
  request: PermissionLike,
  lang: Lang,
  maxLine: number,
): string {
  return permissionLine(request, lang, { maxLine })
}

const CRITICAL_OUTPUT_KEYS = new Set([
  "sessionID",
  "state",
  "messageID",
  "requestID",
  "lastMessageID",
  "promptMessageID",
  "pendingTotal",
  "pendingTruncated",
  "error",
  "errorTruncated",
  "removed",
  "updated",
  "interrupted",
  "language",
  "changed",
  "nextCursor",
  "partial",
  "partialMessageID",
  "hasMore",
  "count",
  "queuedCount",
  "queuedTruncated",
  "toolsTruncated",
  "sessionsTruncated",
  "transcriptAvailable",
  "permissionsAvailable",
  "liveStale",
])

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function shrinkString(value: string, marker = "…"): string {
  const length = codePointLength(value)
  if (length <= 1) return ""
  return truncateCodePoints(value, Math.max(0, Math.floor(length / 2)), marker)
}

/**
 * Enforces the global `output` budget. Per-field caps are not enough: arrays
 * of bounded fields can still add up to hundreds of kilobytes. Arrays are
 * trimmed first (keeping the first element and critical IDs), then optional
 * strings, and finally any remaining non-critical key. Critical identity and
 * state fields are never removed.
 */
export function boundOutputTotal(output: unknown, maxChars: number): unknown {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return output
  if (!output || typeof output !== "object" || Array.isArray(output)) return output
  const result: Record<string, unknown> = { ...(output as Record<string, unknown>) }
  const fits = (): boolean => jsonLength(result) <= maxChars
  if (fits()) return result

  const trimArray = (key: string, flag: string): boolean => {
    const current = result[key]
    if (!Array.isArray(current) || current.length === 0) return false
    const copy = [...current]
    let changed = false
    while (copy.length > 1) {
      result[key] = copy
      if (fits()) {
        if (changed) result[flag] = true
        return true
      }
      copy.pop()
      changed = true
    }
    result[key] = copy
    if (changed) result[flag] = true
    return changed
  }

  for (const [key, flag] of [
    ["tools", "toolsTruncated"],
    ["sessions", "sessionsTruncated"],
    ["queuedMessageIDs", "queuedTruncated"],
    ["pendingPermissions", "pendingTruncated"],
    ["pending", "pendingTruncated"],
  ] as const) {
    trimArray(key, flag)
    if (fits()) return result
  }

  // A single pending request can still be large because of its resources/save
  // arrays. Keep the first request ID and shrink its payload.
  for (const pendingKey of ["pendingPermissions", "pending"]) {
    const pending = result[pendingKey]
    if (!Array.isArray(pending) || pending.length === 0) continue
    const first = pending[0]
    if (!first || typeof first !== "object") continue
    const item = first as Record<string, unknown>
    for (const key of ["save", "resources", "message"]) {
      const value = item[key]
      if (Array.isArray(value)) {
        item[key] = value.slice(0, 1)
        result.pendingTruncated = true
      } else if (typeof value === "string") {
        item[key] = shrinkString(value)
        result.pendingTruncated = true
      }
    }
    if (fits()) return result
  }

  for (const key of ["text", "error", "title", "message", "reason", "outcome", "nextQueuedMessageID"]) {
    const value = result[key]
    if (typeof value !== "string") continue
    let next = value
    while (next && !fits()) {
      next = shrinkString(next)
      if (key === "text") result.textTruncated = true
      if (key === "error") result.errorTruncated = true
    }
    result[key] = next
    if (fits()) return result
  }

  for (const key of Object.keys(result)) {
    if (fits()) return result
    if (CRITICAL_OUTPUT_KEYS.has(key)) continue
    if (key === "tools" || key === "sessions") {
      result[key] = []
      if (key === "tools") result.toolsTruncated = true
      if (key === "sessions") result.sessionsTruncated = true
      continue
    }
    if (key === "pendingPermissions" || key === "pending") {
      result[key] = Array.isArray(result[key]) ? (result[key] as unknown[]).slice(0, 1) : []
      result.pendingTruncated = true
      continue
    }
    delete result[key]
  }

  return result
}
