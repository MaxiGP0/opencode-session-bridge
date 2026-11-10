import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "../index.ts"
import { runGit } from "../src/git.ts"
import { PLUGIN_VERSION } from "../src/version.ts"
import type { DirectoryValidator } from "../src/orchestration.ts"
import type { GitRunner } from "../src/git.ts"
import type {
  Lang,
  MessageLike,
  PermissionLike,
  PluginContext,
  SessionEventLike,
  ToolExecuteContext,
} from "../src/types.ts"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

type FakeSession = {
  id: string
  title?: string
  parentID?: string
  outcome?: string
  agent?: string
  model?: { providerID: string; id: string }
  cost?: unknown
  tokens?: unknown
  time: { created: number; updated: number; busy?: number; idle?: number; archived?: number }
  location?: { directory: string }
}

type FakeAdmission = {
  id: string
  sessionID: string
  time: { created: number }
  type: "user"
  payload: { text: string }
  delivery: "steer" | "queue"
}

type FakeToolResult = {
  content?: string
  output?: unknown
  metadata?: unknown
}

type FakeTool = {
  name: string
  input?: unknown
  output?: unknown
  execute: (input: unknown, context: FakeToolContext) => Promise<FakeToolResult>
}

type FakeToolContext = {
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  signal: AbortSignal
  progress: (update: Record<string, unknown>) => Promise<void>
}

type HarnessOptions = {
  options?: Record<string, unknown>
  sessions?: FakeSession[]
  messages?: Record<string, MessageLike[]>
  permissions?: Record<string, PermissionLike[]>
  waitMode?: "resolve" | "reject" | "missing" | "delay"
  autoComplete?: boolean
  contextSnapshots?: MessageLike[][]
  promptError?: Error
  failPromptOnce?: boolean
  contextError?: Error
  contextDelayMs?: number
  permissionListError?: Error
  assertError?: Error
  /** Scripted per-call assert errors; undefined means allow. */
  assertErrors?: Array<Error | undefined>
  cursorNext?: string | null
  modelDefault?: unknown
  createGate?: Promise<void>
  promptGate?: Promise<void>
  createConflictOnce?: boolean
  enableLive?: boolean
  worktreeMissing?: boolean
  worktreeRoot?: string
  worktreeStrategy?: string
  worktreeDirty?: boolean
  locationMismatch?: boolean
  initialRaces?: unknown[]
  initialWorktrees?: unknown[]
  initialWorkers?: unknown[]
  git?: GitRunner
  validateDirectory?: DirectoryValidator
  vcsFiles?: unknown[]
  repoDirectory?: string
  realWorktrees?: boolean
  onPrompt?: (input: {
    sessionID: string
    text: string
    id?: string
    index: number
    directory: string
  }) => void | Promise<void>
}

function fakeSession(id: string, overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id,
    title: `Title ${id}`,
    time: { created: 1, updated: 2 },
    location: { directory: "C:/repo" },
    ...overrides,
  }
}

function makeHarness(options: HarnessOptions = {}) {
  const tools = new Map<string, FakeTool>()
  const repoDirectory = options.repoDirectory ?? "C:/repo"
  const worktreeRoot = options.worktreeRoot ?? path.join(repoDirectory, ".worktrees")
  const worktreeEntries = new Map<string, { directory: string; strategy?: string }>()
  const worktreeCreateCalls: Array<Record<string, unknown>> = []
  const worktreeRemoveCalls: Array<Record<string, unknown>> = []
  const sessions = new Map<string, FakeSession>()
  const messages = new Map<string, MessageLike[]>()
  const permissions = new Map<string, PermissionLike[]>()
  const storage = new Map<string, unknown>()
  if (options.initialRaces) storage.set("session-bridge:races", options.initialRaces)
  if (options.initialWorktrees) storage.set("session-bridge:worktrees", options.initialWorktrees)
  if (options.initialWorkers) storage.set("session-bridge:workers", options.initialWorkers)
  const promptCalls: Array<{ sessionID: string; text: string; id?: string; delivery?: string }> = []
  const admissions = new Map<string, FakeAdmission>()
  const updateCalls: Array<Record<string, unknown>> = []
  const createInputs: Array<Record<string, unknown>> = []
  const removeCalls: string[] = []
  const replyCalls: Array<Record<string, unknown>> = []
  const switchModelCalls: Array<Record<string, unknown>> = []
  const switchAgentCalls: Array<Record<string, unknown>> = []
  const listCalls: Array<Record<string, unknown>> = []
  const assertCalls: Array<Record<string, unknown>> = []
  let createCalls = 0
  let contextCalls = 0
  let waitCalls = 0
  let sessionGetCalls = 0
  let modelDefaultCalls = 0
  let promptCounter = 0
  let now = 1_000
  const hooks = new Map<string, (input: unknown) => void | Promise<void>>()
  const eventItems: SessionEventLike[] = []
  let eventWake: (() => void) | undefined
  const emit = (event: SessionEventLike) => {
    eventItems.push(event)
    const wake = eventWake
    eventWake = undefined
    wake?.()
  }
  const liveStream = (signal?: AbortSignal): AsyncIterable<SessionEventLike> => ({
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        const next = eventItems.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            if (eventWake === done) eventWake = undefined
            resolve()
          }
          eventWake = done
          signal?.addEventListener("abort", done, { once: true })
          if (signal?.aborted) done()
        })
      }
    },
  })

  const initialSessions = options.sessions ?? [
    fakeSession("ses_1"),
    fakeSession("ses_caller", { model: { providerID: "p", id: "m" } }),
  ]
  for (const session of initialSessions) {
    if (!session.location || session.location.directory === "C:/repo") {
      session.location = { directory: repoDirectory }
    }
    sessions.set(session.id, session)
  }
  for (const [sessionID, list] of Object.entries(options.messages ?? {})) {
    messages.set(sessionID, list)
  }
  for (const [sessionID, list] of Object.entries(options.permissions ?? {})) {
    permissions.set(sessionID, list)
  }

  const interruptCalls: Array<Record<string, unknown>> = []
  const compactCalls: Array<Record<string, unknown>> = []
  let permissionCalls = 0
  const ctx = {
    options: options.options ?? {},
    location: {
      directory: repoDirectory,
      project: {
        id: "proj_1",
        directory: repoDirectory,
        canonical: repoDirectory,
      },
    },
    event: options.enableLive
      ? {
          subscribe: (subscribeOptions?: { signal?: AbortSignal }) =>
            liveStream(subscribeOptions?.signal),
        }
      : undefined,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    model: {
      default: async () => {
        modelDefaultCalls++
        return options.modelDefault ?? { providerID: "p", id: "m" }
      },
    },
    vcs: {
      status: async (input: { location?: { directory?: string } }) => {
        const directory = input?.location?.directory ?? repoDirectory
        if (options.realWorktrees && directory) {
          const result = await runGit(["status", "--porcelain=v1"], directory)
          const data = result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => ({
              file: line.slice(3).trim(),
              additions: 0,
              deletions: 0,
              status: "modified" as const,
            }))
          return { location: { directory }, data }
        }
        return {
          location: { directory },
          data: options.worktreeDirty
            ? [{ file: "dirty.txt", additions: 1, deletions: 0, status: "modified" }]
            : [],
        }
      },
      diff: async (input: { location?: { directory?: string } }) => ({
        location: { directory: input?.location?.directory ?? repoDirectory },
        data: options.vcsFiles ?? [],
      }),
    },
    worktree: options.worktreeMissing
      ? undefined
      : {
          create: async (input: {
            projectID: string
            name?: string
            directory?: string
            branch?: string
          }) => {
            worktreeCreateCalls.push(input as Record<string, unknown>)
            const directory =
              input.directory ?? path.join(worktreeRoot, input.name ?? `wt_${worktreeEntries.size + 1}`)
            if (options.realWorktrees) {
              await mkdir(worktreeRoot, { recursive: true })
              const added = await runGit(
                ["worktree", "add", "-b", input.name ?? `wt_${worktreeEntries.size + 1}`, directory, input.branch ?? "HEAD"],
                repoDirectory,
              )
              if (added.exitCode !== 0) throw new Error(added.stderr || "git worktree add failed")
            } else {
              await mkdir(directory, { recursive: true }).catch(() => undefined)
            }
            worktreeEntries.set(directory, {
              directory,
              strategy: options.worktreeStrategy ?? "worktree",
            })
            return { directory }
          },
          list: async () => [...worktreeEntries.values()],
          remove: async (input: { directory: string; force?: boolean }) => {
            worktreeRemoveCalls.push(input as Record<string, unknown>)
            if (options.realWorktrees) {
              await runGit(["worktree", "remove", "--force", input.directory], repoDirectory)
            }
            worktreeEntries.delete(input.directory)
          },
        },
    session: {
      hook: options.enableLive
        ? async (name: string, callback: (input: unknown) => void | Promise<void>) => {
            hooks.set(name, callback)
            return { dispose: async () => undefined }
          }
        : undefined,
      get: async (input: { sessionID: string }) => {
        sessionGetCalls++
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error(`session not found: ${input.sessionID}`)
        return session
      },
      create: async (input: {
        id?: string
        title?: string
        agent?: string
        model?: unknown
        location?: { directory?: string }
      }) => {
        createCalls++
        createInputs.push(input as Record<string, unknown>)
        if (options.createGate) await options.createGate
        const location = options.locationMismatch
          ? { directory: "C:/elsewhere" }
          : { directory: input.location?.directory ?? repoDirectory }
        if (options.createConflictOnce && input.id && !sessions.has(input.id)) {
          const created = fakeSession(input.id, {
            title: input.title,
            agent: input.agent,
            model: input.model as FakeSession["model"],
            location,
            time: { created: now++, updated: now },
          })
          sessions.set(input.id, created)
          throw new Error(`session already exists: ${input.id}`)
        }
        if (input.id && sessions.has(input.id)) {
          throw new Error(`session already exists: ${input.id}`)
        }
        const id = input.id ?? (sessions.has("ses_new") ? `ses_new_${createCalls}` : "ses_new")
        const created = fakeSession(id, {
          title: input.title,
          agent: input.agent,
          model: input.model as FakeSession["model"],
          location,
          time: { created: now++, updated: now },
        })
        sessions.set(id, created)
        return created
      },
      prompt: async (input: {
        sessionID: string
        text: string
        id?: string
        delivery?: "steer" | "queue"
      }) => {
        if (input.id && !input.id.startsWith("msg_")) {
          throw new Error('Expected a string starting with "msg_"\n  at ["id"]')
        }
        promptCalls.push({
          sessionID: input.sessionID,
          text: input.text,
          id: input.id,
          delivery: input.delivery,
        })
        if (options.promptGate) await options.promptGate
        if (options.promptError && (!options.failPromptOnce || promptCalls.length === 1)) {
          throw options.promptError
        }
        let admission = input.id ? admissions.get(input.id) : undefined
        if (!admission) {
          const id = input.id ?? `msg_${++promptCounter}`
          admission = {
            id,
            sessionID: input.sessionID,
            time: { created: now++ },
            type: "user",
            payload: { text: input.text },
            delivery: input.delivery ?? "steer",
          }
          admissions.set(id, admission)
          const session = sessions.get(input.sessionID)
          if (options.onPrompt && session) {
            await options.onPrompt({
              sessionID: input.sessionID,
              text: input.text,
              id,
              index: promptCalls.length - 1,
              directory: session.location?.directory ?? repoDirectory,
            })
          }
          const list = messages.get(input.sessionID) ?? []
          list.push({ id, type: "user", text: input.text, time: { created: admission.time.created } })
          if (options.autoComplete !== false) {
            list.push({
              id: `${id}_answer`,
              type: "assistant",
              content: [{ type: "text", text: "answer" }],
              time: { created: admission.time.created + 1 },
            })
            list.push({
              id: `${id}_idle`,
              type: "idle",
              outcome: "succeeded",
              time: { created: admission.time.created + 2 },
            })
          }
          messages.set(input.sessionID, list)
        }
        return admission
      },
      context: async (
        input: { sessionID: string },
        requestOptions?: { signal?: AbortSignal },
      ) => {
        contextCalls++
        if (options.contextDelayMs) {
          await delayWithSignal(options.contextDelayMs, requestOptions?.signal)
        }
        if (options.contextError) throw options.contextError
        if (options.contextSnapshots?.length) {
          return options.contextSnapshots[Math.min(contextCalls - 1, options.contextSnapshots.length - 1)]
        }
        return messages.get(input.sessionID) ?? []
      },
      wait: options.waitMode === "missing"
        ? undefined
        : async () => {
            waitCalls++
            if (options.waitMode === "reject") throw new Error("wait unsupported")
            if (options.waitMode === "delay") await delay(5)
          },
      switchModel: async (input: Record<string, unknown>) => {
        switchModelCalls.push(input)
      },
      switchAgent: async (input: Record<string, unknown>) => {
        switchAgentCalls.push(input)
      },
      interrupt: async (input: Record<string, unknown>) => {
        interruptCalls.push(input)
        return { interrupted: true }
      },
      compact: async (input: Record<string, unknown>) => {
        compactCalls.push(input)
        const id = String(input.id ?? `cmp_${compactCalls.length}`)
        const created = now++
        const entry = {
          id,
          sessionID: String(input.sessionID),
          time: { created },
          type: "compaction" as const,
          payload: {},
          delivery: input.delivery ?? "steer",
        }
        const list = messages.get(String(input.sessionID)) ?? []
        list.push({ id, type: "compaction", status: "completed", time: { created } })
        if (options.autoComplete !== false) {
          list.push({
            id: `${id}_idle`,
            type: "idle",
            outcome: "succeeded",
            time: { created: created + 1 },
          })
        }
        messages.set(String(input.sessionID), list)
        return entry
      },
      list: async (input: Record<string, unknown>) => {
        listCalls.push(input)
        return { data: [...sessions.values()], cursor: { next: options.cursorNext ?? null } }
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input)
        const session = sessions.get(String(input.sessionID))
        if (session) {
          if (typeof input.title === "string") session.title = input.title
          if (typeof input.archived === "boolean") {
            session.time.archived = input.archived ? now++ : undefined
          }
        }
      },
      remove: async (input: { sessionID: string }) => {
        removeCalls.push(input.sessionID)
        sessions.delete(input.sessionID)
        messages.delete(input.sessionID)
      },
    },
    permission: {
      list: async (input: { sessionID: string }) => {
        permissionCalls++
        if (options.permissionListError) throw options.permissionListError
        return permissions.get(input.sessionID) ?? []
      },
      reply: async (input: Record<string, unknown>) => {
        replyCalls.push(input)
        const list = permissions.get(String(input.sessionID)) ?? []
        permissions.set(
          String(input.sessionID),
          list.filter((request) => request.id !== input.requestID),
        )
      },
      assert: async (input: Record<string, unknown>) => {
        assertCalls.push(input)
        if (options.assertError) throw options.assertError
        const scripted = options.assertErrors?.shift()
        if (scripted) throw scripted
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: () => undefined,
          add: (tool: FakeTool) => {
            tools.set(tool.name, tool)
          },
          list: () => [],
          get: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        })
        return { dispose: async () => undefined }
      },
    },
  }

  const state = {
    sessions,
    messages,
    permissions,
    storage,
    promptCalls,
    admissions,
    updateCalls,
    createInputs,
    removeCalls,
    replyCalls,
    switchModelCalls,
    switchAgentCalls,
    listCalls,
    assertCalls,
    interruptCalls,
    compactCalls,
    worktreeCreateCalls,
    worktreeRemoveCalls,
    worktreeEntries,
    hooks,
    emit,
    async callHook(name: string, input: unknown) {
      await ready
      await hooks.get(name)?.(input)
    },
    get createCalls() {
      return createCalls
    },
    get contextCalls() {
      return contextCalls
    },
    get waitCalls() {
      return waitCalls
    },
    get sessionGetCalls() {
      return sessionGetCalls
    },
    get modelDefaultCalls() {
      return modelDefaultCalls
    },
    get permissionCalls() {
      return permissionCalls
    },
  }

  const ready = plugin.setup(ctx as unknown as PluginContext)

  const executeRaw = async (
    name: string,
    input: unknown,
    context: Partial<FakeToolContext> = {},
  ) => {
    await ready
    const tool = tools.get(name)
    if (!tool) throw new Error(`missing tool: ${name}`)
    return tool.execute(input, {
      sessionID: "ses_caller",
      agent: "build",
      messageID: "msg_caller",
      id: "call_1",
      signal: new AbortController().signal,
      progress: async () => undefined,
      ...context,
    })
  }

  return {
    tools,
    state,
    ready,
    executeRaw,
    emit,
    async callHook(name: string, input: unknown) {
      await ready
      await hooks.get(name)?.(input)
    },
    async execute(name: string, input: unknown, context: Partial<FakeToolContext> = {}) {
      const result = await executeRaw(name, input, context)
      return result.content ?? ""
    },
  }
}

function tool(index: number) {
  return {
    type: "tool",
    id: `tool_${index}`,
    name: "read",
    state: {
      status: "completed",
      input: { path: `file-${index}.txt` },
      content: [{ type: "text", text: `body-${index}` }],
    },
  }
}

type NumericBranch = { const?: number; minimum?: number; maximum?: number }
type NumericSchema = NumericBranch & { anyOf?: NumericBranch[] }

function numericSchema(tool: FakeTool | undefined, field: string): NumericSchema {
  const input = tool?.input as
    | { properties?: Record<string, NumericSchema> }
    | undefined
  return input?.properties?.[field] ?? {}
}

function branchAccepts(branch: NumericBranch, value: number): boolean {
  if (branch.const !== undefined) return value === branch.const
  if (branch.minimum !== undefined && value < branch.minimum) return false
  if (branch.maximum !== undefined && value > branch.maximum) return false
  return true
}

function schemaAccepts(schema: NumericSchema, value: number): boolean {
  if (schema.anyOf) return schema.anyOf.some((branch) => branchAccepts(branch, value))
  return branchAccepts(schema, value)
}

function permissionAt(index: number): PermissionLike {
  return {
    id: `per_${index}`,
    sessionID: "ses_1",
    action: "shell",
    resources: [`echo ${index}`],
  }
}

async function makeTempRepo(): Promise<{
  directory: string
  base: string
  cleanup: () => Promise<void>
}> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "session-bridge-repo-")))
  const init = await runGit(["init", "-b", "main"], directory)
  if (init.exitCode !== 0) {
    await runGit(["init"], directory)
    await runGit(["checkout", "-b", "main"], directory)
  }
  await runGit(["config", "user.name", "test"], directory)
  await runGit(["config", "user.email", "test@localhost"], directory)
  await writeFile(path.join(directory, "base.txt"), "base\n", "utf8")
  await runGit(["add", "."], directory)
  await runGit(["commit", "-m", "base"], directory)
  const head = await runGit(["rev-parse", "HEAD"], directory)
  return {
    directory,
    base: head.stdout.trim(),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

describe("sessions tools", () => {
  it("rejects allow permission rules by default and accepts them with opt-in", async () => {
    const denied = makeHarness()
    const deniedContent = await denied.execute("open", {
      prompt: "hi",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    expect(deniedContent).toContain("allowPermissionRules")
    expect(denied.state.createCalls).toBe(0)

    const allowed = makeHarness({ options: { allowPermissionRules: true } })
    const allowedContent = await allowed.execute("open", {
      prompt: "hi",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    expect(allowedContent).toContain("Session created: ses_new")
    expect(allowed.state.createCalls).toBe(1)
  })

  it("uses model.default's data wrapper when the caller has no model", async () => {
    const harness = makeHarness({
      sessions: [fakeSession("ses_caller")],
      modelDefault: {
        location: { directory: "C:/repo" },
        data: { id: "m", modelID: "m", providerID: "p" },
      },
    })
    await harness.execute("open", { prompt: "hi" })
    expect(harness.state.createInputs[0]?.model).toEqual({ providerID: "p", id: "m" })
  })

  it("anchors open and send on the admitted prompt ID", async () => {
    const harness = makeHarness()
    const content = await harness.execute("open", { prompt: "hi", messageID: "msg_fixed" })
    expect(harness.state.promptCalls[0]?.id).toBe("msg_fixed")
    expect(content).toContain("Message ID: msg_fixed")
    expect(harness.state.contextCalls).toBeLessThanOrEqual(2)
  })

  it("derives msg_ prompt IDs from arbitrary idempotency keys", async () => {
    const harness = makeHarness()
    const first = await harness.executeRaw("open", {
      prompt: "hi",
      messageID: "custom-open-key",
    })
    expect(first.output).toMatchObject({ state: "idle" })
    const firstID = harness.state.promptCalls[0]?.id
    expect(firstID).toMatch(/^msg_/)
    expect(firstID).not.toBe("custom-open-key")

    const retry = await harness.executeRaw("open", {
      prompt: "hi",
      messageID: "custom-open-key",
    })
    expect(retry.output).toMatchObject({ state: "idle", reused: true })
    expect(harness.state.promptCalls[1]?.id).toBe(firstID)

    const sent = await harness.execute("send", {
      sessionID: "ses_new",
      prompt: "follow up",
      messageID: "custom-send-key",
    })
    expect(sent).toContain("Message ID: msg_")
    expect(harness.state.promptCalls.at(-1)?.id).toMatch(/^msg_/)
    expect(harness.state.promptCalls.at(-1)?.id).not.toBe("custom-send-key")
  })

  it("send with queue waits for the exact queued turn", async () => {
    const old = [
      { id: "old", type: "user", text: "old prompt", time: { created: 1 } },
      { id: "old-answer", type: "assistant", content: [{ type: "text", text: "old answer" }], time: { created: 2 } },
      { id: "old-idle", type: "idle", outcome: "succeeded", time: { created: 3 } },
    ]
    const queued = [
      ...old,
      { id: "msg_queued", type: "user", text: "queued prompt", time: { created: 10 } },
      { id: "queued-answer", type: "assistant", content: [{ type: "text", text: "queued answer" }], time: { created: 11 } },
    ]
    const harness = makeHarness({
      options: { pollIntervalMs: 50 },
      sessions: [fakeSession("ses_1"), fakeSession("ses_caller", { model: { providerID: "p", id: "m" } })],
      autoComplete: false,
      contextSnapshots: [old, queued, [...queued, { id: "queued-idle", type: "idle", outcome: "succeeded", time: { created: 12 } }]],
    })

    const content = await harness.execute("send", {
      sessionID: "ses_1",
      prompt: "queued prompt",
      delivery: "queue",
      messageID: "msg_queued",
      timeoutMs: 500,
    })
    expect(harness.state.promptCalls[0]?.delivery).toBe("queue")
    expect(content).toContain("queued answer")
    expect(content).not.toContain("old answer")
    expect(content).toContain("Message ID: msg_queued")
  })

  it("does not duplicate a retry with the same messageID", async () => {
    const harness = makeHarness()
    await harness.execute("send", { sessionID: "ses_1", prompt: "hello", messageID: "msg_same" })
    await harness.execute("send", { sessionID: "ses_1", prompt: "hello", messageID: "msg_same" })
    const users = (harness.state.messages.get("ses_1") ?? []).filter(
      (message) => message.id === "msg_same",
    )
    expect(users).toHaveLength(1)
    expect(harness.state.promptCalls).toHaveLength(1)
  })

  it("status with recent: 0 uses the default and does not show every tool", async () => {
    const tools = Array.from({ length: 100 }, (_, index) => tool(index))
    const harness = makeHarness({
      messages: {
        ses_1: [
          { id: "u1", type: "user", text: "run", time: { created: 1 } },
          { id: "a1", type: "assistant", content: tools, time: { created: 2 } },
          { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
    })
    const content = await harness.execute("status", { sessionID: "ses_1", recent: 0 })
    expect(content).toContain("Recent actions (8):")
    expect((content.match(/  · /g) ?? []).length).toBe(8)
  })

  it("read with limit: 0 uses the default instead of the whole transcript", async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `u${index}`,
      type: "user",
      text: `message ${index}`,
      time: { created: index },
    }))
    const harness = makeHarness({ messages: { ses_1: messages } })
    const content = await harness.execute("read", { sessionID: "ses_1", limit: 0 })
    expect((content.match(/User:/g) ?? []).length).toBe(30)
    expect(content).not.toContain("message 0")
  })

  it("warns when read receives an unknown afterMessageID", async () => {
    const harness = makeHarness({
      messages: {
        ses_1: [{ id: "u1", type: "user", text: "hello", time: { created: 1 } }],
      },
    })
    const content = await harness.execute("read", { sessionID: "ses_1", afterMessageID: "missing" })
    expect(content).toContain("afterMessageID not found: missing")
  })

  it("keeps 100 tools within maxOutputChars and summarizes omissions", async () => {
    const tools = Array.from({ length: 100 }, (_, index) => tool(index))
    const harness = makeHarness({
      messages: {
        ses_1: [
          { id: "u1", type: "user", text: "run", time: { created: 1 } },
          { id: "a1", type: "assistant", content: tools, time: { created: 2 } },
          { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
    })
    const content = await harness.execute("status", {
      sessionID: "ses_1",
      recent: 100,
      maxOutputChars: 2_000,
    })
    expect(content.length).toBeLessThanOrEqual(2_000)
    expect(content).toContain("60 actions omitted")
  })

  it("returns permission state quickly for wait", async () => {
    const permission: PermissionLike = {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["echo *"],
    }
    const harness = makeHarness({ permissions: { ses_1: [permission] } })
    const started = Date.now()
    const content = await harness.execute("wait", { sessionID: "ses_1", timeoutMs: 5_000 })
    expect(content).toContain("waiting for permission")
    expect(content).toContain("per_1")
    expect(Date.now() - started).toBeLessThan(300)
  })

  it("enforces reply opt-ins for always and foreign sessions", async () => {
    const denied = makeHarness()
    await denied.execute("open", { prompt: "hi" })
    const alwaysDenied = await denied.execute("reply", {
      sessionID: "ses_new",
      requestID: "per_1",
      decision: "always",
    })
    expect(alwaysDenied).toContain("allowPersistentPermissions")

    const alwaysAllowed = makeHarness({ options: { allowPersistentPermissions: true } })
    await alwaysAllowed.execute("open", { prompt: "hi" })
    const alwaysContent = await alwaysAllowed.execute("reply", {
      sessionID: "ses_new",
      requestID: "per_1",
      decision: "always",
    })
    expect(alwaysContent).toContain("approved and saved")
    expect(alwaysAllowed.state.replyCalls).toHaveLength(1)

    const onceContent = await alwaysAllowed.execute("reply", {
      sessionID: "ses_new",
      requestID: "per_2",
      decision: "once",
    })
    expect(onceContent).toContain("approved once")

    const foreign = makeHarness()
    const foreignDenied = await foreign.execute("reply", {
      sessionID: "ses_foreign",
      requestID: "per_2",
      decision: "once",
    })
    expect(foreignDenied).toContain("allowReplyToForeignSessions")

    const foreignAllowed = makeHarness({ options: { allowReplyToForeignSessions: true } })
    const foreignContent = await foreignAllowed.execute("reply", {
      sessionID: "ses_foreign",
      requestID: "per_2",
      decision: "once",
    })
    expect(foreignContent).toContain("approved once")
  })

  it("requires opt-in and explicit confirmation for remove", async () => {
    const disabled = makeHarness()
    expect(await disabled.execute("remove", { sessionID: "ses_1", confirm: true })).toContain(
      "allowSessionRemoval",
    )

    const unconfirmed = makeHarness({ options: { allowSessionRemoval: true } })
    expect(await unconfirmed.execute("remove", { sessionID: "ses_1", confirm: false })).toContain(
      "confirm: true",
    )

    const allowed = makeHarness({
      options: { allowSessionRemoval: true, allowRemoveForeignSessions: true },
    })
    expect(await allowed.execute("remove", { sessionID: "ses_1", confirm: true })).toContain(
      "Session removed",
    )
    expect(allowed.state.removeCalls).toEqual(["ses_1"])
  })

  it("updates title and archive state without deleting", async () => {
    const denied = makeHarness()
    const deniedContent = await denied.execute("update", {
      sessionID: "ses_1",
      title: "Renamed",
    })
    expect(deniedContent).toContain("allowUpdateForeignSessions")
    expect(denied.state.updateCalls).toHaveLength(0)

    const harness = makeHarness({ options: { allowUpdateForeignSessions: true } })
    const content = await harness.execute("update", {
      sessionID: "ses_1",
      title: "Renamed",
      archived: true,
    })
    expect(content).toContain("Session updated")
    expect(content).toContain("Renamed")
    expect(content).toContain("archived: yes")
    expect(harness.state.updateCalls).toHaveLength(1)
    expect(harness.state.removeCalls).toHaveLength(0)
  })

  it("rejects allow permission rules in update by default", async () => {
    const harness = makeHarness()
    const content = await harness.execute("update", {
      sessionID: "ses_1",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    expect(content).toContain("allowPermissionRules")
    expect(harness.state.updateCalls).toHaveLength(0)
  })

  it("lists with cursor, filters, and a timestamp snapshot", async () => {
    const harness = makeHarness({ cursorNext: "cursor_2" })
    const content = await harness.execute("list", { limit: 0, verbose: true })
    expect(content).toContain("Sessions:")
    expect(content).toContain("Next cursor: cursor_2")
    expect(content).toContain("Timestamp snapshot")
    expect(harness.state.listCalls[0]?.limit).toBe(10)
  })

  it("switches language and keeps assistant content untouched", async () => {
    const harness = makeHarness({
      messages: {
        ses_1: [
          {
            id: "u1",
            type: "user",
            text: "El usuario dijo: Estado: en ejecución",
            time: { created: 1 },
          },
          {
            id: "a1",
            type: "assistant",
            content: [{ type: "text", text: "Estado: en ejecución" }],
            time: { created: 2 },
          },
          { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
    })
    const spanish = await harness.execute("language", { language: "es" })
    expect(spanish).toContain("español")
    const status = await harness.execute("status", { sessionID: "ses_1" })
    expect(status).toContain("Estado:")
    expect(status).toContain("Estado: en ejecución")
    expect(status).not.toContain("State: running")
  })

  it("reports the orphan session when open creates it but the prompt fails", async () => {
    const harness = makeHarness({ promptError: new Error("prompt boom") })
    const content = await harness.execute("open", { prompt: "hi" })
    expect(content).toContain("prompt boom")
    expect(content).toContain("ses_new")
  })

  it("P0-3: wait accepts messageID for a queued turn and status reports queued", async () => {
    const oldTurn = [
      { id: "u_old", type: "user", text: "first", time: { created: 1 } },
      { id: "a_old", type: "assistant", content: [{ type: "text", text: "first answer" }], time: { created: 2 } },
      { id: "u_queued", type: "user", text: "second queued", time: { created: 3 } },
      { id: "i_old", type: "idle", outcome: "succeeded", time: { created: 4 } },
    ]
    const completedQueued = [
      ...oldTurn,
      { id: "a_queued", type: "assistant", content: [{ type: "text", text: "second answer" }], time: { created: 5 } },
      { id: "i_queued", type: "idle", outcome: "succeeded", time: { created: 6 } },
    ]
    const harness = makeHarness({
      options: { pollIntervalMs: 20 },
      autoComplete: false,
      contextSnapshots: [oldTurn, oldTurn, completedQueued],
    })

    const statusContent = await harness.execute("status", { sessionID: "ses_1" })
    expect(statusContent.toLowerCase()).toContain("queued")

    const waitContent = await harness.execute("wait", {
      sessionID: "ses_1",
      messageID: "u_queued",
      timeoutMs: 500,
    })
    expect(waitContent).toContain("second answer")
    expect(waitContent).not.toContain("first answer")
  })

  it("P0-5: registers output schemas and returns structured values for Code Mode", async () => {
    const harness = makeHarness()
    await harness.ready
    for (const name of [
      "open",
      "send",
      "status",
      "wait",
      "list",
      "permissions",
      "read",
      "reply",
      "update",
      "remove",
      "interrupt",
      "language",
      "compact",
      "diagnostics",
    ]) {
      expect(harness.tools.get(name)?.output, name).toBeTruthy()
    }

    const opened = await harness.executeRaw("open", { prompt: "hi" })
    expect(opened.output).toMatchObject({
      sessionID: "ses_new",
      state: "idle",
      messageID: "msg_1",
      outcome: "succeeded",
      lastMessageID: "msg_1_idle",
      text: "answer",
    })

    const status = await harness.executeRaw("status", { sessionID: "ses_new" })
    expect(status.output).toMatchObject({
      sessionID: "ses_new",
      state: "idle",
      running: false,
      outcome: "succeeded",
      lastMessageID: "msg_1_idle",
    })

    const waited = await harness.executeRaw("wait", { sessionID: "ses_new" })
    expect(waited.output).toMatchObject({
      sessionID: "ses_new",
      state: "idle",
      outcome: "succeeded",
      text: "answer",
    })

    const listed = await harness.executeRaw("list", {})
    expect(listed.output).toMatchObject({ sessions: expect.any(Array) })

    const permissions = await harness.executeRaw("permissions", { sessionID: "ses_new" })
    expect(permissions.output).toMatchObject({ sessionID: "ses_new", pending: [] })

    const language = await harness.executeRaw("language", {})
    expect(language.output).toMatchObject({ language: "en" })
  })

  it("P0-8: read returns at most limit after afterMessageID and exposes pagination output", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `m${index + 1}`,
      type: "user",
      text: `message ${index + 1}`,
      time: { created: index + 1 },
    }))
    const harness = makeHarness({ messages: { ses_1: messages } })
    const result = await harness.executeRaw("read", {
      sessionID: "ses_1",
      afterMessageID: "m10",
      limit: 5,
    })
    expect((result.content ?? "").match(/User:/g)).toHaveLength(5)
    expect(result.output).toMatchObject({
      sessionID: "ses_1",
      hasMore: true,
      nextAfterMessageID: "m15",
      count: 5,
    })
  })

  it("P0-6: a denied host permission rejects the tool and never runs the action", async () => {
    const harness = makeHarness({
      options: { allowReplyToForeignSessions: true },
      assertError: new Error("denied by policy"),
    })
    await expect(
      harness.executeRaw("reply", {
        sessionID: "ses_1",
        requestID: "per_1",
        decision: "once",
      }),
    ).rejects.toThrow("denied by policy")
    expect(harness.state.replyCalls).toHaveLength(0)
    expect(harness.state.assertCalls[0]).toMatchObject({
      action: "session_bridge.reply",
      resources: ["ses_1", "per_1", "once"],
      source: { type: "tool", messageID: "msg_caller", id: "call_1" },
    })
  })

  it("P0-6: dangerous actions call permission.assert with separate actions", async () => {
    const harness = makeHarness({ options: { allowSessionRemoval: true } })
    await harness.executeRaw("open", { prompt: "hi" })
    await harness.executeRaw("send", { sessionID: "ses_new", prompt: "again" })
    await harness.executeRaw("reply", {
      sessionID: "ses_new",
      requestID: "per_1",
      decision: "once",
    })
    await harness.executeRaw("update", { sessionID: "ses_new", title: "Renamed" })
    await harness.executeRaw("interrupt", { sessionID: "ses_new" })
    await harness.executeRaw("remove", { sessionID: "ses_new", confirm: true })

    expect(harness.state.assertCalls.map((call) => call.action)).toEqual([
      "session_bridge.open",
      "session_bridge.send",
      "session_bridge.reply",
      "session_bridge.update",
      "session_bridge.interrupt",
      "session_bridge.remove",
    ])
  })

  it("P0-7: open reuses an explicit sessionID and messageID without creating again", async () => {
    const harness = makeHarness()
    const first = await harness.executeRaw("open", {
      prompt: "hi",
      sessionID: "ses_fixed",
      messageID: "msg_fixed",
    })
    expect(first.output).toMatchObject({ sessionID: "ses_fixed", messageID: "msg_fixed" })

    const second = await harness.executeRaw("open", {
      prompt: "hi",
      sessionID: "ses_fixed",
      messageID: "msg_fixed",
    })
    expect(second.content).toContain("Session reused")
    expect(second.output).toMatchObject({ sessionID: "ses_fixed", state: "idle" })
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls).toHaveLength(2)
    const users = (harness.state.messages.get("ses_fixed") ?? []).filter(
      (message) => message.id === "msg_fixed",
    )
    expect(users).toHaveLength(1)
  })

  it("P0-7: open maps messageID to sessionID and recovers after a failed prompt", async () => {
    const mapped = makeHarness()
    await mapped.executeRaw("open", { prompt: "hi", messageID: "msg_map" })
    await mapped.executeRaw("open", { prompt: "hi", messageID: "msg_map" })
    expect(mapped.state.createCalls).toBe(1)

    const failed = makeHarness({
      promptError: new Error("prompt boom"),
      failPromptOnce: true,
    })
    const first = await failed.executeRaw("open", { prompt: "hi", messageID: "msg_retry" })
    expect(first.content).toContain("prompt boom")
    expect(first.output).toMatchObject({
      sessionID: "ses_new",
      state: "error",
      messageID: "msg_retry",
    })

    const retry = await failed.executeRaw("open", { prompt: "hi", messageID: "msg_retry" })
    expect(retry.output).toMatchObject({ sessionID: "ses_new", state: "idle" })
    expect(failed.state.createCalls).toBe(1)
  })

  it("P0-7: open adopts an existing session instead of creating a new one", async () => {
    const harness = makeHarness()
    const result = await harness.executeRaw("open", { prompt: "hi", sessionID: "ses_1" })
    expect(result.content).toContain("Session reused")
    expect(harness.state.createCalls).toBe(0)
    expect(harness.state.promptCalls[0]?.sessionID).toBe("ses_1")
  })

  it("P1-1: open with an explicit model skips caller and default model lookups", async () => {
    const harness = makeHarness()
    await harness.execute("open", { prompt: "hi", model: "anthropic/claude#fast" })
    expect(harness.state.sessionGetCalls).toBe(1)
    expect(harness.state.modelDefaultCalls).toBe(0)
    expect(harness.state.createInputs[0]?.model).toEqual({
      providerID: "anthropic",
      id: "claude",
      variant: "fast",
    })
  })

  it("P1-3: status without text or tools avoids reading the transcript", async () => {
    const harness = makeHarness()
    const content = await harness.execute("status", {
      sessionID: "ses_1",
      includeTools: false,
      includeText: false,
    })
    expect(harness.state.contextCalls).toBe(0)
    expect(content).toContain("State:")
    expect(content).not.toContain("Last text")
    expect(content).not.toContain("Recent actions")
  })

  it("P1-3: status reports running instead of a stale outcome and keeps lastOutcome in output", async () => {
    const harness = makeHarness({
      sessions: [
        fakeSession("ses_busy", {
          time: { created: 1, updated: 5, busy: 10, idle: 5 },
        }),
      ],
      messages: {
        ses_busy: [
          { id: "u1", type: "user", text: "run", time: { created: 1 } },
          {
            id: "a1",
            type: "assistant",
            content: [{ type: "text", text: "old answer" }],
            time: { created: 2 },
          },
          { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
    })
    const result = await harness.executeRaw("status", { sessionID: "ses_busy" })
    expect(result.content).toContain("Result: running")
    expect(result.content).not.toContain("Result: succeeded")
    expect(result.output).toMatchObject({
      state: "running",
      running: true,
      lastOutcome: "succeeded",
    })
  })

  it("P1-3: status reads queued state without a transcript call", async () => {
    const harness = makeHarness()
    const sent = await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "queued",
      delivery: "queue",
      wait: false,
      messageID: "msg_q",
    })
    expect(sent.output).toMatchObject({ state: "queued", messageID: "msg_q" })

    const status = await harness.execute("status", {
      sessionID: "ses_1",
      includeTools: false,
      includeText: false,
    })
    expect(harness.state.contextCalls).toBe(0)
    expect(status.toLowerCase()).toContain("queued")
    expect(status).toContain("msg_q")
  })

  it("P1-3: status exposes the last prompt ID when the session is idle", async () => {
    const harness = makeHarness({
      messages: {
        ses_1: [
          { id: "u_last", type: "user", text: "prompt", time: { created: 1 } },
          {
            id: "a_last",
            type: "assistant",
            content: [{ type: "text", text: "answer" }],
            time: { created: 2 },
          },
          { id: "i_last", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
    })
    const result = await harness.executeRaw("status", { sessionID: "ses_1" })
    expect(result.output).toMatchObject({
      promptMessageID: "u_last",
      lastMessageID: "i_last",
      state: "idle",
    })
    expect(result.content).toContain("Message ID: u_last")
    expect(result.content).toContain("Last message: i_last")
  })

  it("P0-4: status keeps IDs, errors, and permissions under a tight budget", async () => {
    const manyTools = Array.from({ length: 40 }, (_, index) => tool(index))
    const harness = makeHarness({
      sessions: [
        fakeSession("ses_busy", {
          time: { created: 1, updated: 5, busy: 10, idle: 5 },
        }),
      ],
      messages: {
        ses_busy: [
          { id: "u_prompt", type: "user", text: "run", time: { created: 1 } },
          {
            id: "a_last",
            type: "assistant",
            content: [{ type: "text", text: "long ".repeat(1_000) }, ...manyTools],
            error: { message: "provider exploded" },
            time: { created: 2 },
          },
          { id: "i_last", type: "idle", outcome: "failed", time: { created: 3 } },
        ],
      },
      permissions: {
        ses_busy: [
          {
            id: "per_crit_1",
            sessionID: "ses_busy",
            action: "shell",
            resources: ["npm test"],
          },
        ],
      },
    })
    const result = await harness.executeRaw("status", {
      sessionID: "ses_busy",
      maxOutputChars: 1_000,
    })
    const content = result.content ?? ""
    expect(content.length).toBeLessThanOrEqual(1_000)
    for (const value of [
      "ses_busy",
      "State:",
      "Message ID: u_prompt",
      "Last message: i_last",
      "per_crit_1",
      "provider exploded",
    ]) {
      expect(content, value).toContain(value)
    }
  })

  it("P0-2: JSON Schemas accept 0 as default and reject negative values", async () => {
    const harness = makeHarness()
    await harness.ready
    const zeroCases: Array<[string, string]> = [
      ["read", "limit"],
      ["status", "recent"],
      ["list", "limit"],
      ["permissions", "limit"],
    ]
    for (const [toolName, field] of zeroCases) {
      const schema = numericSchema(harness.tools.get(toolName), field)
      expect(schema.minimum, `${toolName}.${field}`).toBe(0)
      expect(schemaAccepts(schema, 0), `${toolName}.${field}`).toBe(true)
      expect(schemaAccepts(schema, -1), `${toolName}.${field}`).toBe(false)
    }
    for (const [toolName, field, minimum] of [
      ["status", "maxOutputChars", 1_000],
      ["open", "maxOutputChars", 1_000],
      ["read", "maxOutputChars", 1_000],
      ["status", "maxText", 100],
    ] as const) {
      const schema = numericSchema(harness.tools.get(toolName), field)
      expect(schema.anyOf, `${toolName}.${field}`).toBeTruthy()
      expect(schemaAccepts(schema, 0), `${toolName}.${field} 0`).toBe(true)
      expect(schemaAccepts(schema, minimum), `${toolName}.${field} min`).toBe(true)
      expect(schemaAccepts(schema, minimum - 1), `${toolName}.${field} below`).toBe(false)
      expect(schemaAccepts(schema, -1), `${toolName}.${field} negative`).toBe(false)
    }
    const timeout = numericSchema(harness.tools.get("open"), "timeoutMs")
    expect(timeout.minimum).toBe(1)
    expect(schemaAccepts(timeout, 0)).toBe(false)

    expect(
      (await harness.executeRaw("read", { sessionID: "ses_1", limit: 0 })).output,
    ).toMatchObject({ sessionID: "ses_1" })
    expect(
      (
        await harness.executeRaw("status", {
          sessionID: "ses_1",
          recent: 0,
          maxText: 0,
          maxOutputChars: 0,
        })
      ).output,
    ).toMatchObject({ sessionID: "ses_1" })
    expect((await harness.executeRaw("list", { limit: 0 })).output).toMatchObject({
      sessions: expect.any(Array),
    })
    expect(
      (await harness.executeRaw("open", { prompt: "hi", maxOutputChars: 0 })).output,
    ).toMatchObject({ state: "idle" })

    const negative = await harness.executeRaw("read", { sessionID: "ses_1", limit: -1 })
    expect(negative.output).toMatchObject({ state: "error" })
    const zeroTimeout = await harness.executeRaw("open", { prompt: "hi", timeoutMs: 0 })
    expect(zeroTimeout.output).toMatchObject({ state: "error" })
  })

  it("P0-1: status bounds text, title, and pending permissions but keeps critical fields", async () => {
    const huge = "x".repeat(100_000)
    const pending = Array.from({ length: 1_000 }, (_, index) => permissionAt(index))
    const harness = makeHarness({
      sessions: [fakeSession("ses_1", { title: "t".repeat(10_000) })],
      messages: {
        ses_1: [
          { id: "u1", type: "user", text: "run", time: { created: 1 } },
          {
            id: "a1",
            type: "assistant",
            content: [{ type: "text", text: huge }],
            error: { message: "assistant boom" },
            time: { created: 2 },
          },
          { id: "i1", type: "idle", outcome: "failed", time: { created: 3 } },
        ],
      },
      permissions: { ses_1: pending },
    })
    const result = await harness.executeRaw("status", {
      sessionID: "ses_1",
      maxOutputChars: 1_000,
    })
    const output = result.output as Record<string, unknown>
    expect((result.content ?? "").length).toBeLessThanOrEqual(1_000)
    expect(output.sessionID).toBe("ses_1")
    expect(output.state).toBe("permission")
    expect(output.lastMessageID).toBe("i1")
    expect(output.promptMessageID).toBe("u1")
    expect(String(output.error)).toContain("assistant boom")
    expect((output.text as string).length).toBeLessThanOrEqual(4_000)
    expect(output.textTruncated).toBe(true)
    expect(output.textLength).toBe(100_000)
    expect((output.title as string).length).toBeLessThanOrEqual(500)
    const pendingOutput = output.pendingPermissions as Array<{ id: string }>
    expect(pendingOutput.length).toBeLessThanOrEqual(20)
    expect(output.pendingTotal).toBe(1_000)
    expect(output.pendingTruncated).toBe(true)
    expect(pendingOutput[0]?.id).toBe("per_0")
  })

  it("P0-1/P1-3: permissions and list outputs bound arrays and titles", async () => {
    const pending = Array.from({ length: 1_000 }, (_, index) => permissionAt(index))
    const permissionHarness = makeHarness({ permissions: { ses_1: pending } })
    const permissions = await permissionHarness.executeRaw("permissions", {
      sessionID: "ses_1",
      limit: 5,
    })
    const pendingOutput = permissions.output as {
      pending: Array<{ id: string }>
      pendingTotal: number
      hasMore: boolean
    }
    expect(pendingOutput.pending).toHaveLength(5)
    expect(pendingOutput.pendingTotal).toBe(1_000)
    expect(pendingOutput.hasMore).toBe(true)
    expect(pendingOutput.pending[0]?.id).toBe("per_0")
    expect((permissions.content ?? "").length).toBeLessThanOrEqual(20_000)

    const sessions = Array.from({ length: 100 }, (_, index) =>
      fakeSession(`ses_${index}`, { title: "t".repeat(10_000) }),
    )
    const listHarness = makeHarness({ sessions })
    const listed = await listHarness.executeRaw("list", { limit: 10 })
    const listOutput = listed.output as { sessions: Array<Record<string, unknown>> }
    expect(listOutput.sessions).toHaveLength(10)
    expect((listOutput.sessions[0]?.title as string).length).toBeLessThanOrEqual(500)
    expect(listOutput.sessions[0]).not.toHaveProperty("cost")
    expect(listOutput.sessions[0]).not.toHaveProperty("tokens")
    expect((listed.content ?? "").length).toBeLessThanOrEqual(20_000)
  })

  it("P0-3: every validation and API error returns a structured output", async () => {
    const harness = makeHarness()
    const cases: Array<[string, unknown]> = [
      ["open", { prompt: "" }],
      ["send", { sessionID: "ses_1", prompt: "" }],
      ["status", { sessionID: "" }],
      ["wait", { sessionID: "" }],
      ["permissions", { sessionID: "" }],
      ["reply", { sessionID: "ses_1", requestID: "per_1", decision: "nope" }],
      ["read", { sessionID: "", limit: 0 }],
      ["interrupt", { sessionID: "" }],
      ["list", { limit: -1 }],
      ["language", { language: "fr" }],
      ["update", { sessionID: "", title: "x" }],
      ["remove", { sessionID: "", confirm: true }],
    ]
    for (const [name, input] of cases) {
      const result = await harness.executeRaw(name, input)
      const output = result.output as Record<string, unknown> | undefined
      expect(output, name).toBeTruthy()
      expect(output?.state, name).toBe("error")
      expect(String(output?.error ?? ""), name).not.toBe("")
      expect(result.content, name).toBeTruthy()
    }

    const missing = await harness.executeRaw("status", { sessionID: "ses_missing" })
    expect(missing.output).toMatchObject({ state: "error", sessionID: "ses_missing" })
    expect(String((missing.output as Record<string, unknown>).error)).toContain("not found")
    const failing = makeHarness({ contextError: new Error("context boom") })
    const readFailed = await failing.executeRaw("read", { sessionID: "ses_1" })
    expect(readFailed.output).toMatchObject({ state: "error", sessionID: "ses_1" })
    expect(String((readFailed.output as Record<string, unknown>).error)).toContain("context boom")
    const statusFailed = await failing.executeRaw("status", {
      sessionID: "ses_1",
      maxOutputChars: 2_000,
    })
    expect(statusFailed.output).toMatchObject({ state: "error", sessionID: "ses_1" })
    expect(String((statusFailed.output as Record<string, unknown>).error)).toContain("context boom")
    const waitFailed = await failing.executeRaw("wait", {
      sessionID: "ses_1",
      timeoutMs: 500,
    })
    expect(waitFailed.output).toMatchObject({ state: "error", sessionID: "ses_1" })
  })

  it("P0-4: concurrent open with the same messageID creates one session and one prompt", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ createGate: gate })
    const first = harness.executeRaw("open", { prompt: "hola", messageID: "msg_x" })
    const second = harness.executeRaw("open", { prompt: "hola", messageID: "msg_x" })
    await delay(0)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls.filter((call) => call.id === "msg_x")).toHaveLength(1)
    expect((one.output as Record<string, unknown>).sessionID).toBe(
      (two.output as Record<string, unknown>).sessionID,
    )
  })

  it("P0-4: concurrent open with an explicit sessionID creates once", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ createGate: gate })
    const first = harness.executeRaw("open", { prompt: "hola", sessionID: "ses_fixed" })
    const second = harness.executeRaw("open", { prompt: "hola", sessionID: "ses_fixed" })
    await delay(0)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls).toHaveLength(1)
    expect((one.output as Record<string, unknown>).sessionID).toBe("ses_fixed")
    expect((two.output as Record<string, unknown>).sessionID).toBe("ses_fixed")
  })

  it("P0-4: a shared open failure does not create a second session", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({
      promptError: new Error("prompt boom"),
      promptGate: gate,
    })
    const first = harness.executeRaw("open", { prompt: "hola", messageID: "msg_fail" })
    const second = harness.executeRaw("open", { prompt: "hola", messageID: "msg_fail" })
    await delay(0)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls).toHaveLength(1)
    expect(one.output).toMatchObject({ state: "error" })
    expect(two.output).toMatchObject({ state: "error" })
    expect(String((two.output as Record<string, unknown>).error)).toContain("prompt boom")
  })

  it("P0-4: open recovers from an already-exists create race with session.get", async () => {
    const harness = makeHarness({ createConflictOnce: true })
    const result = await harness.executeRaw("open", {
      prompt: "hi",
      sessionID: "ses_race",
    })
    expect(result.output).toMatchObject({ sessionID: "ses_race", state: "idle" })
    expect(harness.state.createCalls).toBe(1)
  })

  it("P0-6: background queue is FIFO and wait uses the first prompt", async () => {
    const harness = makeHarness({ autoComplete: false })
    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "first",
      delivery: "queue",
      wait: false,
      messageID: "msg_q1",
    })
    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "second",
      delivery: "queue",
      wait: false,
      messageID: "msg_q2",
    })
    const status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({
      queued: true,
      queuedCount: 2,
      queuedMessageIDs: ["msg_q1", "msg_q2"],
      nextQueuedMessageID: "msg_q1",
    })

    const list = harness.state.messages.get("ses_1") ?? []
    const lastTime = list.reduce(
      (max, message) => Math.max(max, message.time?.created ?? 0),
      0,
    )
    list.push({
      id: "a_q1",
      type: "assistant",
      content: [{ type: "text", text: "first answer" }],
      time: { created: lastTime + 1 },
    })
    list.push({
      id: "i_q1",
      type: "idle",
      outcome: "succeeded",
      time: { created: lastTime + 2 },
    })
    harness.state.messages.set("ses_1", list)

    const waited = await harness.executeRaw("wait", { sessionID: "ses_1", timeoutMs: 500 })
    expect(waited.content).toContain("first answer")
    expect(waited.output).toMatchObject({ state: "idle", messageID: "msg_q1" })
    const after = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(after.output).toMatchObject({
      queued: true,
      queuedCount: 1,
      queuedMessageIDs: ["msg_q2"],
    })
  })

  it("P0-6: interrupt and remove clear the queue, and entries expire by TTL", async () => {
    const harness = makeHarness({
      options: {
        allowInterruptForeignSessions: true,
        allowSessionRemoval: true,
        allowRemoveForeignSessions: true,
      },
      autoComplete: false,
    })
    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "first",
      delivery: "queue",
      wait: false,
      messageID: "msg_q1",
    })
    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "second",
      delivery: "queue",
      wait: false,
      messageID: "msg_q2",
    })
    await harness.executeRaw("interrupt", { sessionID: "ses_1" })
    let status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({ queued: false, queuedCount: 0 })

    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "third",
      delivery: "queue",
      wait: false,
      messageID: "msg_q3",
    })
    await harness.executeRaw("remove", { sessionID: "ses_1", confirm: true })
    harness.state.sessions.set("ses_1", fakeSession("ses_1"))
    status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({ queued: false, queuedCount: 0 })

    const expiring = makeHarness({
      options: { queueTtlMs: 5 },
      autoComplete: false,
    })
    await expiring.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "expires",
      delivery: "queue",
      wait: false,
      messageID: "msg_ttl",
    })
    await delay(20)
    const expired = await expiring.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(expired.output).toMatchObject({ queued: false, queuedCount: 0 })
  })

  it("P1-1/P1-2: live status exposes retry, inbox queue, and prompt-hook admissions", async () => {
    const harness = makeHarness({
      enableLive: true,
      sessions: [
        fakeSession("ses_1"),
        fakeSession("ses_caller", { model: { providerID: "p", id: "m" } }),
        fakeSession("ses_foreign"),
      ],
    })
    await harness.ready

    const retryAt = Date.now() + 5_000
    harness.emit({
      type: "session.status",
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: retryAt },
      },
    })
    await delay(5)
    let status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({
      state: "retrying",
      retry: {
        attempt: 2,
        message: "rate limited",
        next: retryAt,
        retryAt: new Date(retryAt).toISOString(),
      },
    })
    const retryOutput = (status.output as Record<string, unknown>).retry as Record<string, unknown>
    expect(Number(retryOutput.retryInMs)).toBeLessThanOrEqual(5_000)
    expect(status.content).toContain("retrying")
    expect(status.content).toContain("rate limited")
    expect(status.content).toMatch(/next in [45]s/)
    expect(status.content).not.toMatch(/next in \d{6,}s/)

    harness.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await delay(5)
    status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect((status.output as Record<string, unknown> | undefined)?.state).toBe("idle")
    expect((status.output as Record<string, unknown>).retry).toBeUndefined()

    harness.emit({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_foreign",
        inboxID: "msg_foreign",
        item: { type: "user", delivery: "queue" },
      },
    })
    await delay(5)
    const foreign = await harness.executeRaw("status", {
      sessionID: "ses_foreign",
      includeText: false,
      includeTools: false,
    })
    expect(foreign.output).toMatchObject({
      queued: true,
      queuedCount: 1,
      queuedMessageIDs: ["msg_foreign"],
    })
    harness.emit({
      type: "session.inbox.delivered",
      data: { sessionID: "ses_foreign", inboxID: "msg_foreign" },
    })
    await delay(5)
    const delivered = await harness.executeRaw("status", {
      sessionID: "ses_foreign",
      includeText: false,
      includeTools: false,
    })
    expect(delivered.output).toMatchObject({ queued: false, queuedCount: 0 })

    await harness.callHook("prompt", {
      sessionID: "ses_1",
      messageID: "msg_hook",
      delivery: "queue",
    })
    const hooked = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(hooked.output).toMatchObject({
      queued: true,
      queuedMessageIDs: ["msg_hook"],
    })
  })

  it("P1-4: foreign interrupt/update require opt-in and open adopts the session", async () => {
    const denied = makeHarness()
    const deniedContent = await denied.execute("interrupt", { sessionID: "ses_1" })
    expect(deniedContent).toContain("allowInterruptForeignSessions")
    expect(denied.state.interruptCalls).toHaveLength(0)

    const adopted = makeHarness()
    await adopted.executeRaw("open", { sessionID: "ses_1", prompt: "hi" })
    const interrupted = await adopted.executeRaw("interrupt", { sessionID: "ses_1" })
    expect(interrupted.content).toContain("interrupted")
    expect(adopted.state.interruptCalls).toHaveLength(1)

    const sent = makeHarness()
    await sent.executeRaw("send", { sessionID: "ses_1", prompt: "hi" })
    const stillForeign = await sent.execute("interrupt", { sessionID: "ses_1" })
    expect(stillForeign).toContain("allowInterruptForeignSessions")

    const allowed = makeHarness({ options: { allowInterruptForeignSessions: true } })
    await allowed.executeRaw("interrupt", { sessionID: "ses_1" })
    expect(allowed.state.interruptCalls).toHaveLength(1)
  })

  it("P0-1: retry renders remaining seconds and exposes retryAt/retryInMs", async () => {
    const harness = makeHarness({ enableLive: true })
    await harness.ready
    const future = Date.now() + 5_000
    harness.emit({
      type: "session.status",
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: future },
      },
    })
    await delay(5)
    let result = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    let retry = (result.output as Record<string, unknown>).retry as Record<string, unknown>
    expect(result.content).toMatch(/next in [45]s/)
    expect(result.content).not.toMatch(/next in \d{6,}s/)
    expect(retry).toMatchObject({
      attempt: 2,
      message: "rate limited",
      next: future,
      retryAt: new Date(future).toISOString(),
    })
    expect(Number(retry.retryInMs)).toBeLessThanOrEqual(5_000)
    expect(Number(retry.retryInMs)).toBeGreaterThan(0)

    const past = Date.now() - 1_000
    harness.emit({
      type: "session.status",
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 3, message: "still limited", next: past },
      },
    })
    await delay(5)
    result = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    retry = (result.output as Record<string, unknown>).retry as Record<string, unknown>
    expect(result.content).toContain("next in 0s")
    expect(retry.retryInMs).toBe(0)
  })

  it("P0-3: status output respects the global budget and preserves critical fields", async () => {
    const resources = Array.from(
      { length: 10 },
      (_, index) => `resource-${index}-${"r".repeat(200)}`,
    )
    const save = Array.from(
      { length: 10 },
      (_, index) => `save-${index}-${"s".repeat(200)}`,
    )
    const pending = Array.from({ length: 20 }, (_, index) => ({
      id: `per_${index}`,
      sessionID: "ses_1",
      action: "shell",
      resources,
      save,
      message: "m".repeat(200),
    }))
    const manyTools = Array.from({ length: 40 }, (_, index) => ({
      type: "tool",
      id: `tool_${index}`,
      name: "read",
      state: {
        status: "completed",
        input: { path: `file-${index}-${"p".repeat(300)}` },
        content: [{ type: "text", text: "t".repeat(300) }],
      },
    }))
    const harness = makeHarness({
      options: { maxOutputTotalChars: 20_000 },
      messages: {
        ses_1: [
          { id: "u1", type: "user", text: "run", time: { created: 1 } },
          {
            id: "a1",
            type: "assistant",
            content: [{ type: "text", text: "x".repeat(100_000) }, ...manyTools],
            time: { created: 2 },
          },
          { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
        ],
      },
      permissions: { ses_1: pending },
    })
    const result = await harness.executeRaw("status", {
      sessionID: "ses_1",
      maxOutputChars: 1_000,
    })
    const output = result.output as Record<string, unknown>
    expect((result.content ?? "").length).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(20_000)
    expect(output.sessionID).toBe("ses_1")
    expect(output.state).toBe("permission")
    expect(output.lastMessageID).toBe("i1")
    expect(output.pendingTotal).toBe(20)
    expect(output.pendingTruncated).toBe(true)
    expect((output.pendingPermissions as Array<{ id: string }>)[0]?.id).toBe("per_0")
    expect(output.textTruncated).toBe(true)
    expect(output.toolsTruncated).toBe(true)
    expect(Number(output.textLength)).toBeLessThanOrEqual(100_000)
  })

  it("P0-3: permissions with a large limit also respect the global budget", async () => {
    const pending = Array.from({ length: 100 }, (_, index) => ({
      id: `per_${index}`,
      sessionID: "ses_1",
      action: "shell",
      resources: Array.from({ length: 10 }, () => "r".repeat(2_000)),
      save: Array.from({ length: 10 }, () => "s".repeat(2_000)),
      message: "m".repeat(2_000),
    }))
    const harness = makeHarness({
      options: { maxOutputTotalChars: 20_000 },
      permissions: { ses_1: pending },
    })
    const result = await harness.executeRaw("permissions", {
      sessionID: "ses_1",
      limit: 100,
    })
    const output = result.output as Record<string, unknown>
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(20_000)
    expect(output.pendingTotal).toBe(100)
    expect(output.pendingTruncated).toBe(true)
    expect((output.pending as Array<{ id: string }>)[0]?.id).toBe("per_0")
    expect((result.content ?? "").length).toBeLessThanOrEqual(20_000)
  })

  it("P0-3: read, list, and permissions report state ok", async () => {
    const harness = makeHarness()
    for (const [name, input] of [
      ["read", { sessionID: "ses_1" }],
      ["list", {}],
      ["permissions", { sessionID: "ses_1" }],
    ] as const) {
      const result = await harness.executeRaw(name, input)
      expect(result.output, name).toMatchObject({ state: "ok" })
    }
    const failed = await harness.executeRaw("read", { sessionID: "" })
    expect(failed.output).toMatchObject({ state: "error" })
  })

  it("P0-2: concurrent open with a different signature is a conflict", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ createGate: gate })
    const first = harness.executeRaw("open", {
      prompt: "first prompt",
      messageID: "msg_conflict",
    })
    await delay(10)
    const second = await harness.executeRaw("open", {
      prompt: "different prompt",
      messageID: "msg_conflict",
    })
    expect(second.output).toMatchObject({ state: "error" })
    expect(String((second.output as Record<string, unknown>).error)).toMatch(
      /different signature/i,
    )
    release()
    const one = await first
    expect(one.output).toMatchObject({ state: "idle" })
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls.filter((call) => call.id === "msg_conflict")).toHaveLength(1)
  })

  it("P0-2: a second caller cannot skip permission.assert via deduplication", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({
      createGate: gate,
      assertErrors: [undefined, new Error("denied for second caller")],
    })
    const first = harness.executeRaw("open", {
      prompt: "same prompt",
      messageID: "msg_perm",
    })
    await delay(10)
    await expect(
      harness.executeRaw("open", { prompt: "same prompt", messageID: "msg_perm" }),
    ).rejects.toThrow("denied for second caller")
    release()
    await first
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls).toHaveLength(1)
    expect(harness.state.assertCalls).toHaveLength(2)
  })

  it("P0-2: aborting one identical open caller does not cancel the other", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ createGate: gate })
    const controller = new AbortController()
    const first = harness.executeRaw(
      "open",
      { prompt: "shared prompt", messageID: "msg_abort" },
      { signal: controller.signal },
    )
    await delay(10)
    const second = harness.executeRaw("open", {
      prompt: "shared prompt",
      messageID: "msg_abort",
    })
    await delay(10)
    controller.abort()
    release()
    const [firstResult, secondResult] = await Promise.allSettled([first, second])
    expect(firstResult.status).toBe("rejected")
    if (firstResult.status === "rejected") {
      expect((firstResult.reason as Error).name).toBe("AbortError")
    }
    expect(secondResult.status).toBe("fulfilled")
    if (secondResult.status === "fulfilled") {
      expect(secondResult.value.output).toMatchObject({ state: "idle" })
    }
    expect(harness.state.createCalls).toBe(1)
    expect(harness.state.promptCalls).toHaveLength(1)
  })

  it("P0-5: remove requires ownership or an explicit opt-in", async () => {
    const foreign = makeHarness({ options: { allowSessionRemoval: true } })
    const denied = await foreign.executeRaw("remove", { sessionID: "ses_1", confirm: true })
    expect(denied.output).toMatchObject({ state: "error" })
    expect(String((denied.output as Record<string, unknown>).error)).toContain(
      "allowRemoveForeignSessions",
    )
    expect(foreign.state.removeCalls).toHaveLength(0)

    const optedIn = makeHarness({
      options: { allowSessionRemoval: true, allowRemoveForeignSessions: true },
    })
    const removed = await optedIn.executeRaw("remove", { sessionID: "ses_1", confirm: true })
    expect(removed.output).toMatchObject({ state: "ok", removed: true })
    expect(optedIn.state.removeCalls).toEqual(["ses_1"])

    const adopted = makeHarness({ options: { allowSessionRemoval: true } })
    await adopted.executeRaw("open", { sessionID: "ses_1", prompt: "adopt" })
    const adoptedResult = await adopted.executeRaw("remove", {
      sessionID: "ses_1",
      confirm: true,
    })
    expect(adoptedResult.output).toMatchObject({ state: "ok", removed: true })
    expect(adopted.state.removeCalls).toEqual(["ses_1"])
  })

  it("P0-6: send retries reuse the admission and do not reapply switches", async () => {
    const harness = makeHarness()
    const first = await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "hola",
      messageID: "msg_x",
      model: "p/other",
      agent: "build",
    })
    expect(first.output).toMatchObject({ state: "idle", alreadySent: false })
    const second = await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "hola",
      messageID: "msg_x",
      model: "p/other",
      agent: "build",
    })
    expect(second.output).toMatchObject({ state: "idle", alreadySent: true, reused: true })
    expect(harness.state.promptCalls.filter((call) => call.id === "msg_x")).toHaveLength(1)
    expect(harness.state.switchModelCalls).toHaveLength(1)
    expect(harness.state.switchAgentCalls).toHaveLength(1)

    const conflict = await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "different",
      messageID: "msg_x",
      model: "p/other",
      agent: "build",
    })
    expect(conflict.output).toMatchObject({ state: "error" })
    expect(String((conflict.output as Record<string, unknown>).error)).toContain(
      "different prompt",
    )
    expect(harness.state.promptCalls).toHaveLength(1)
  })

  it("P0-6: send skips a switch when the session already has the target model/agent", async () => {
    const harness = makeHarness({
      sessions: [
        fakeSession("ses_1", {
          model: { providerID: "p", id: "m" },
          agent: "build",
        }),
      ],
    })
    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "already",
      model: "p/m",
      agent: "build",
    })
    expect(harness.state.switchModelCalls).toHaveLength(0)
    expect(harness.state.switchAgentCalls).toHaveLength(0)

    await harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "change",
      model: "p/other",
      agent: "plan",
    })
    expect(harness.state.switchModelCalls).toHaveLength(1)
    expect(harness.state.switchAgentCalls).toHaveLength(1)
  })

  it("P0-6: concurrent send with the same messageID admits once", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ promptGate: gate })
    const first = harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "same",
      messageID: "msg_conc",
    })
    const second = harness.executeRaw("send", {
      sessionID: "ses_1",
      prompt: "same",
      messageID: "msg_conc",
    })
    await delay(10)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(one.output).toMatchObject({ state: "idle" })
    expect(two.output).toMatchObject({ state: "idle", alreadySent: false })
    expect(harness.state.promptCalls).toHaveLength(1)
  })

  it("P1-1: a host abort during create rejects instead of returning content", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({ createGate: gate })
    const controller = new AbortController()
    const promise = harness.executeRaw(
      "open",
      { prompt: "abort me" },
      { signal: controller.signal },
    )
    await delay(10)
    controller.abort()
    release()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(harness.state.createCalls).toBe(1)
  })

  it("P1-1: aborting wait propagates the host cancellation", async () => {
    const harness = makeHarness({
      options: { waitMode: "missing" },
      autoComplete: false,
      messages: {
        ses_1: [{ id: "u_run", type: "user", text: "running", time: { created: 1 } }],
      },
    })
    const controller = new AbortController()
    const promise = harness.executeRaw(
      "wait",
      { sessionID: "ses_1", timeoutMs: 5_000 },
      { signal: controller.signal },
    )
    await delay(30)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  })

  it("P1-2: wait respects the end-to-end timeout and bounds permission.list", async () => {
    const harness = makeHarness({
      options: { waitMode: "missing", requestTimeoutMs: 5_000 },
      contextDelayMs: 10_000,
      autoComplete: false,
    })
    const started = Date.now()
    const result = await harness.executeRaw("wait", {
      sessionID: "ses_1",
      timeoutMs: 1_000,
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1_400)
    expect(result.output).toMatchObject({ state: "timeout" })
    expect(harness.state.permissionCalls).toBeLessThanOrEqual(2)
  })

  it("P1-4: execution failures surface lastOutcome/lastError and stale live status is ignored", async () => {
    const failed = makeHarness({ enableLive: true })
    await failed.ready
    failed.emit({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { message: "execution boom" } },
    })
    await delay(5)
    const failedStatus = await failed.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(failedStatus.output).toMatchObject({
      state: "idle",
      lastOutcome: "failed",
      lastError: "execution boom",
    })
    expect(failedStatus.content).toContain("execution boom")

    const updated = Date.now() + 100_000
    const stale = makeHarness({
      enableLive: true,
      sessions: [
        fakeSession("ses_1", {
          time: { created: 1, updated, busy: 10, idle: 5 },
        }),
      ],
    })
    await stale.ready
    stale.emit({
      type: "session.status",
      data: { sessionID: "ses_1", status: { type: "idle" } },
    })
    await delay(5)
    const staleStatus = await stale.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(staleStatus.output).toMatchObject({
      state: "running",
      running: true,
      liveStale: true,
    })
  })

  it("P1-5: status keeps running when only the transcript fails", async () => {
    const harness = makeHarness({
      sessions: [
        fakeSession("ses_busy", {
          time: { created: 1, updated: 5, busy: 10, idle: 5 },
        }),
      ],
      contextError: new Error("transcript down"),
    })
    const result = await harness.executeRaw("status", { sessionID: "ses_busy" })
    expect(result.output).toMatchObject({
      state: "running",
      running: true,
      transcriptAvailable: false,
    })
    expect(String((result.output as Record<string, unknown>).contextError)).toContain(
      "transcript down",
    )
  })

  it("P1-5: a permission.list failure is not reported as a clean idle", async () => {
    const harness = makeHarness({ permissionListError: new Error("permissions down") })
    const result = await harness.executeRaw("status", { sessionID: "ses_1" })
    expect(result.output).toMatchObject({
      state: "error",
      permissionsAvailable: false,
    })
    expect(String((result.output as Record<string, unknown>).permissionError)).toContain(
      "permissions down",
    )
  })

  it("P1-6: interrupt resume true preserves the queue and false clears it", async () => {
    const harness = makeHarness({
      options: { allowInterruptForeignSessions: true },
      autoComplete: false,
    })
    for (const [messageID, prompt] of [
      ["msg_q1", "first"],
      ["msg_q2", "second"],
    ] as const) {
      await harness.executeRaw("send", {
        sessionID: "ses_1",
        prompt,
        delivery: "queue",
        wait: false,
        messageID,
      })
    }
    const resumed = await harness.executeRaw("interrupt", {
      sessionID: "ses_1",
      resume: true,
    })
    expect(resumed.output).toMatchObject({
      state: "ok",
      queueCleared: false,
      queueResumed: 2,
      queuedCount: 2,
    })
    let status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({ queued: true, queuedCount: 2 })

    const cleared = await harness.executeRaw("interrupt", {
      sessionID: "ses_1",
      resume: false,
    })
    expect(cleared.output).toMatchObject({
      state: "ok",
      queueCleared: true,
      queueResumed: 0,
    })
    status = await harness.executeRaw("status", {
      sessionID: "ses_1",
      includeText: false,
      includeTools: false,
    })
    expect(status.output).toMatchObject({ queued: false, queuedCount: 0 })
  })

  it("P1-8: read does not advance past a partially rendered message", async () => {
    const harness = makeHarness({
      messages: {
        ses_1: [
          { id: "prev", type: "user", text: "previous", time: { created: 1 } },
          { id: "huge", type: "user", text: "x".repeat(100_000), time: { created: 2 } },
        ],
      },
    })
    const partial = await harness.executeRaw("read", {
      sessionID: "ses_1",
      afterMessageID: "prev",
      maxOutputChars: 1_000,
    })
    expect(partial.output).toMatchObject({
      partial: true,
      partialMessageID: "huge",
      nextAfterMessageID: "prev",
      state: "ok",
    })
    expect((partial.content ?? "").length).toBeLessThanOrEqual(1_000)

    const complete = await harness.executeRaw("read", {
      sessionID: "ses_1",
      afterMessageID: "prev",
      maxOutputChars: 20_000,
    })
    expect(complete.output).toMatchObject({
      partial: false,
      nextAfterMessageID: "huge",
    })
    expect(complete.content).toContain("User: xxx")
  })

  it("P0-4: identifiers are bounded and prompts count code points", async () => {
    const harness = makeHarness()
    const tooLong = await harness.executeRaw("status", { sessionID: "s".repeat(10_000) })
    expect(tooLong.output).toMatchObject({ state: "error" })
    expect(String((tooLong.output as Record<string, unknown>).error)).toContain("sessionID")

    const emojis = "😀".repeat(60_000)
    const opened = await harness.executeRaw("open", { prompt: emojis })
    expect(opened.output).toMatchObject({ state: "idle" })
    expect(harness.state.createCalls).toBe(1)
  })

  it("P0-4: update sanitizes titles before persisting and rendering", async () => {
    const harness = makeHarness({ options: { allowUpdateForeignSessions: true } })
    const result = await harness.executeRaw("update", {
      sessionID: "ses_1",
      title: "a\nb\r\u2028c\u001b[31mRED\u001b[0m",
    })
    const title = harness.state.updateCalls[0]?.title
    expect(title).toBe("a b cRED")
    expect(String(title)).not.toMatch(/[\r\n\u2028\u2029\x1b]/)
    expect(result.content).not.toMatch(/\u001b/)
  })

  it("P2: compact requires opt-in and waits for the compaction anchor", async () => {
    const disabled = makeHarness()
    const denied = await disabled.executeRaw("compact", { sessionID: "ses_1" })
    expect(denied.output).toMatchObject({ state: "error" })
    expect(disabled.state.compactCalls).toHaveLength(0)

    const harness = makeHarness({
      options: { allowCompact: true, allowUpdateForeignSessions: true },
    })
    const result = await harness.executeRaw("compact", {
      sessionID: "ses_1",
      wait: true,
    })
    expect(result.output).toMatchObject({ state: "idle", compactionID: "cmp_1" })
    expect(harness.state.compactCalls).toHaveLength(1)
  })

  it("P2: diagnostics reports capabilities and bounded state", async () => {
    const harness = makeHarness()
    await harness.executeRaw("open", { prompt: "hi" })
    const result = await harness.executeRaw("diagnostics", {})
    expect(result.output).toMatchObject({
      version: PLUGIN_VERSION,
      state: "ok",
      capabilities: expect.any(Object),
      registry: expect.any(Object),
      live: expect.any(Object),
      queues: expect.any(Object),
    })
    // Code Mode requires a pure JSON value: no nested `undefined`.
    expect(JSON.parse(JSON.stringify(result.output))).toEqual(result.output)
    expect(JSON.stringify(result.output).length).toBeLessThanOrEqual(20_000)
  })
})

const idleMessages = (prefix: string): MessageLike[] => [
  { id: `${prefix}_user`, type: "user", text: "do it", time: { created: 1 } },
  { id: `${prefix}_answer`, type: "assistant", content: [{ type: "text", text: "done" }], time: { created: 2 } },
  { id: `${prefix}_idle`, type: "idle", outcome: "succeeded", time: { created: 3 } },
]

describe("orchestration tools", () => {
  it("O-1: open({directory}) passes location and registers a worker", async () => {
    const repo = await makeTempRepo()
    try {
      const worktree = path.join(repo.directory, "wt-a")
      await mkdir(worktree, { recursive: true })
      const harness = makeHarness({ repoDirectory: repo.directory })
      const result = await harness.executeRaw("open", {
        prompt: "hi",
        directory: worktree,
      })
      expect(harness.state.createInputs[0]?.location).toEqual({ directory: worktree })
      const permissions = harness.state.createInputs[0]?.permissions as
        | Array<{ action: string; effect: string }>
        | undefined
      expect(
        permissions?.some(
          (rule) => rule.action === "session_bridge.open" && rule.effect === "deny",
        ),
      ).toBe(true)
      expect(result.output).toMatchObject({
        directory: worktree,
        role: "worker",
        locationVerified: true,
      })
    } finally {
      await repo.cleanup()
    }
  })

  it("O-1: aborts and cleans up when the host creates the session elsewhere", async () => {
    const harness = makeHarness({ locationMismatch: true })
    const result = await harness.executeRaw("open", { prompt: "hi" })
    expect(result.output).toMatchObject({ state: "error" })
    expect(harness.state.promptCalls).toHaveLength(0)
    expect(harness.state.removeCalls).toContain("ses_new")
  })

  it("O-1: reusing a messageID in another directory is a conflict", async () => {
    const repo = await makeTempRepo()
    try {
      const first = path.join(repo.directory, "wt-a")
      const second = path.join(repo.directory, "wt-b")
      await mkdir(first, { recursive: true })
      await mkdir(second, { recursive: true })
      const harness = makeHarness({ repoDirectory: repo.directory })
      await harness.execute("open", {
        prompt: "hi",
        messageID: "msg_same",
        directory: first,
      })
      const result = await harness.executeRaw("open", {
        prompt: "hi",
        messageID: "msg_same",
        directory: second,
      })
      expect(result.output).toMatchObject({ state: "error" })
      expect(harness.state.createCalls).toBe(1)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-1: applies permissions to a reused session instead of ignoring them", async () => {
    const harness = makeHarness()
    const result = await harness.executeRaw("open", {
      sessionID: "ses_1",
      prompt: "hi",
      permissions: [{ action: "shell", resource: "echo *", effect: "deny" }],
    })
    expect(result.output).toMatchObject({ reused: true, permissionsApplied: true })
    expect(harness.state.updateCalls.at(-1)?.permissions).toEqual([
      { action: "shell", resource: "echo *", effect: "deny" },
    ])
  })

  it("O-1: rejects a reused session whose location differs from the target", async () => {
    const repo = await makeTempRepo()
    try {
      const worktree = path.join(repo.directory, "wt-a")
      await mkdir(worktree, { recursive: true })
      const harness = makeHarness({
        repoDirectory: repo.directory,
        sessions: [fakeSession("ses_1", { location: { directory: repo.directory } })],
      })
      const result = await harness.executeRaw("open", {
        sessionID: "ses_1",
        prompt: "hi",
        directory: worktree,
      })
      expect(result.output).toMatchObject({ state: "error" })
      expect(harness.state.promptCalls).toHaveLength(0)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-0: the owner in main manages a worker in another directory", async () => {
    const repo = await makeTempRepo()
    try {
      const worktree = path.join(repo.directory, "wt-a")
      await mkdir(worktree, { recursive: true })
      const harness = makeHarness({ repoDirectory: repo.directory })
      const opened = await harness.executeRaw("open", {
        prompt: "hi",
        directory: worktree,
      })
      const sessionID = String((opened.output as Record<string, unknown>).sessionID)
      const reply = await harness.executeRaw("reply", {
        sessionID,
        requestID: "per_1",
        decision: "once",
      })
      expect(reply.output).toMatchObject({ state: "ok" })
      const status = await harness.executeRaw("status", { sessionID })
      expect(status.output).toMatchObject({ sessionID, state: "idle" })
      const read = await harness.executeRaw("read", { sessionID })
      expect(read.output).toMatchObject({ sessionID, state: "ok" })
      const wait = await harness.executeRaw("wait", { sessionID, timeoutMs: 100 })
      expect(wait.output).toMatchObject({ sessionID, state: "idle" })
      const listed = await harness.executeRaw("list", { directory: worktree })
      expect(listed.output).toMatchObject({ directory: worktree, state: "ok" })
      await harness.executeRaw("interrupt", { sessionID })
      await harness.executeRaw("update", { sessionID, title: "renamed" })
      expect(harness.state.interruptCalls).toHaveLength(1)
      expect(harness.state.updateCalls.some((call) => call.sessionID === sessionID)).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-0: a foreign caller cannot manage the worker", async () => {
    const repo = await makeTempRepo()
    try {
      const worktree = path.join(repo.directory, "wt-a")
      await mkdir(worktree, { recursive: true })
      const harness = makeHarness({ repoDirectory: repo.directory })
      const opened = await harness.executeRaw("open", {
        prompt: "hi",
        directory: worktree,
      })
      const sessionID = String((opened.output as Record<string, unknown>).sessionID)
      const denied = await harness.executeRaw(
        "interrupt",
        { sessionID },
        { sessionID: "ses_other" },
      )
      expect(denied.output).toMatchObject({ state: "error" })
      expect(harness.state.interruptCalls).toHaveLength(0)

      const adoption = await harness.executeRaw(
        "open",
        { sessionID, prompt: "adopt" },
        { sessionID: "ses_other" },
      )
      expect(adoption.output).toMatchObject({ state: "error" })
      expect(
        harness.state.promptCalls.filter((call) => call.text === "adopt"),
      ).toHaveLength(0)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-0: worker sessions cannot use orchestration tools", async () => {
    const worker = {
      sessionID: "ses_worker",
      at: Date.now(),
      targetDirectory: "C:/worktree-a",
      role: "worker",
    }
    const deniedHarness = makeHarness({ initialWorkers: [worker] })
    const denied = await deniedHarness.executeRaw("list", {}, { sessionID: "ses_worker" })
    expect(denied.output).toMatchObject({ state: "error", worker: true })

    const allowedHarness = makeHarness({
      initialWorkers: [worker],
      options: { allowWorkerOrchestration: true },
    })
    const allowed = await allowedHarness.executeRaw("list", {}, { sessionID: "ses_worker" })
    expect(allowed.output).toMatchObject({ state: "ok" })
  })

  it("O-3: waitAll returns partial results, including permission", async () => {
    const harness = makeHarness({
      sessions: [fakeSession("ses_a"), fakeSession("ses_b"), fakeSession("ses_c")],
      messages: {
        ses_a: idleMessages("a"),
        ses_b: idleMessages("b"),
        ses_c: idleMessages("c"),
      },
      permissions: { ses_b: [permissionAt(2)] },
    })
    const started = Date.now()
    const result = await harness.executeRaw("waitAny", {
      sessionIDs: ["ses_a", "ses_b", "ses_c"],
      mode: "all",
      timeoutMs: 5_000,
    })
    const output = result.output as Record<string, unknown>
    expect(output.state).toBe("permission")
    expect((output.sessions as unknown[]).length).toBe(3)
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it("O-3: waitAll keeps the sessions that finished when another times out", async () => {
    const harness = makeHarness({
      sessions: [fakeSession("ses_a"), fakeSession("ses_slow")],
      messages: {
        ses_a: idleMessages("a"),
        ses_slow: [{ id: "slow_user", type: "user", text: "slow", time: { created: 1 } }],
      },
      autoComplete: false,
      options: {
        pollIntervalMs: 20,
        maxPollIntervalMs: 100,
        permissionPollMs: 1_000,
      },
    })
    const result = await harness.executeRaw("waitAll", {
      sessionIDs: ["ses_a", "ses_slow"],
      timeoutMs: 150,
    })
    const output = result.output as Record<string, unknown>
    expect(output.state).toBe("timeout")
    const sessions = output.sessions as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(2)
    expect(sessions.some((entry) => entry.state === "idle")).toBe(true)
    expect(sessions.some((entry) => entry.state === "timeout")).toBe(true)
  })

  it("O-3: detects background work after the model idle", async () => {
    const harness = makeHarness({
      sessions: [fakeSession("ses_a")],
      messages: { ses_a: idleMessages("a") },
      enableLive: true,
      options: { pollIntervalMs: 20, maxPollIntervalMs: 100 },
    })
    await harness.ready
    await harness.callHook("experimental.idle", {
      sessionID: "ses_a",
      background: [
        {
          kind: "shell",
          sessionID: "ses_a",
          shellID: "sh_1",
          command: "npm test",
        },
      ],
    })
    const result = await harness.executeRaw("waitAny", {
      sessionIDs: ["ses_a"],
      mode: "all",
      timeoutMs: 1_000,
    })
    const output = result.output as Record<string, unknown>
    expect(output.state).toBe("running")
    const sessions = output.sessions as Array<Record<string, unknown>>
    expect(sessions[0]?.state).toBe("running")
    expect((sessions[0]?.background as unknown[]).length).toBe(1)
  })

  it("O-2/O-4/O-5: worktree race, snapshot, ranking, and cleanup", async () => {
    const repo = await makeTempRepo()
    try {
      const harness = makeHarness({
        repoDirectory: repo.directory,
        realWorktrees: true,
        options: {
          allowSnapshotCommits: true,
          allowTestCommands: true,
          allowWorktreeManagement: true,
          allowApplyCandidates: true,
          maxRaceCandidates: 4,
          maxConcurrentSessions: 3,
          gitTimeoutMs: 30_000,
        },
        onPrompt: async ({ directory, index }) => {
          await writeFile(
            path.join(directory, `feature-${index}.txt`),
            `feature ${index}\n`,
            "utf8",
          )
          if (index === 1) {
            await writeFile(path.join(directory, "fail.marker"), "1\n", "utf8")
          }
        },
      })

      const result = await harness.executeRaw("bestOf", {
        prompt: "implement it",
        count: 3,
        mode: "worktrees",
        base: repo.base,
        testCommand:
          'node -e "process.exit(require(\'fs\').existsSync(\'fail.marker\')?1:0)"',
        keepWorktrees: true,
        timeoutMs: 30_000,
      })
      const output = result.output as Record<string, unknown>
      const candidates = output.candidates as Array<Record<string, unknown>>
      expect(candidates).toHaveLength(3)
      for (const candidate of candidates) {
        expect(candidate.commit).toEqual(expect.any(String))
        expect(candidate.messageID).toMatch(/^msg_/)
        expect((candidate.diffStats as Record<string, number>).additions).toBeGreaterThan(0)
      }
      const failed = candidates.filter(
        (candidate) => (candidate.tests as Record<string, unknown>).passed === false,
      )
      expect(failed).toHaveLength(1)
      expect(failed[0]?.verification).toBe("flagged")
      expect(output.recommended).toEqual(expect.any(String))
      expect(output.recommended).not.toBe(failed[0]?.candidateID)
      expect(harness.state.worktreeCreateCalls).toHaveLength(3)

      const cleanup = await harness.executeRaw("raceCleanup", {
        raceID: String(output.raceID),
        confirm: true,
        force: true,
      })
      expect((cleanup.output as Record<string, unknown>).removed).toHaveLength(3)
      expect(harness.state.worktreeRemoveCalls.length).toBeGreaterThanOrEqual(3)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-4: does not snapshot candidates whose admission failed", async () => {
    const repo = await makeTempRepo()
    try {
      const harness = makeHarness({
        repoDirectory: repo.directory,
        realWorktrees: true,
        promptError: new Error("admission failed"),
        options: {
          allowSnapshotCommits: true,
          allowWorktreeManagement: true,
          maxRaceCandidates: 3,
          maxConcurrentSessions: 2,
          gitTimeoutMs: 30_000,
        },
      })
      const result = await harness.executeRaw("bestOf", {
        prompt: "implement it",
        count: 2,
        mode: "worktrees",
        base: repo.base,
        keepWorktrees: true,
        timeoutMs: 30_000,
      })
      const output = result.output as Record<string, unknown>
      await harness.executeRaw("raceCleanup", {
        raceID: String(output.raceID),
        confirm: true,
        force: true,
      })
      const candidates = output.candidates as Array<Record<string, unknown>>
      expect(candidates).toHaveLength(2)
      for (const candidate of candidates) {
        expect(candidate.state).toBe("error")
        expect(candidate.commit).toBeUndefined()
        expect((candidate.diffStats as Record<string, number>).files).toBe(0)
      }
      expect(output.recommended ?? null).toBeNull()
    } finally {
      await repo.cleanup()
    }
  })

  it("O-5: applyCandidate dry-run, verification, idempotency, and push rejection", async () => {
    const repo = await makeTempRepo()
    try {
      await writeFile(path.join(repo.directory, "feature.txt"), "feature\n", "utf8")
      await runGit(["add", "."], repo.directory)
      await runGit(["commit", "-m", "feature"], repo.directory)
      const commit = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      const patch = (await runGit(["diff", "--binary", repo.base, commit], repo.directory)).stdout
      await runGit(["reset", "--hard", repo.base], repo.directory)

      const race = {
        raceID: "race_apply",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        targetDirectory: repo.directory,
        mode: "worktrees",
        prompt: "implement it",
        base: repo.base,
        keepWorktrees: false,
        status: "completed",
        worktrees: [],
        candidates: [
          {
            candidateID: "candidate-1",
            index: 0,
            messageID: "msg_1",
            directory: repo.directory,
            strategy: "worktree",
            base: repo.base,
            branch: "main",
            commit,
            patch,
            patchBytes: patch.length,
            diffComplete: true,
            snapshotSource: "git-commit",
            files: [
              {
                file: "feature.txt",
                status: "added",
                additions: 1,
                deletions: 0,
                patch,
              },
            ],
            diffStats: { files: 1, additions: 1, deletions: 0 },
            testFilesChanged: false,
            ciFilesChanged: false,
            skippedTests: false,
            verification: "trusted",
            tests: { skipped: false, passed: true },
            state: "idle",
            elapsedMs: 10,
            applyStrategy: "cherry-pick",
          },
        ],
      }

      const harness = makeHarness({
        repoDirectory: repo.directory,
        worktreeMissing: true,
        initialRaces: [race],
        options: {
          allowApplyCandidates: true,
          allowWorktreeManagement: true,
          allowPushCandidates: true,
          gitTimeoutMs: 30_000,
        },
      })

      const before = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      const dry = await harness.executeRaw("applyCandidate", {
        raceID: race.raceID,
        candidateID: "candidate-1",
        strategy: "cherry-pick",
        verifyCommand: 'node -e "process.exit(0)"',
        dryRun: true,
        confirm: true,
      })
      expect(dry.output).toMatchObject({ applied: false, dryRun: true, state: "ok" })
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).toBe(before)

      const applied = await harness.executeRaw("applyCandidate", {
        raceID: race.raceID,
        candidateID: "candidate-1",
        strategy: "cherry-pick",
        verifyCommand: 'node -e "process.exit(0)"',
        dryRun: false,
        commit: true,
        commitMessage: "apply candidate",
        confirm: true,
        push: true,
      })
      expect(applied.output).toMatchObject({
        applied: true,
        dryRun: false,
        pushed: false,
      })
      expect(String((applied.output as Record<string, unknown>).pushError).length).toBeGreaterThan(0)
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).not.toBe(before)

      const second = await harness.executeRaw("applyCandidate", {
        raceID: race.raceID,
        candidateID: "candidate-1",
        strategy: "cherry-pick",
        dryRun: false,
        confirm: true,
      })
      expect(second.output).toMatchObject({ alreadyApplied: true, applied: false })
    } finally {
      await repo.cleanup()
    }
  })

  it("O-5: dirty target and failed verification leave the target intact", async () => {
    const repo = await makeTempRepo()
    try {
      await writeFile(path.join(repo.directory, "feature.txt"), "feature\n", "utf8")
      await runGit(["add", "."], repo.directory)
      await runGit(["commit", "-m", "feature"], repo.directory)
      const commit = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      await runGit(["reset", "--hard", repo.base], repo.directory)
      const baseRace = {
        raceID: "race_verify",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        targetDirectory: repo.directory,
        mode: "worktrees",
        prompt: "implement it",
        base: repo.base,
        keepWorktrees: false,
        status: "completed",
        worktrees: [],
        candidates: [
          {
            candidateID: "candidate-1",
            index: 0,
            messageID: "msg_1",
            directory: repo.directory,
            strategy: "worktree",
            base: repo.base,
            commit,
            patchBytes: 0,
            diffComplete: false,
            snapshotSource: "git-commit",
            files: [],
            diffStats: { files: 0, additions: 0, deletions: 0 },
            testFilesChanged: false,
            ciFilesChanged: false,
            skippedTests: false,
            verification: "flagged",
            state: "idle",
            elapsedMs: 10,
            applyStrategy: "cherry-pick",
          },
        ],
      }
      const harness = makeHarness({
        repoDirectory: repo.directory,
        worktreeMissing: true,
        initialRaces: [baseRace],
        options: {
          allowApplyCandidates: true,
          allowWorktreeManagement: true,
          gitTimeoutMs: 30_000,
        },
      })
      const before = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()

      await writeFile(path.join(repo.directory, "dirty.txt"), "dirty\n", "utf8")
      const dirty = await harness.executeRaw("applyCandidate", {
        raceID: baseRace.raceID,
        candidateID: "candidate-1",
        strategy: "cherry-pick",
        dryRun: false,
        confirm: true,
      })
      expect(dirty.output).toMatchObject({ state: "error" })
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).toBe(before)
      await rm(path.join(repo.directory, "dirty.txt"), { force: true })

      const failed = await harness.executeRaw("applyCandidate", {
        raceID: baseRace.raceID,
        candidateID: "candidate-1",
        strategy: "cherry-pick",
        verifyCommand: 'node -e "process.exit(1)"',
        dryRun: false,
        confirm: true,
      })
      expect(failed.output).toMatchObject({ state: "error", applied: false })
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).toBe(before)
    } finally {
      await repo.cleanup()
    }
  })

  it("O-5: applies a candidate without a commit from a clone strategy using a patch", async () => {
    const repo = await makeTempRepo()
    try {
      await writeFile(path.join(repo.directory, "feature.txt"), "feature\n", "utf8")
      await runGit(["add", "."], repo.directory)
      await runGit(["commit", "-m", "feature"], repo.directory)
      const commit = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      const patch = (await runGit(["diff", "--binary", repo.base, commit], repo.directory)).stdout
      await runGit(["reset", "--hard", repo.base], repo.directory)

      const race = {
        raceID: "race_patch",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        targetDirectory: repo.directory,
        mode: "worktrees",
        prompt: "implement it",
        base: repo.base,
        keepWorktrees: false,
        status: "completed",
        worktrees: [],
        candidates: [
          {
            candidateID: "candidate-1",
            index: 0,
            messageID: "msg_1",
            directory: repo.directory,
            strategy: "clone",
            base: repo.base,
            patch,
            patchBytes: patch.length,
            diffComplete: true,
            snapshotSource: "git-patch",
            files: [
              {
                file: "feature.txt",
                status: "added",
                additions: 1,
                deletions: 0,
                patch,
              },
            ],
            diffStats: { files: 1, additions: 1, deletions: 0 },
            testFilesChanged: false,
            ciFilesChanged: false,
            skippedTests: false,
            verification: "unknown",
            tests: { skipped: true, reason: "no test command" },
            state: "idle",
            elapsedMs: 10,
            applyStrategy: "patch",
          },
        ],
      }
      const harness = makeHarness({
        repoDirectory: repo.directory,
        worktreeMissing: true,
        initialRaces: [race],
        options: {
          allowApplyCandidates: true,
          allowWorktreeManagement: true,
          gitTimeoutMs: 30_000,
        },
      })
      const before = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      const result = await harness.executeRaw("applyCandidate", {
        raceID: race.raceID,
        candidateID: "candidate-1",
        strategy: "apply",
        verifyCommand: 'node -e "process.exit(0)"',
        dryRun: false,
        commit: false,
        confirm: true,
      })
      expect(result.output).toMatchObject({ applied: true, state: "ok" })
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).toBe(before)
      const status = await runGit(["status", "--porcelain=v1"], repo.directory)
      expect(status.stdout).toContain("feature.txt")
    } finally {
      await repo.cleanup()
    }
  })

  it("O-5: a divergent target is not modified by a conflicting patch", async () => {
    const repo = await makeTempRepo()
    try {
      await writeFile(path.join(repo.directory, "base.txt"), "candidate\n", "utf8")
      await runGit(["add", "."], repo.directory)
      await runGit(["commit", "-m", "candidate"], repo.directory)
      const candidateCommit = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()
      const patch = (
        await runGit(["diff", "--binary", repo.base, candidateCommit], repo.directory)
      ).stdout
      await runGit(["reset", "--hard", repo.base], repo.directory)

      // The target moves forward independently; the patch no longer applies.
      await writeFile(path.join(repo.directory, "base.txt"), "target\n", "utf8")
      await runGit(["add", "."], repo.directory)
      await runGit(["commit", "-m", "target change"], repo.directory)
      const targetHead = (await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()

      const race = {
        raceID: "race_conflict",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        targetDirectory: repo.directory,
        mode: "worktrees",
        prompt: "implement it",
        base: repo.base,
        keepWorktrees: false,
        status: "completed",
        worktrees: [],
        candidates: [
          {
            candidateID: "candidate-1",
            index: 0,
            messageID: "msg_1",
            directory: repo.directory,
            strategy: "clone",
            base: repo.base,
            patch,
            patchBytes: patch.length,
            diffComplete: true,
            snapshotSource: "git-patch",
            files: [
              {
                file: "base.txt",
                status: "modified",
                additions: 1,
                deletions: 1,
                patch,
              },
            ],
            diffStats: { files: 1, additions: 1, deletions: 1 },
            testFilesChanged: false,
            ciFilesChanged: false,
            skippedTests: false,
            verification: "unknown",
            tests: { skipped: true, reason: "no test command" },
            state: "idle",
            elapsedMs: 10,
            applyStrategy: "patch",
          },
        ],
      }
      const harness = makeHarness({
        repoDirectory: repo.directory,
        worktreeMissing: true,
        initialRaces: [race],
        options: {
          allowApplyCandidates: true,
          allowWorktreeManagement: true,
          gitTimeoutMs: 30_000,
        },
      })
      const result = await harness.executeRaw("applyCandidate", {
        raceID: race.raceID,
        candidateID: "candidate-1",
        strategy: "apply",
        verifyCommand: 'node -e "process.exit(0)"',
        dryRun: false,
        confirm: true,
      })
      expect(result.output).toMatchObject({ state: "error", applied: false })
      expect((await runGit(["rev-parse", "HEAD"], repo.directory)).stdout.trim()).toBe(targetHead)
      expect(
        (await runGit(["status", "--porcelain=v1"], repo.directory)).stdout.trim(),
      ).toBe("")
    } finally {
      await repo.cleanup()
    }
  })

  it("O-2: worktrees create, list, and remove only tracked worktrees", async () => {
    const repo = await makeTempRepo()
    try {
      const harness = makeHarness({
        repoDirectory: repo.directory,
        realWorktrees: true,
        options: {
          allowWorktreeManagement: true,
          maxWorktrees: 4,
          gitTimeoutMs: 30_000,
        },
      })
      const created = await harness.executeRaw("worktrees", {
        action: "create",
        count: 2,
        base: repo.base,
        runID: "run_wt",
      })
      const worktrees = (created.output as Record<string, unknown>).worktrees as Array<{
        directory: string
      }>
      expect(worktrees).toHaveLength(2)

      const listed = await harness.executeRaw("worktrees", { action: "list" })
      expect(
        (listed.output as Record<string, unknown>).worktrees as unknown[],
      ).toHaveLength(2)

      await writeFile(path.join(worktrees[0]!.directory, "dirty.txt"), "dirty\n", "utf8")
      const kept = await harness.executeRaw("worktrees", {
        action: "remove",
        directories: [worktrees[0]!.directory],
        confirm: true,
        force: false,
      })
      const keptResults = (kept.output as Record<string, unknown>).removed as Array<{
        removed: boolean
      }>
      expect(keptResults[0]?.removed).toBe(false)

      const forced = await harness.executeRaw("worktrees", {
        action: "remove",
        directories: [worktrees[0]!.directory, worktrees[1]!.directory],
        confirm: true,
        force: true,
      })
      const forcedResults = (forced.output as Record<string, unknown>).removed as Array<{
        removed: boolean
      }>
      expect(forcedResults.filter((entry) => entry.removed)).toHaveLength(2)
    } finally {
      await repo.cleanup()
    }
  })
})
