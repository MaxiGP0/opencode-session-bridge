import { codePointLength, parseModel } from "./format.ts"
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
  // Tools without required fields may be called with no arguments by Code
  // Mode; treat undefined/null as an empty object.
  if (input === undefined || input === null) return {}
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

function optionalModel(value: unknown, lang: Lang, maxChars = 256): string | undefined {
  const model = optionalString(value, "invalidModel", lang)
  if (model && !parseModel(model)) throw new ValidationError(t(lang, "invalidModel"))
  if (model && codePointLength(model) > maxChars) {
    throw new ValidationError(
      t(lang, "fieldTooLong", { field: "model", min: 1, max: maxChars }),
    )
  }
  return model
}

function optionalBoundedString(
  value: unknown,
  key: StringKey,
  max: number,
  field: string,
  lang: Lang,
): string | undefined {
  const text = optionalString(value, key, lang)
  if (text === undefined) return undefined
  if (codePointLength(text) > max) {
    throw new ValidationError(t(lang, "fieldTooLong", { field, min: 1, max }))
  }
  return text
}

function requireBoundedId(
  value: unknown,
  key: StringKey,
  field: string,
  options: BridgeOptions,
  lang: Lang,
): string {
  const text = requireString(value, key, lang)
  if (codePointLength(text) > options.maxIdChars) {
    throw new ValidationError(
      t(lang, "fieldTooLong", { field, min: 1, max: options.maxIdChars }),
    )
  }
  return text
}

function optionalBoolean(value: unknown, key: StringKey, lang: Lang, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new ValidationError(t(lang, key))
  return value
}

function requireBoolean(value: unknown, key: StringKey, lang: Lang): boolean {
  if (typeof value !== "boolean") throw new ValidationError(t(lang, key))
  return value
}

function stringArray(
  value: unknown,
  key: StringKey,
  lang: Lang,
  maxItems: number,
  maxChars: number,
  field: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new ValidationError(t(lang, key))
  if (value.length > maxItems) {
    throw new ValidationError(t(lang, "tooManyItems", { max: maxItems }))
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new ValidationError(t(lang, key))
    const text = item.trim()
    if (codePointLength(text) > maxChars) {
      throw new ValidationError(t(lang, "fieldTooLong", { field, min: 1, max: maxChars }))
    }
    return text
  })
}

function stringRecord(
  value: unknown,
  key: StringKey,
  lang: Lang,
  maxItems: number,
  maxChars: number,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new ValidationError(t(lang, key))
  const entries = Object.entries(value)
  if (entries.length > maxItems) {
    throw new ValidationError(t(lang, "tooManyItems", { max: maxItems }))
  }
  const result: Record<string, string> = {}
  for (const [name, raw] of entries) {
    if (typeof raw !== "string") throw new ValidationError(t(lang, key))
    if (codePointLength(name) > 128 || codePointLength(raw) > maxChars) {
      throw new ValidationError(t(lang, "fieldTooLong", { field: name, min: 0, max: maxChars }))
    }
    result[name] = raw
  }
  return result
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
  const length = codePointLength(value)
  if (length < min || length > max) {
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
  maxFieldChars = 512,
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
    if (
      codePointLength(action) > maxFieldChars ||
      codePointLength(resource) > maxFieldChars
    ) {
      throw new ValidationError(
        t(lang, "fieldTooLong", {
          field: "action/resource",
          min: 1,
          max: maxFieldChars,
        }),
      )
    }
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
  directory?: string
  runID?: string
  maxOutputChars: number
}

export function parseOpenInput(input: unknown, lang: Lang, options: BridgeOptions): OpenInput {
  const data = record(input, lang)
  return {
    sessionID: optionalBoundedString(
      data.sessionID,
      "invalidSessionID",
      options.maxIdChars,
      "sessionID",
      lang,
    ),
    prompt: requirePrompt(data.prompt, lang, options.maxPromptChars),
    title: optionalLimitedString(
      data.title,
      "invalidTitle",
      "titleTooLong",
      options.maxTitleChars,
      lang,
    ),
    agent: optionalBoundedString(
      data.agent,
      "invalidAgent",
      options.maxAgentChars,
      "agent",
      lang,
    ),
    model: optionalModel(data.model, lang, options.maxModelChars),
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
      options.maxPermissionFieldChars,
    ),
    delivery:
      data.delivery === undefined || data.delivery === null
        ? "steer"
        : validateDelivery(data.delivery, lang),
    messageID: optionalBoundedString(
      data.messageID,
      "invalidMessageID",
      options.maxIdChars,
      "messageID",
      lang,
    ),
    directory: optionalBoundedString(
      data.directory,
      "invalidDirectory",
      options.maxPathChars,
      "directory",
      lang,
    ),
    runID: optionalBoundedString(
      data.runID,
      "invalidRunID",
      options.maxIdChars,
      "runID",
      lang,
    ),
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
  const sessionID = requireString(data.sessionID, "invalidSessionID", lang)
  if (codePointLength(sessionID) > options.maxIdChars) {
    throw new ValidationError(
      t(lang, "fieldTooLong", { field: "sessionID", min: 1, max: options.maxIdChars }),
    )
  }
  return {
    sessionID,
    prompt: requirePrompt(data.prompt, lang, options.maxPromptChars),
    agent: optionalBoundedString(
      data.agent,
      "invalidAgent",
      options.maxAgentChars,
      "agent",
      lang,
    ),
    model: optionalModel(data.model, lang, options.maxModelChars),
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
    messageID: optionalBoundedString(
      data.messageID,
      "invalidMessageID",
      options.maxIdChars,
      "messageID",
      lang,
    ),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
    messageID: optionalBoundedString(
      data.messageID,
      "invalidMessageID",
      options.maxIdChars,
      "messageID",
      lang,
    ),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
    limit: integerOption(data.limit, "invalidLimit", lang, 1, 200, 30, true),
    afterMessageID: optionalBoundedString(
      data.afterMessageID,
      "invalidMessageID",
      options.maxIdChars,
      "afterMessageID",
      lang,
    ),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
    requestID: requireBoundedId(data.requestID, "invalidRequestID", "requestID", options, lang),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
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
    directory: optionalBoundedString(
      data.directory,
      "invalidDirectory",
      options.maxPathChars,
      "directory",
      lang,
    ),
    cursor: optionalBoundedString(
      data.cursor,
      "invalidCursor",
      options.maxIdChars,
      "cursor",
      lang,
    ),
    order: validateOrder(data.order, lang),
    archived:
      data.archived === undefined || data.archived === null
        ? undefined
        : optionalBoolean(data.archived, "invalidInput", lang, false),
    parentID: optionalBoundedString(
      data.parentID,
      "invalidParentID",
      options.maxIdChars,
      "parentID",
      lang,
    ),
    subpath: optionalBoundedString(
      data.subpath,
      "invalidSubpath",
      options.maxPathChars,
      "subpath",
      lang,
    ),
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
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
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
      options.maxPermissionFieldChars,
    ),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type CompactInput = {
  sessionID: string
  id?: string
  delivery: "steer" | "queue"
  wait: boolean
  timeoutMs: number
  maxOutputChars: number
}

export function parseCompactInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): CompactInput {
  const data = record(input, lang)
  return {
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
    id: optionalBoundedString(data.id, "invalidMessageID", options.maxIdChars, "id", lang),
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
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export function parseDiagnosticsInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): { maxOutputChars: number } {
  const data = record(input, lang)
  return { maxOutputChars: maxOutput(data.maxOutputChars, lang, options) }
}

export type RemoveInput = {
  sessionID: string
  confirm: boolean
  maxOutputChars: number
}

export function parseRemoveInput(input: unknown, lang: Lang, options: BridgeOptions): RemoveInput {
  const data = record(input, lang)
  return {
    sessionID: requireBoundedId(data.sessionID, "invalidSessionID", "sessionID", options, lang),
    confirm: optionalBoolean(data.confirm, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

function optionalCommand(
  value: unknown,
  key: StringKey,
  lang: Lang,
  maxChars = 8_192,
): string | undefined {
  return optionalBoundedString(value, key, maxChars, "command", lang)
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  key: StringKey,
  lang: Lang,
): T {
  if (value === undefined || value === null) return fallback
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  throw new ValidationError(t(lang, key))
}

export type WorktreesInput = {
  action: "create" | "list" | "remove"
  count: number
  base?: string
  namePrefix: string
  branch?: string
  runID?: string
  directories?: string[]
  force: boolean
  confirm: boolean
  archiveSessions: boolean
  maxOutputChars: number
}

export function parseWorktreesInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): WorktreesInput {
  const data = record(input, lang)
  return {
    action: validateEnum(
      data.action,
      ["create", "list", "remove"] as const,
      "list",
      "invalidAction",
      lang,
    ),
    count: integerOption(data.count, "invalidCount", lang, 1, options.maxWorktrees, 1, true, {
      min: 1,
      max: options.maxWorktrees,
    }),
    base: optionalBoundedString(
      data.base,
      "invalidBase",
      options.maxIdChars,
      "base",
      lang,
    ),
    namePrefix:
      optionalBoundedString(
        data.namePrefix,
        "invalidNamePrefix",
        64,
        "namePrefix",
        lang,
      ) ?? "sb",
    branch: optionalBoundedString(
      data.branch,
      "invalidBranch",
      options.maxIdChars,
      "branch",
      lang,
    ),
    runID: optionalBoundedString(
      data.runID,
      "invalidRunID",
      options.maxIdChars,
      "runID",
      lang,
    ),
    directories: stringArray(
      data.directories,
      "invalidDirectories",
      lang,
      Math.max(options.maxWorktrees, 32),
      options.maxPathChars,
      "directories",
    ),
    force: optionalBoolean(data.force, "invalidInput", lang, false),
    confirm: optionalBoolean(data.confirm, "invalidInput", lang, false),
    archiveSessions: optionalBoolean(data.archiveSessions, "invalidInput", lang, true),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type WaitManyInput = {
  sessionIDs: string[]
  messageIDs?: Record<string, string>
  timeoutMs: number
  perSessionTimeoutMs?: number
  mode: "any" | "all"
  returnOnPermission: boolean
  maxOutputChars: number
}

export function parseWaitManyInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): WaitManyInput {
  const data = record(input, lang)
  const sessionIDs = stringArray(
    data.sessionIDs,
    "invalidSessionIDs",
    lang,
    options.maxWaitSessions,
    options.maxIdChars,
    "sessionIDs",
  )
  if (!sessionIDs?.length) throw new ValidationError(t(lang, "invalidSessionIDs"))
  const rawMessageIDs = stringRecord(data.messageIDs, "invalidMessageIDs", lang, 32, options.maxIdChars)
  return {
    sessionIDs,
    messageIDs: rawMessageIDs,
    timeoutMs: integerOption(
      data.timeoutMs,
      "invalidTimeout",
      lang,
      1,
      3_600_000,
      options.defaultTimeoutMs,
      false,
    ),
    perSessionTimeoutMs:
      data.perSessionTimeoutMs === undefined || data.perSessionTimeoutMs === null
        ? undefined
        : integerOption(
            data.perSessionTimeoutMs,
            "invalidTimeout",
            lang,
            1,
            600_000,
            options.defaultTimeoutMs,
            false,
          ),
    mode: validateEnum(data.mode, ["any", "all"] as const, "any", "invalidWaitMode", lang),
    returnOnPermission: optionalBoolean(data.returnOnPermission, "invalidInput", lang, true),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type RaceInput = {
  prompt: string
  count: number
  mode: "worktrees" | "same-directory"
  base?: string
  models?: string[]
  agents?: string[]
  permissions?: PermissionRuleInput[]
  testCommand?: string
  setupCommand?: string
  teardownCommand?: string
  env?: Record<string, string>
  cwd?: string
  timeoutMs: number
  testTimeoutMs: number
  keepWorktrees: boolean
  snapshot: "auto" | "commit" | "patch"
  maxDiffBytes: number
  maxTestOutputChars: number
  runID?: string
  maxOutputChars: number
}

export function parseRaceInput(input: unknown, lang: Lang, options: BridgeOptions): RaceInput {
  const data = record(input, lang)
  return {
    prompt: requirePrompt(data.prompt, lang, options.maxPromptChars),
    count: integerOption(
      data.count,
      "invalidCount",
      lang,
      2,
      options.maxRaceCandidates,
      3,
      true,
      { min: 2, max: options.maxRaceCandidates },
    ),
    mode: validateEnum(
      data.mode,
      ["worktrees", "same-directory"] as const,
      "worktrees",
      "invalidRaceMode",
      lang,
    ),
    base: optionalBoundedString(data.base, "invalidBase", options.maxIdChars, "base", lang),
    models: stringArray(
      data.models,
      "invalidModel",
      lang,
      options.maxRaceCandidates,
      options.maxModelChars,
      "models",
    )?.map((value) => {
      if (!parseModel(value)) throw new ValidationError(t(lang, "invalidModel"))
      return value
    }),
    agents: stringArray(
      data.agents,
      "invalidAgent",
      lang,
      options.maxRaceCandidates,
      options.maxAgentChars,
      "agents",
    ),
    permissions: validatePermissionRules(
      data.permissions,
      lang,
      options.allowPermissionRules,
      options.maxPermissionRules,
      options.maxPermissionFieldChars,
    ),
    testCommand: optionalCommand(data.testCommand, "invalidCommand", lang),
    setupCommand: optionalCommand(data.setupCommand, "invalidCommand", lang),
    teardownCommand: optionalCommand(data.teardownCommand, "invalidCommand", lang),
    env: stringRecord(data.env, "invalidEnv", lang, 32, 4_096),
    cwd: optionalBoundedString(data.cwd, "invalidDirectory", options.maxPathChars, "cwd", lang),
    timeoutMs: integerOption(
      data.timeoutMs,
      "invalidTimeout",
      lang,
      1_000,
      3_600_000,
      options.maxRaceWallClockMs,
      false,
    ),
    testTimeoutMs: integerOption(
      data.testTimeoutMs,
      "invalidTimeout",
      lang,
      1_000,
      600_000,
      options.gitTimeoutMs,
      false,
    ),
    keepWorktrees: optionalBoolean(data.keepWorktrees, "invalidInput", lang, true),
    snapshot: validateEnum(
      data.snapshot,
      ["auto", "commit", "patch"] as const,
      "auto",
      "invalidSnapshot",
      lang,
    ),
    maxDiffBytes: integerOption(
      data.maxDiffBytes,
      "invalidMaxDiff",
      lang,
      1_000,
      options.maxDiffBytes,
      options.maxDiffBytes,
      true,
      { min: 1_000, max: options.maxDiffBytes },
    ),
    maxTestOutputChars: integerOption(
      data.maxTestOutputChars,
      "invalidMaxOutput",
      lang,
      100,
      options.maxTestOutputChars,
      options.maxTestOutputChars,
      true,
      { min: 100, max: options.maxTestOutputChars },
    ),
    runID: optionalBoundedString(data.runID, "invalidRunID", options.maxIdChars, "runID", lang),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type ApplyInput = {
  raceID: string
  candidateID: string
  targetDirectory?: string
  strategy: "apply" | "cherry-pick"
  verifyCommand?: string
  dryRun: boolean
  commit: boolean
  commitMessage?: string
  confirm: boolean
  push: boolean
  maxOutputChars: number
}

export function parseApplyInput(input: unknown, lang: Lang, options: BridgeOptions): ApplyInput {
  const data = record(input, lang)
  return {
    raceID: requireBoundedId(data.raceID, "invalidRaceID", "raceID", options, lang),
    candidateID: requireBoundedId(
      data.candidateID,
      "invalidCandidateID",
      "candidateID",
      options,
      lang,
    ),
    targetDirectory: optionalBoundedString(
      data.targetDirectory,
      "invalidDirectory",
      options.maxPathChars,
      "targetDirectory",
      lang,
    ),
    strategy: validateEnum(
      data.strategy,
      ["apply", "cherry-pick"] as const,
      "apply",
      "invalidStrategy",
      lang,
    ),
    verifyCommand: optionalCommand(data.verifyCommand, "invalidCommand", lang),
    // Applying changes to the user's tree is opt-in and dry-run by default.
    dryRun: optionalBoolean(data.dryRun, "invalidInput", lang, true),
    commit: optionalBoolean(data.commit, "invalidInput", lang, false),
    commitMessage: optionalLimitedString(
      data.commitMessage,
      "invalidMessage",
      "messageTooLong",
      options.maxTitleChars,
      lang,
    ),
    confirm: requireBoolean(data.confirm, "invalidConfirm", lang),
    push: optionalBoolean(data.push, "invalidInput", lang, false),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type RaceStatusInput = { raceID?: string; maxOutputChars: number }

export function parseRaceStatusInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): RaceStatusInput {
  const data = record(input, lang)
  return {
    raceID: optionalBoundedString(data.raceID, "invalidRaceID", options.maxIdChars, "raceID", lang),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}

export type RaceCleanupInput = {
  raceID: string
  confirm: boolean
  force: boolean
  archiveSessions: boolean
  maxOutputChars: number
}

export function parseRaceCleanupInput(
  input: unknown,
  lang: Lang,
  options: BridgeOptions,
): RaceCleanupInput {
  const data = record(input, lang)
  return {
    raceID: requireBoundedId(data.raceID, "invalidRaceID", "raceID", options, lang),
    confirm: requireBoolean(data.confirm, "invalidConfirm", lang),
    force: optionalBoolean(data.force, "invalidInput", lang, false),
    archiveSessions: optionalBoolean(data.archiveSessions, "invalidInput", lang, true),
    maxOutputChars: maxOutput(data.maxOutputChars, lang, options),
  }
}
