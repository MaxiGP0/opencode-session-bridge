import { describe, expect, it } from "vitest"
import plugin from "../index.ts"
import type {
  Lang,
  MessageLike,
  PermissionLike,
  PluginContext,
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

type FakeTool = {
  name: string
  execute: (input: unknown, context: FakeToolContext) => Promise<{ content?: string }>
}

type FakeToolContext = {
  sessionID?: string
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
  cursorNext?: string | null
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
  const removeCalls: string[] = []
  const replyCalls: Array<Record<string, unknown>> = []
  const switchModelCalls: Array<Record<string, unknown>> = []
  const switchAgentCalls: Array<Record<string, unknown>> = []
  const listCalls: Array<Record<string, unknown>> = []
  let createCalls = 0
  let contextCalls = 0
  let waitCalls = 0
  let promptCounter = 0
  let now = 1_000

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

  const ctx = {
    options: options.options ?? {},
    location: { directory: "C:/repo" },
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
      default: async () => ({ providerID: "p", id: "m" }),
    },
    session: {
      get: async (input: { sessionID: string }) => {
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error(`session not found: ${input.sessionID}`)
        return session
      },
      create: async (input: { title?: string; agent?: string; model?: unknown }) => {
        createCalls++
        const id = sessions.has("ses_new") ? `ses_new_${createCalls}` : "ses_new"
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
        if (options.promptError) throw options.promptError
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
      interrupt: async () => ({ interrupted: true }),
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
    promptCalls,
    admissions,
    updateCalls,
    removeCalls,
    replyCalls,
    switchModelCalls,
    switchAgentCalls,
    listCalls,
    get createCalls() {
      return createCalls
    },
    get contextCalls() {
      return contextCalls
    },
    get waitCalls() {
      return waitCalls
    },
  }

  const ready = plugin.setup(ctx as unknown as PluginContext)

  return {
    tools,
    state,
    ready,
    async execute(name: string, input: unknown, context: Partial<FakeToolContext> = {}) {
      await ready
      const tool = tools.get(name)
      if (!tool) throw new Error(`missing tool: ${name}`)
      const result = await tool.execute(input, {
        sessionID: "ses_caller",
        signal: new AbortController().signal,
        progress: async () => undefined,
        ...context,
      })
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

  it("anchors open and send on the admitted prompt ID", async () => {
    const harness = makeHarness()
    const content = await harness.execute("open", { prompt: "hi", messageID: "msg_fixed" })
    expect(harness.state.promptCalls[0]?.id).toBe("msg_fixed")
    expect(content).toContain("Message ID: msg_fixed")
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
    const harness = makeHarness()
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
})
