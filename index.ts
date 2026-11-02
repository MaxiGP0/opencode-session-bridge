import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./src/options.ts"
import { loadOwnedSessions } from "./src/registry.ts"
import { registerTools } from "./src/tools.ts"
import type { Lang, PluginContext } from "./src/types.ts"

const LANGUAGE_KEY = "language"

/**
 * Orchestrator only: options, language, owned-session registry, and tool
 * registration. Pure formatting, i18n, validation, and waiting live in src/.
 */
export default Plugin.define({
  id: "session-bridge",
  async setup(ctx: PluginContext) {
    const options = parseOptions(ctx.options as Record<string, unknown>)
    const stored = await ctx.storage?.get(LANGUAGE_KEY).catch(() => undefined)
    let language: Lang = stored === "es" || stored === "en" ? stored : options.language
    const ownedSessions = await loadOwnedSessions(ctx)

    const setLanguage = async (lang: Lang) => {
      language = lang
      await ctx.storage?.set(LANGUAGE_KEY, lang).catch(() => undefined)
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
      })
    })
  },
})

export {
  assistantText,
  capOutput,
  collectRecentTools,
  compact,
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
  renderTranscript,
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
  ToolPartLike,
  TurnResult,
  TurnState,
} from "./src/types.ts"
