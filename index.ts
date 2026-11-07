import { Plugin } from "@opencode/plugin"
import { createLiveState, type LiveState } from "./src/live.ts"
import { parseOptions } from "./src/options.ts"
import { loadOpenSessions, loadOwnedSessions } from "./src/registry.ts"
import { registerTools, type ToolExecutionResult } from "./src/tools.ts"
import type { Lang, PluginContext, SessionEventLike } from "./src/types.ts"

const LANGUAGE_KEY = "language"
const LIVE_EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
] as const

type RegistrationLike = {
  dispose: () => Promise<void> | void
}

async function consumeLiveEvents(
  ctx: PluginContext,
  signal: AbortSignal,
  liveState: LiveState,
): Promise<void> {
  try {
    const stream = ctx.event.subscribe({
      types: [...LIVE_EVENT_TYPES],
      signal,
    })
    for await (const event of stream) {
      liveState.applyEvent(event as unknown as SessionEventLike)
    }
  } catch {
    // Live events are an optional enhancement; status/wait keep working
    // through session.wait, transcript timestamps, and polling.
  }
}

/**
 * Orchestrator only: options, language, owned-session registry, live state, and
 * tool registration. Pure formatting, i18n, validation, and waiting live in src/.
 */
export default Plugin.define({
  id: "session-bridge",
  async setup(ctx: PluginContext) {
    const options = parseOptions(ctx.options as Record<string, unknown>)
    let stored: unknown
    try {
      stored = await ctx.storage?.get(LANGUAGE_KEY)
    } catch {
      stored = undefined
    }
    let language: Lang = stored === "es" || stored === "en" ? stored : options.language
    const ownedSessions = await loadOwnedSessions(ctx)
    const openSessions = await loadOpenSessions(ctx)
    const inFlightOpens = new Map<string, Promise<ToolExecutionResult>>()
    const liveState = createLiveState({
      ttlMs: options.queueTtlMs,
      maxPerSession: options.maxQueuedPrompts,
    })
    const registrations: RegistrationLike[] = []
    const liveController = new AbortController()

    if (typeof ctx.session.hook === "function") {
      try {
        const registration = await ctx.session.hook("prompt", (input) => {
          liveState.notePrompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            delivery: input.delivery,
          })
        })
        registrations.push(registration)
      } catch {
        // Prompt hooks are experimental and optional.
      }
    }
    if (typeof ctx.event?.subscribe === "function") {
      void consumeLiveEvents(ctx, liveController.signal, liveState)
    }

    const setLanguage = async (lang: Lang) => {
      language = lang
      try {
        await ctx.storage?.set(LANGUAGE_KEY, lang)
      } catch {
        // The in-memory language still applies if storage is unavailable.
      }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "sessions",
        description: "Open, observe, and control other OpenCode sessions",
      })
      registerTools(editor, {
        ctx,
        options,
        getLanguage: () => language,
        setLanguage,
        ownedSessions,
        openSessions,
        liveState,
        inFlightOpens,
      })
    })

    return async () => {
      liveController.abort()
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // Unloading must not fail because a hook was already disposed.
        }
      }
      liveState.clear()
    }
  },
})

export {
  assistantText,
  assistantTextInfo,
  capOutput,
  collectRecentTools,
  compact,
  extractText,
  fitBudget,
  formatError,
  formatSummary,
  isRunning,
  lastAssistant,
  lastIdle,
  lastUser,
  modelRef,
  parseModel,
  permissionLine,
  reasoningText,
  renderTranscript,
  renderTranscriptDetailed,
  sanitizeTitle,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
  toolsOf,
  truncateCodePoints,
} from "./src/format.ts"
export { localize, STRINGS, t } from "./src/i18n.ts"
export type {
  Lang,
  MessageLike,
  PermissionLike,
  QueuedPrompt,
  RetryInfo,
  SessionStatusLike,
  ToolPartLike,
  TurnResult,
  TurnState,
} from "./src/types.ts"
