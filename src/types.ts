import { Plugin } from "@opencode/plugin"

/**
 * Context passed to `Plugin.define().setup`. Deriving it from the installed
 * plugin package keeps this project honest about the 2.2.5 contract without
 * importing private client paths.
 */
export type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type SessionInfo = Awaited<ReturnType<PluginContext["session"]["get"]>>
export type SessionMessage = Awaited<ReturnType<PluginContext["session"]["context"]>>[number]
export type SessionInboxUser = Awaited<ReturnType<PluginContext["session"]["prompt"]>>
export type SessionListResponse = Awaited<ReturnType<PluginContext["session"]["list"]>>
export type PermissionRequest = Awaited<ReturnType<PluginContext["permission"]["list"]>>[number]
export type ToolEditor = Parameters<Parameters<PluginContext["tool"]["transform"]>[0]>[0]
export type RegisteredTool = Parameters<ToolEditor["add"]>[0]
export type ToolExecuteContext = Parameters<RegisteredTool["execute"]>[1]

export type Lang = "es" | "en"

export type ModelRefLike = {
  providerID: string
  id: string
  variant?: string
}

export type MessageTime = {
  created?: number
  completed?: number
  streamed?: number
}

/**
 * Minimal structural view of a projected session message. The API union is
 * wider, but helpers only need these fields; keeping this local makes the pure
 * helpers usable from tests without constructing the full schema.
 */
export type MessageLike = {
  id?: string
  type?: string
  text?: string
  time?: MessageTime
  content?: unknown[]
  error?: { message?: string; status?: number; type?: string }
  outcome?: string
  finish?: string
  model?: ModelRefLike
  agent?: string
  status?: string
  command?: string
  shellID?: string
  output?: { output?: string }
  summary?: string
  reason?: string
  files?: unknown[]
}

export type ToolPartLike = {
  type?: string
  id?: string
  name?: string
  state?: {
    status?: string
    input?: unknown
    error?: { message?: string }
    content?: unknown[]
  }
}

export type SessionTimeLike = {
  time?: {
    busy?: number
    idle?: number
    updated?: number
    created?: number
    archived?: number
  }
  outcome?: string
}

export type PermissionLike = {
  id: string
  sessionID?: string
  action: string
  resources?: string[]
  save?: string[]
  metadata?: unknown
  message?: string
}

export type TurnState = "idle" | "timeout" | "aborted" | "permission" | "error"

export type TurnResult = {
  state: TurnState
  messages: MessageLike[]
  startIndex: number
  idle?: MessageLike
  lastError?: string
  pendingPermissions?: PermissionLike[]
  elapsedMs: number
  fetchCount: number
  promptMessageID?: string
  queued?: boolean
}

/**
 * Events consumed by the wait loop. This is a structural subset of the
 * installed V2 event union, which avoids importing private generated types.
 */
export type SessionEventLike = {
  type: string
  data?: {
    sessionID?: string
    error?: { message?: string; status?: number }
    reason?: string
  }
}

export type ProgressInfo = {
  elapsedMs: number
  fetchCount: number
  lastEvent?: string
}

export type WaitContext = Pick<PluginContext, "session" | "permission" | "event">
