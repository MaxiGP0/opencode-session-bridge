import {
  compact,
  codePointLength,
  formatError,
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
    .map((value) => truncateCodePoints(String(value), maxChars))
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
        id: request.id,
        action: compact(request.action, 120),
        resources: boundedStringArray(request.resources, 10, 200),
        save: boundedStringArray(request.save, 10, 200),
        message: request.message ? compact(request.message, 200) : undefined,
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
