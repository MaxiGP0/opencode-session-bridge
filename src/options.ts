import { t } from "./i18n.ts"
import type { Lang } from "./types.ts"

export type BridgeOptions = {
  language: Lang
  defaultTimeoutMs: number
  maxOutputChars: number
  maxTools: number
  maxToolLine: number
  maxTextChars: number
  maxPermissions: number
  pollIntervalMs: number
  maxPollIntervalMs: number
  permissionPollMs: number
  requestTimeoutMs: number
  progressIntervalMs: number
  allowPermissionRules: boolean
  allowPersistentPermissions: boolean
  allowReplyToForeignSessions: boolean
  allowSessionRemoval: boolean
  debug: boolean
}

export const DEFAULT_OPTIONS: BridgeOptions = {
  language: "en",
  defaultTimeoutMs: 120_000,
  maxOutputChars: 20_000,
  maxTools: 40,
  maxToolLine: 500,
  maxTextChars: 4_000,
  maxPermissions: 20,
  pollIntervalMs: 500,
  maxPollIntervalMs: 2_000,
  permissionPollMs: 1_500,
  requestTimeoutMs: 10_000,
  progressIntervalMs: 5_000,
  allowPermissionRules: false,
  allowPersistentPermissions: false,
  allowReplyToForeignSessions: false,
  allowSessionRemoval: false,
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

  return {
    language: parsedLanguage,
    defaultTimeoutMs: readNumber(input, "defaultTimeoutMs", 1, 600_000),
    maxOutputChars: readNumber(input, "maxOutputChars", 1_000, 200_000),
    maxTools: readNumber(input, "maxTools", 1, 200),
    maxToolLine: readNumber(input, "maxToolLine", 50, 5_000),
    maxTextChars: readNumber(input, "maxTextChars", 100, 50_000),
    maxPermissions: readNumber(input, "maxPermissions", 1, 100),
    pollIntervalMs: readNumber(input, "pollIntervalMs", 50, 10_000),
    maxPollIntervalMs: readNumber(input, "maxPollIntervalMs", 100, 30_000),
    permissionPollMs: readNumber(input, "permissionPollMs", 100, 10_000),
    requestTimeoutMs: readNumber(input, "requestTimeoutMs", 1_000, 60_000),
    progressIntervalMs: readNumber(input, "progressIntervalMs", 1_000, 60_000),
    allowPermissionRules: readBoolean(input, "allowPermissionRules"),
    allowPersistentPermissions: readBoolean(input, "allowPersistentPermissions"),
    allowReplyToForeignSessions: readBoolean(input, "allowReplyToForeignSessions"),
    allowSessionRemoval: readBoolean(input, "allowSessionRemoval"),
    debug: readBoolean(input, "debug"),
  }
}
