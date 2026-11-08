import { t } from "./i18n.ts"
import type { Lang } from "./types.ts"

export type BridgeOptions = {
  language: Lang
  defaultTimeoutMs: number
  maxOutputChars: number
  maxOutputTotalChars: number
  maxTools: number
  maxToolLine: number
  maxTextChars: number
  maxErrorChars: number
  maxTitleChars: number
  maxPermissions: number
  maxPromptChars: number
  maxSearchChars: number
  maxPermissionRules: number
  maxMetadataBytes: number
  maxIdChars: number
  maxAgentChars: number
  maxModelChars: number
  maxPathChars: number
  maxPermissionFieldChars: number
  queueTtlMs: number
  livePendingTtlMs: number
  maxQueuedPrompts: number
  pollIntervalMs: number
  maxPollIntervalMs: number
  permissionPollMs: number
  requestTimeoutMs: number
  progressIntervalMs: number
  allowPermissionRules: boolean
  allowPersistentPermissions: boolean
  allowReplyToForeignSessions: boolean
  allowSessionRemoval: boolean
  allowRemoveForeignSessions: boolean
  allowInterruptForeignSessions: boolean
  allowUpdateForeignSessions: boolean
  allowCompact: boolean
  debug: boolean
}

export const DEFAULT_OPTIONS: BridgeOptions = {
  language: "en",
  defaultTimeoutMs: 120_000,
  maxOutputChars: 20_000,
  maxOutputTotalChars: 20_000,
  maxTools: 40,
  maxToolLine: 500,
  maxTextChars: 4_000,
  maxErrorChars: 1_000,
  maxTitleChars: 500,
  maxPermissions: 20,
  maxPromptChars: 100_000,
  maxSearchChars: 500,
  maxPermissionRules: 100,
  maxMetadataBytes: 32_768,
  maxIdChars: 256,
  maxAgentChars: 128,
  maxModelChars: 256,
  maxPathChars: 4_096,
  maxPermissionFieldChars: 512,
  queueTtlMs: 3_600_000,
  livePendingTtlMs: 600_000,
  maxQueuedPrompts: 100,
  pollIntervalMs: 500,
  maxPollIntervalMs: 2_000,
  permissionPollMs: 1_500,
  requestTimeoutMs: 10_000,
  progressIntervalMs: 5_000,
  allowPermissionRules: false,
  allowPersistentPermissions: false,
  allowReplyToForeignSessions: false,
  allowSessionRemoval: false,
  allowRemoveForeignSessions: false,
  allowInterruptForeignSessions: false,
  allowUpdateForeignSessions: false,
  allowCompact: false,
  debug: false,
}

function warn(name: string): void {
  console.warn(t("en", "optionInvalid", { name }))
}

function readNumber(
  raw: Record<string, unknown>,
  name: keyof BridgeOptions,
  min: number,
  max: number,
): number {
  const value = raw[name]
  if (value === undefined) return DEFAULT_OPTIONS[name] as number
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    warn(name)
    return DEFAULT_OPTIONS[name] as number
  }
  return value
}

function readBoolean(raw: Record<string, unknown>, name: keyof BridgeOptions): boolean {
  const value = raw[name]
  if (value === undefined) return DEFAULT_OPTIONS[name] as boolean
  if (typeof value !== "boolean") {
    warn(name)
    return DEFAULT_OPTIONS[name] as boolean
  }
  return value
}

export function parseOptions(raw: Record<string, unknown> | undefined): BridgeOptions {
  const input = raw ?? {}
  const language = input.language
  const parsedLanguage: Lang = language === "es" || language === "en" ? language : DEFAULT_OPTIONS.language
  if (language !== undefined && parsedLanguage !== language) warn("language")

  const maxOutputChars = readNumber(input, "maxOutputChars", 1_000, 200_000)
  // Keep the global output budget aligned with maxOutputChars unless the user
  // explicitly configures a separate total.
  const maxOutputTotalChars =
    input.maxOutputTotalChars === undefined
      ? maxOutputChars
      : readNumber(input, "maxOutputTotalChars", 1_000, 200_000)

  return {
    language: parsedLanguage,
    defaultTimeoutMs: readNumber(input, "defaultTimeoutMs", 1, 600_000),
    maxOutputChars,
    maxOutputTotalChars,
    maxTools: readNumber(input, "maxTools", 1, 200),
    maxToolLine: readNumber(input, "maxToolLine", 50, 5_000),
    maxTextChars: readNumber(input, "maxTextChars", 100, 50_000),
    maxErrorChars: readNumber(input, "maxErrorChars", 100, 10_000),
    maxTitleChars: readNumber(input, "maxTitleChars", 20, 5_000),
    maxPermissions: readNumber(input, "maxPermissions", 1, 100),
    maxPromptChars: readNumber(input, "maxPromptChars", 1_000, 1_000_000),
    maxSearchChars: readNumber(input, "maxSearchChars", 1, 10_000),
    maxPermissionRules: readNumber(input, "maxPermissionRules", 1, 1_000),
    maxMetadataBytes: readNumber(input, "maxMetadataBytes", 1_024, 1_048_576),
    maxIdChars: readNumber(input, "maxIdChars", 16, 4_096),
    maxAgentChars: readNumber(input, "maxAgentChars", 16, 4_096),
    maxModelChars: readNumber(input, "maxModelChars", 16, 4_096),
    maxPathChars: readNumber(input, "maxPathChars", 64, 32_768),
    maxPermissionFieldChars: readNumber(input, "maxPermissionFieldChars", 32, 16_384),
    queueTtlMs: readNumber(input, "queueTtlMs", 1, 86_400_000),
    livePendingTtlMs: readNumber(input, "livePendingTtlMs", 1_000, 86_400_000),
    maxQueuedPrompts: readNumber(input, "maxQueuedPrompts", 1, 1_000),
    pollIntervalMs: readNumber(input, "pollIntervalMs", 10, 10_000),
    maxPollIntervalMs: readNumber(input, "maxPollIntervalMs", 100, 30_000),
    permissionPollMs: readNumber(input, "permissionPollMs", 100, 10_000),
    requestTimeoutMs: readNumber(input, "requestTimeoutMs", 1_000, 60_000),
    progressIntervalMs: readNumber(input, "progressIntervalMs", 1_000, 60_000),
    allowPermissionRules: readBoolean(input, "allowPermissionRules"),
    allowPersistentPermissions: readBoolean(input, "allowPersistentPermissions"),
    allowReplyToForeignSessions: readBoolean(input, "allowReplyToForeignSessions"),
    allowSessionRemoval: readBoolean(input, "allowSessionRemoval"),
    allowRemoveForeignSessions: readBoolean(input, "allowRemoveForeignSessions"),
    allowInterruptForeignSessions: readBoolean(input, "allowInterruptForeignSessions"),
    allowUpdateForeignSessions: readBoolean(input, "allowUpdateForeignSessions"),
    allowCompact: readBoolean(input, "allowCompact"),
    debug: readBoolean(input, "debug"),
  }
}
