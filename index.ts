import { Plugin } from "@opencode/plugin"
import { runGit } from "./src/git.ts"
import { createLiveState, type LiveBackground, type LiveState } from "./src/live.ts"
import { parseOptions } from "./src/options.ts"
import { loadRaces, persistRaces } from "./src/races.ts"
import {
  createRegistryPersistence,
  getProcessWorkerSessions,
  loadOpenSessions,
  loadOwnedSessions,
  loadWorkerSessions,
  persistWorkerSessions,
} from "./src/registry.ts"
import {
  registerTools,
  type OpenInflight,
  type SendInflight,
  type SentMessages,
} from "./src/tools.ts"
import type { Lang, PluginContext, SessionEventLike } from "./src/types.ts"
import { loadWorktrees, persistWorktrees } from "./src/worktrees.ts"
import { sleep } from "./src/wait.ts"

const LANGUAGE_KEY = "language"
const LIVE_EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
] as const
const LIVE_RECONNECT_MIN_MS = 1_000
const LIVE_RECONNECT_MAX_MS = 30_000

type RegistrationLike = {
  dispose: () => Promise<void> | void
}

async function consumeLiveEvents(
  ctx: PluginContext,
  signal: AbortSignal,
  liveState: LiveState,
): Promise<void> {
  let backoff = LIVE_RECONNECT_MIN_MS
  while (!signal.aborted) {
    let received = false
    try {
      const stream = ctx.event.subscribe({
        types: [...LIVE_EVENT_TYPES],
        signal,
      })
      for await (const event of stream) {
        received = true
        liveState.applyEvent(event as unknown as SessionEventLike)
      }
    } catch {
      // Live events are an optional enhancement; status/wait keep working
      // through session.wait, transcript timestamps, and polling.
    }
    if (signal.aborted) break
    if (received) backoff = LIVE_RECONNECT_MIN_MS
    const waited = await sleep(backoff, signal)
    if (!waited) break
    backoff = Math.min(backoff * 2, LIVE_RECONNECT_MAX_MS)
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
    const workerSessions = await loadWorkerSessions(ctx)
    const worktrees = await loadWorktrees(ctx)
    const races = await loadRaces(ctx)
    const registry = createRegistryPersistence(ctx, ownedSessions, openSessions)
    const inFlightOpens = new Map<string, OpenInflight>()
    const inFlightSends = new Map<string, SendInflight>()
    const sentMessages: SentMessages = new Map()
    const liveState = createLiveState({
      ttlMs: options.queueTtlMs,
      pendingTtlMs: options.livePendingTtlMs,
      maxPerSession: options.maxQueuedPrompts,
    })
    const registrations: RegistrationLike[] = []
    const liveController = new AbortController()

    const refreshWorkers = async () => {
      const loaded = await loadWorkerSessions(ctx)
      for (const [sessionID, entry] of loaded) workerSessions.set(sessionID, entry)
      for (const [sessionID, entry] of getProcessWorkerSessions()) workerSessions.set(sessionID, entry)
    }

    if (typeof ctx.session.hook === "function") {
      try {
        const registration = await ctx.session.hook("experimental.idle", (input) => {
          const background = Array.isArray(input?.background)
            ? (input.background as unknown as LiveBackground[])
            : []
          liveState.noteIdleBackground(String(input?.sessionID ?? ""), background)
        })
        registrations.push(registration)
      } catch {
        // The experimental idle hook is optional; waitAny then cannot detect
        // background shells/subagents and reports the model idle only.
      }
    }
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
        inFlightSends,
        sentMessages,
        registry,
        workerSessions,
        worktrees,
        races,
        git: runGit,
        refreshWorkers,
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
      await registry.dispose()
      await Promise.allSettled([
        persistWorkerSessions(ctx, workerSessions),
        persistWorktrees(ctx, worktrees),
        persistRaces(ctx, races),
      ])
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
  oneLine,
  parseModel,
  permissionLine,
  reasoningText,
  renderTranscript,
  renderTranscriptDetailed,
  sanitizeTitle,
  stripAnsi,
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
