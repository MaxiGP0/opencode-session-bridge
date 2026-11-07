import { describe, expect, it } from "vitest"
import plugin from "../index.ts"
import type {
  Lang,
  MessageLike,
  PermissionLike,
  PluginContext,
  SessionEventLike,
  ToolExecuteContext,
} from "../src/types.ts"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  assertError?: Error
  cursorNext?: string | null
  modelDefault?: unknown
  createGate?: Promise<void>
  promptGate?: Promise<void>
  createConflictOnce?: boolean
  enableLive?: boolean
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
  const sessions = new Map<string, FakeSession>()
  const messages = new Map<string, MessageLike[]>()
  const permissions = new Map<string, PermissionLike[]>()
  const storage = new Map<string, unknown>()
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
  for (const session of initialSessions) sessions.set(session.id, session)
  for (const [sessionID, list] of Object.entries(options.messages ?? {})) {
    messages.set(sessionID, list)
  }
  for (const [sessionID, list] of Object.entries(options.permissions ?? {})) {
    permissions.set(sessionID, list)
  }

  const interruptCalls: Array<Record<string, unknown>> = []
  const ctx = {
    options: options.options ?? {},
    location: { directory: "C:/repo" },
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
      create: async (input: { id?: string; title?: string; agent?: string; model?: unknown }) => {
        createCalls++
        createInputs.push(input as Record<string, unknown>)
        if (options.createGate) await options.createGate
        if (options.createConflictOnce && input.id && !sessions.has(input.id)) {
          const created = fakeSession(input.id, {
            title: input.title,
            agent: input.agent,
            model: input.model as FakeSession["model"],
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
      context: async (input: { sessionID: string }) => {
        contextCalls++
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
      list: async (input: { sessionID: string }) => permissions.get(input.sessionID) ?? [],
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

type NumericSchema = { minimum?: number; maximum?: number }

function numericSchema(tool: FakeTool | undefined, field: string): NumericSchema {
  const input = tool?.input as
    | { properties?: Record<string, NumericSchema> }
    | undefined
  return input?.properties?.[field] ?? {}
}

function schemaAccepts(schema: NumericSchema, value: number): boolean {
  if (schema.minimum !== undefined && value < schema.minimum) return false
  if (schema.maximum !== undefined && value > schema.maximum) return false
  return true
}

function permissionAt(index: number): PermissionLike {
  return {
    id: `per_${index}`,
    sessionID: "ses_1",
    action: "shell",
    resources: [`echo ${index}`],
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
    expect(harness.state.promptCalls).toHaveLength(2)
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

    const allowed = makeHarness({ options: { allowSessionRemoval: true } })
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
    expect(harness.state.sessionGetCalls).toBe(0)
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
      ["status", "maxOutputChars"],
      ["status", "maxText"],
      ["open", "maxOutputChars"],
      ["permissions", "limit"],
    ]
    for (const [toolName, field] of zeroCases) {
      const schema = numericSchema(harness.tools.get(toolName), field)
      expect(schema.minimum, `${toolName}.${field}`).toBe(0)
      expect(schemaAccepts(schema, 0), `${toolName}.${field}`).toBe(true)
      expect(schemaAccepts(schema, -1), `${toolName}.${field}`).toBe(false)
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
      options: { allowInterruptForeignSessions: true, allowSessionRemoval: true },
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

    harness.emit({
      type: "session.status",
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 5_000 },
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
      retry: { attempt: 2, message: "rate limited", next: 5_000 },
    })
    expect(status.content).toContain("retrying")
    expect(status.content).toContain("rate limited")

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
})
