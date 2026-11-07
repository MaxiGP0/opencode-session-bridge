import { parseModel } from "./format.ts"
import { t, type StringKey } from "./i18n.ts"
import type { BridgeOptions } from "./options.ts"
import type { Lang } from "./types.ts"

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

export type PermissionRuleInput = {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(input: unknown, lang: Lang): Record<string, unknown> {
  if (!isRecord(input)) throw new ValidationError(t(lang, "invalidInput"))
  return input
}

function requireString(
  value: unknown,
  key: StringKey,
  lang: Lang,
  options: { trim?: boolean } = {},
): string {
  if (typeof value !== "string") throw new ValidationError(t(lang, key))
  const result = options.trim === false ? value : value.trim()
  if (!result.trim()) throw new ValidationError(t(lang, key))
  return result
}

function optionalString(value: unknown, key: StringKey, lang: Lang): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, key, lang)
}

function optionalLimitedString(
  value: unknown,
  key: StringKey,
  limitKey: StringKey,
  max: number,
  lang: Lang,
): string | undefined {
  const text = optionalString(value, key, lang)
  if (text === undefined) return undefined
  return assertMaxLength(text, 1, max, limitKey, lang)
}

function optionalModel(value: unknown, lang: Lang): string | undefined {
  const model = optionalString(value, "invalidModel", lang)
  if (model && !parseModel(model)) throw new ValidationError(t(lang, "invalidModel"))
  return model
}

function optionalBoolean(value: unknown, key: StringKey, lang: Lang, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new ValidationError(t(lang, key))
  return value
}

function integerOption(
  value: unknown,
  key: StringKey,
  lang: Lang,
  min: number,
  max: number,
  fallback: number,
  zeroMeansDefault: boolean,
  vars?: Record<string, string | number>,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(t(lang, key, vars))
  }
  if (value === 0 && zeroMeansDefault) return fallback
  if (value < min || value > max) throw new ValidationError(t(lang, key, vars))
  return value
}

function assertMaxLength(
  value: string,
  min: number,
  max: number,
  key: StringKey,
  lang: Lang,
): string {
  if (value.length < min || value.length > max) {
    throw new ValidationError(t(lang, key, { min, max }))
  }
  return value
}

function requirePrompt(value: unknown, lang: Lang, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(t(lang, "promptEmpty"))
  }
  return assertMaxLength(value, 1, maxChars, "promptTooLong", lang)
}

function validateDecision(value: unknown, lang: Lang): "once" | "always" | "reject" {
  if (value === "once" || value === "always" || value === "reject") return value
  throw new ValidationError(t(lang, "invalidDecision"))
}

function validateDelivery(value: unknown, lang: Lang): "steer" | "queue" {
  if (value === "steer" || value === "queue") return value
  throw new ValidationError(t(lang, "invalidDelivery"))
}

function validateOrder(value: unknown, lang: Lang): "asc" | "desc" | undefined {
  if (value === undefined || value === null) return undefined
  if (value === "asc" || value === "desc") return value
  throw new ValidationError(t(lang, "invalidOrder"))
}

export function validateLanguage(value: unknown, lang: Lang): Lang {
  if (value === "es" || value === "en") return value
  throw new ValidationError(t(lang, "invalidLanguage"))
}

export function validatePermissionRules(
  value: unknown,
  lang: Lang,
  allowAllowRules: boolean,
  maxRules = 100,
): PermissionRuleInput[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new ValidationError(t(lang, "invalidPermissionRule"))
  if (value.length > maxRules) {
    throw new ValidationError(t(lang, "tooManyPermissionRules", { max: maxRules }))
  }

  return value.map((item) => {
    if (!isRecord(item)) throw new ValidationError(t(lang, "invalidPermissionRule"))
    const action = requireString(item.action, "invalidPermissionRule", lang)
    const resource = requireString(item.resource, "invalidPermissionRule", lang)
    if (item.effect !== "allow" && item.effect !== "deny" && item.effect !== "ask") {
      throw new ValidationError(t(lang, "invalidPermissionRule"))
    }
    if (item.effect === "allow" && !allowAllowRules) {
      throw new ValidationError(`${t(lang, "allowRuleBlocked")} ${t(lang, "allowRuleHint")}`)
    }
    return { action, resource, effect: item.effect }
  })
}

function validateMetadata(
  value: unknown,
  lang: Lang,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new ValidationError(t(lang, "invalidMetadata"))
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new ValidationError(t(lang, "invalidMetadata"))
    if (Buffer.byteLength(json, "utf8") > maxBytes) {
      throw new ValidationError(t(lang, "metadataTooLarge", { max: maxBytes }))
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError(t(lang, "invalidMetadata"))
  }
  return value
}

function maxOutput(value: unknown, lang: Lang, options: BridgeOptions): number {
  return integerOption(
    value,
    "invalidMaxOutput",
    lang,
    1_000,
    options.maxOutputChars,
    options.maxOutputChars,
    true,
    { min: 1_000, max: options.maxOutputChars },
  )
}

export type OpenInput = {
  sessionID?: string
  prompt: string
  title?: string
  agent?: string
  model?: string
  wait: boolean
  timeoutMs: number
  permissions?: PermissionRuleInput[]
  delivery: "steer" | "queue"
  messageID?: string
  maxOutputChars: number
}

export function parseOpenInput(input: unknown, lang: Lang, options: BridgeOptions): OpenInput {
  const data = record(input, lang)
  return {
    sessionID: optionalString(data.sessionID, "invalidSessionID", lang),
    prompt: requirePrompt(data.prompt, lang, options.maxPromptChars),
    title: optionalLimitedString(
      data.title,
      "invalidTitle",
      "titleTooLong",
      options.maxTitleChars,
      lang,
    ),
    agent: optionalString(data.agent, "invalidAgent", lang),
    model: optionalModel(data.model, lang),
    wait: optionalBoolean(data.wait, "invalidInput", lang, true),
    timeoutMs: integerOption(
      data.timeoutMs,
      "invalidTimeout",
      lang,
      1,
      600_000,
      options.defaultTimeoutMs,
      false,
    ),
    permissions: validatePermissionRules(
      data.permissions,
      lang,
      options.allowPermissionRules,
      options.maxPermissionRules,
    ),
    delivery:
      data.delivery === undefined || data.delivery === null
        ? "steer"
        : validateDelivery(data.delivery, lang),
    messageID: optionalString(data.messageID, "invalidMessageID", lang),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type SendInput = {
  sessionID: string
  prompt: string
  agent?: string
  model?: string
  delivery: "steer" | "queue"
  wait: boolean
  timeoutMs: number
  messageID?: string
  maxOutputChars: number
}

export function parseSendInput(input: unknown, lang: Lang, options: BridgeOptions): SendInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    prompt: requirePrompt(data.prompt, lang, options.maxPromptChars),
    agent: optionalString(data.agent, "invalidAgent", lang),
    model: optionalModel(data.model, lang),
    delivery:
      data.delivery === undefined || data.delivery === null
        ? "steer"
        : validateDelivery(data.delivery, lang),
    wait: optionalBoolean(data.wait, "invalidInput", lang, true),
    timeoutMs: integerOption(
      data.timeoutMs,
      "invalidTimeout",
      lang,
      1,
      600_000,
      options.defaultTimeoutMs,
      false,
    ),
    messageID: optionalString(data.messageID, "invalidMessageID", lang),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type WaitInput = {
  sessionID: string
  messageID?: string
  timeoutMs: number
  maxOutputChars: number
}

export function parseWaitInput(input: unknown, lang: Lang, options: BridgeOptions): WaitInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    messageID: optionalString(data.messageID, "invalidMessageID", lang),
    timeoutMs: integerOption(
      data.timeoutMs,
      "invalidTimeout",
      lang,
      1,
      600_000,
      options.defaultTimeoutMs,
      false,
    ),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type StatusInput = {
  sessionID: string
  recent: number
  verbose: boolean
  includeText: boolean
  includeTools: boolean
  maxText: number
  maxOutputChars: number
}

export function parseStatusInput(input: unknown, lang: Lang, options: BridgeOptions): StatusInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    recent: integerOption(data.recent, "invalidRecent", lang, 1, 100, 8, true),
    verbose: optionalBoolean(data.verbose, "invalidInput", lang, false),
    includeText: optionalBoolean(data.includeText, "invalidInput", lang, true),
    includeTools: optionalBoolean(data.includeTools, "invalidInput", lang, true),
    maxText: integerOption(
      data.maxText,
      "invalidMaxText",
      lang,
      100,
      options.maxTextChars,
      options.maxTextChars,
      true,
      { min: 100, max: options.maxTextChars },
    ),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type ReadInput = {
  sessionID: string
  limit: number
  afterMessageID?: string
  includeTools: boolean
  includeToolOutput: boolean
  includeReasoning: boolean
  maxOutputChars: number
}

export function parseReadInput(input: unknown, lang: Lang, options: BridgeOptions): ReadInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    limit: integerOption(data.limit, "invalidLimit", lang, 1, 200, 30, true),
    afterMessageID: optionalString(data.afterMessageID, "invalidMessageID", lang),
    includeTools: optionalBoolean(data.includeTools, "invalidInput", lang, true),
    includeToolOutput: optionalBoolean(data.includeToolOutput, "invalidInput", lang, false),
    includeReasoning: optionalBoolean(data.includeReasoning, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type PermissionsInput = {
  sessionID: string
  limit: number
  maxOutputChars: number
}

export function parsePermissionsInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): PermissionsInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    limit: integerOption(data.limit, "invalidListLimit", lang, 1, 100, 20, true),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type ReplyInput = {
  sessionID: string
  requestID: string
  decision: "once" | "always" | "reject"
  message?: string
  maxOutputChars: number
}

export function parseReplyInput(input: unknown, lang: Lang, options: BridgeOptions): ReplyInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    requestID: requireString(data.requestID, "invalidRequestID", lang),
    decision: validateDecision(data.decision, lang),
    message: optionalLimitedString(
      data.message,
      "invalidMessage",
      "messageTooLong",
      options.maxPromptChars,
      lang,
    ),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type InterruptInput = {
  sessionID: string
  resume: boolean
  maxOutputChars: number
}

export function parseInterruptInput(input: unknown, lang: Lang, options: BridgeOptions): InterruptInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    resume: optionalBoolean(data.resume, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type ListInput = {
  limit: number
  search?: string
  directory?: string
  cursor?: string
  order?: "asc" | "desc"
  archived?: boolean
  parentID?: string
  subpath?: string
  verbose: boolean
  maxOutputChars: number
}

export function parseListInput(input: unknown, lang: Lang, options: BridgeOptions): ListInput {
  const data = record(input, lang)
  return {
    limit: integerOption(data.limit, "invalidListLimit", lang, 1, 100, 10, true),
    search: optionalLimitedString(
      data.search,
      "invalidSearch",
      "searchTooLong",
      options.maxSearchChars,
      lang,
    ),
    directory: optionalString(data.directory, "invalidDirectory", lang),
    cursor: optionalString(data.cursor, "invalidCursor", lang),
    order: validateOrder(data.order, lang),
    archived:
      data.archived === undefined || data.archived === null
        ? undefined
        : optionalBoolean(data.archived, "invalidInput", lang, false),
    parentID: optionalString(data.parentID, "invalidParentID", lang),
    subpath: optionalString(data.subpath, "invalidSubpath", lang),
    verbose: optionalBoolean(data.verbose, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type LanguageInput = { language?: Lang; maxOutputChars: number }

export function parseLanguageInput(input: unknown, lang: Lang, options: BridgeOptions): LanguageInput {
  const data = record(input, lang)
  return {
    language:
      data.language === undefined || data.language === null
        ? undefined
        : validateLanguage(data.language, lang),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type UpdateInput = {
  sessionID: string
  title?: string
  archived?: boolean
  metadata?: Record<string, unknown>
  permissions?: PermissionRuleInput[]
  maxOutputChars: number
}

export function parseUpdateInput(input: unknown, lang: Lang, options: BridgeOptions): UpdateInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    title: optionalLimitedString(
      data.title,
      "invalidTitle",
      "titleTooLong",
      options.maxTitleChars,
      lang,
    ),
    archived:
      data.archived === undefined || data.archived === null
        ? undefined
        : optionalBoolean(data.archived, "invalidInput", lang, false),
    metadata: validateMetadata(data.metadata, lang, options.maxMetadataBytes),
    permissions: validatePermissionRules(
      data.permissions,
      lang,
      options.allowPermissionRules,
      options.maxPermissionRules,
    ),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type RemoveInput = {
  sessionID: string
  confirm: boolean
  maxOutputChars: number
}

export function parseRemoveInput(input: unknown, lang: Lang, options: BridgeOptions): RemoveInput {
  const data = record(input, lang)
  return {
    sessionID: requireString(data.sessionID, "invalidSessionID", lang),
    confirm: optionalBoolean(data.confirm, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}
