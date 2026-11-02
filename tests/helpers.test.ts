import { describe, expect, it } from "vitest"
import {
  assistantText,
  compact,
  formatError,
  formatSummary,
  isRunning,
  lastAssistant,
  lastIdle,
  lastUser,
  localize,
  modelRef,
  parseModel,
  permissionLine,
  summarizeTurn,
  titleFromPrompt,
  toolLine,
  toolsOf,
} from "../index.ts"

const oldUser = { id: "msg_old_user", type: "user", text: "old", time: { created: 1 } }
const oldAssistant = {
  id: "msg_old_assistant",
  type: "assistant",
  time: { created: 2, completed: 3 },
  content: [{ type: "text", text: "old answer" }],
}
const oldIdle = { id: "msg_old_idle", type: "idle", outcome: "succeeded", time: { created: 4 } }
const newUser = { id: "msg_new_user", type: "user", text: "hola", time: { created: 5 } }
const toolPart = {
  type: "tool",
  id: "tool_1",
  name: "read",
  state: {
    status: "completed",
    input: { path: "a.txt" },
    content: [{ type: "text", text: "file body" }],
  },
  time: { created: 6 },
}
const newAssistant = {
  id: "msg_new_assistant",
  type: "assistant",
  time: { created: 6, completed: 7 },
  content: [{ type: "text", text: "respuesta" }, toolPart],
}
const newIdle = { id: "msg_new_idle", type: "idle", outcome: "succeeded", time: { created: 8 } }
const messages = [oldUser, oldAssistant, oldIdle, newUser, newAssistant, newIdle]

describe("model helpers", () => {
  it("parses provider/model references", () => {
    expect(parseModel("anthropic/claude-sonnet-5-5")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
    })
    expect(parseModel("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    })
  })

  it("rejects invalid model references", () => {
    expect(parseModel(undefined)).toBeUndefined()
    expect(parseModel("")).toBeUndefined()
    expect(parseModel("no-slash")).toBeUndefined()
    expect(parseModel("/model")).toBeUndefined()
    expect(parseModel("provider/")).toBeUndefined()
  })

  it("normalizes model refs from session info", () => {
    expect(modelRef({ providerID: "p", id: "m" })).toEqual({ providerID: "p", id: "m" })
    expect(modelRef({ providerID: "p", modelID: "m" })).toEqual({ providerID: "p", id: "m" })
    expect(modelRef(undefined)).toBeUndefined()
    expect(modelRef({ providerID: "p" })).toBeUndefined()
  })
})

describe("text helpers", () => {
  it("derives a title from the first prompt line", () => {
    expect(titleFromPrompt("hello\nworld")).toBe("hello")
    expect(titleFromPrompt("hello", "  Custom title  ")).toBe("Custom title")
    expect(titleFromPrompt("")).toBe("Nueva sesión")
    const long = titleFromPrompt("a".repeat(100))
    expect(long).toHaveLength(60)
    expect(long.endsWith("...")).toBe(true)
  })

  it("compacts values for display", () => {
    expect(compact("  a \n b  ")).toBe("a b")
    expect(compact({ a: 1 })).toBe('{"a":1}')
    expect(compact("{}")).toBe("")
    expect(compact(undefined)).toBe("")
    const clipped = compact("x".repeat(300), 10)
    expect(clipped).toHaveLength(10)
    expect(clipped.endsWith("…")).toBe(true)
  })

  it("extracts assistant text", () => {
    expect(assistantText(newAssistant)).toBe("respuesta")
    expect(assistantText({ type: "assistant", content: [] })).toBeUndefined()
    expect(assistantText({ type: "user", content: [{ type: "text", text: "x" }] })).toBeUndefined()
  })

  it("formats errors", () => {
    expect(formatError(new Error("boom"))).toBe("boom")
    expect(formatError("plain")).toBe("plain")
  })
})

describe("message helpers", () => {
  it("finds the last message of each type", () => {
    expect(lastAssistant(messages)?.id).toBe("msg_new_assistant")
    expect(lastIdle(messages)?.id).toBe("msg_new_idle")
    expect(lastUser(messages)?.id).toBe("msg_new_user")
    expect(lastAssistant([])).toBeUndefined()
  })

  it("detects a running session", () => {
    expect(isRunning({ time: { busy: 10, idle: 5 } }, [newIdle])).toBe(true)
    expect(isRunning({ time: { busy: 5, idle: 10 } }, [newIdle])).toBe(false)
    expect(isRunning({ time: {} }, [newUser])).toBe(true)
    expect(isRunning({ time: {} }, [newUser, newIdle])).toBe(false)
    expect(isRunning({ time: {} }, [])).toBe(false)
  })

  it("extracts tool parts", () => {
    expect(toolsOf(newAssistant)).toEqual([toolPart])
    expect(toolsOf(newUser)).toEqual([])
  })

  it("formats tool lines with optional output", () => {
    const line = toolLine(toolPart, false)
    expect(line).toContain("read [completed]")
    expect(line).toContain("a.txt")
    expect(line).not.toContain("file body")
    expect(toolLine(toolPart, true)).toContain("file body")
    expect(
      toolLine(
        { name: "shell", state: { status: "error", input: { command: "x" }, error: { message: "denied" } } },
        false,
      ),
    ).toContain("error: denied")
  })

  it("summarizes a turn from a start index", () => {
    const summary = summarizeTurn(messages, 3)
    expect(summary.user?.text).toBe("hola")
    expect(summary.text).toBe("respuesta")
    expect(summary.tools).toHaveLength(1)
    expect(summary.outcome).toBe("succeeded")
    expect(summary.error).toBeUndefined()
    expect(summary.lastMessageID).toBe("msg_new_idle")
  })

  it("captures assistant errors", () => {
    const summary = summarizeTurn(
      [
        {
          id: "msg_error",
          type: "assistant",
          time: { created: 1 },
          content: [],
          finish: "error",
          error: { message: "boom" },
        },
        { id: "msg_idle", type: "idle", outcome: "failed", time: { created: 2 } },
      ],
      0,
    )
    expect(summary.text).toBeUndefined()
    expect(summary.error).toBe("boom")
    expect(summary.outcome).toBe("failed")
  })
})

describe("formatSummary", () => {
  it("renders a Spanish report and translates it to English", () => {
    const summary = summarizeTurn(messages, 3)
    const report = formatSummary("Sesión: ses_1\nTítulo: Prueba", summary)
    expect(report).toContain("Mensaje enviado: hola")
    expect(report).toContain("Estado: inactiva (succeeded)")
    expect(report).toContain("Texto final:\nrespuesta")
    expect(report).toContain("Acciones (1):")
    expect(report).toContain("Último mensaje: msg_new_idle")

    const english = localize(report, "en")
    expect(english).toContain("Session: ses_1")
    expect(english).toContain("Title: Prueba")
    expect(english).toContain("Message sent: hola")
    expect(english).toContain("State: idle (succeeded)")
    expect(english).toContain("Final text:\nrespuesta")
    expect(english).toContain("Actions (1):")
    expect(english).toContain("Last message: msg_new_idle")
    expect(english).not.toMatch(/Estado:|Texto final|Acciones|Último mensaje|Sesión:/)
  })

  it("reports a turn without text", () => {
    const summary = summarizeTurn([newUser, newIdle], 0)
    expect(formatSummary("Sesión: ses_1", summary)).toContain("Texto final: (sin texto)")
    expect(localize(formatSummary("Sesión: ses_1", summary), "en")).toContain("Final text: (no text)")
  })
})

describe("permission helpers", () => {
  it("formats permission requests", () => {
    const line = permissionLine({
      id: "per_1",
      action: "shell",
      resources: ["echo *"],
      save: ["echo *"],
      metadata: { cwd: "tmp" },
      message: "allow?",
    })
    expect(line).toContain("per_1")
    expect(line).toContain("shell")
    expect(line).toContain("echo *")
    expect(line).toContain("recordar:")
    expect(line).toContain("metadata")
    expect(line).toContain("allow?")
    expect(localize(line, "en")).toContain("remember:")
  })

  it("handles missing resources", () => {
    const line = permissionLine({ id: "per_2", action: "edit", resources: [] })
    expect(line).toContain("(sin recursos)")
    expect(localize(line, "en")).toContain("(no resources)")
  })
})

describe("localize", () => {
  it("leaves Spanish untouched", () => {
    const text = "Estado: inactiva (succeeded)\nTexto final: hola"
    expect(localize(text, "es")).toBe(text)
  })

  it("translates labels, states, and errors", () => {
    const cases: Array<[string, string]> = [
      ["Sesión creada: ses_1", "Session created: ses_1"],
      ["Sesión: ses_1", "Session: ses_1"],
      ["Título: Prueba", "Title: Prueba"],
      ["Mensaje enviado: hola", "Message sent: hola"],
      ["Estado: en ejecución", "State: running"],
      ["Estado: inactiva (succeeded)", "State: idle (succeeded)"],
      ["Estado: inactiva (sin turnos)", "State: idle (no turns)"],
      ["sigue en ejecución (tiempo agotado)", "still running (timed out)"],
      ["espera cancelada", "wait cancelled"],
      ["Resultado: (desconocido)", "Result: (unknown)"],
      ["Última actualización: ahora", "Last update: ahora"],
      ["Último texto: (sin texto)", "Last text: (no text)"],
      ["Texto final: (sin texto)", "Final text: (no text)"],
      ["Acciones: (ninguna)", "Actions: (none)"],
      ["Acciones (2):", "Actions (2):"],
      ["Acciones recientes: (ninguna)", "Recent actions: (none)"],
      ["Acciones recientes (3):", "Recent actions (3):"],
      ["Permisos pendientes (2):", "Pending permissions (2):"],
      ["Último mensaje: msg_1", "Last message: msg_1"],
      ["Usuario: hola", "User: hola"],
      ["Asistente: hola", "Assistant: hola"],
      ["Asistente [error]: boom", "Assistant [error]: boom"],
      ["— Fin de turno: failed", "— End of turn: failed"],
      ["(sin mensajes)", "(no messages)"],
      ["(sin título)", "(untitled)"],
      ["(desconocido)", "(unknown)"],
      ["(sin recursos)", "(no resources)"],
      ["recordar: echo *", "remember: echo *"],
      [" | padre: ses_1", " | parent: ses_1"],
      ["Solicitud per_1: aprobada una vez.", "Request per_1: approved once."],
      ["Solicitud per_1: aprobada y recordada.", "Request per_1: approved and saved."],
      ["Solicitud per_1: rechazada.", "Request per_1: rejected."],
      ["Sesión ses_1: no hay solicitudes de permiso pendientes.", "Session ses_1: no pending permission requests."],
      ["Sesión ses_1: interrumpida.", "Session ses_1: interrupted."],
      ["Sesión ses_1: no había un turno activo.", "Session ses_1: there was no active turn."],
      ["No hay turnos pendientes.", "No pending turns."],
      ["No hay sesiones.", "No sessions."],
      ["Sesiones:\n- ses_1", "Sessions:\n- ses_1"],
      ["No se pudo abrir la sesión: boom", "Could not open the session: boom"],
      ["No se pudo enviar el mensaje: boom", "Could not send the message: boom"],
      ["No se pudo consultar la sesión: boom", "Could not inspect the session: boom"],
      ["No se pudieron consultar los permisos: boom", "Could not query permissions: boom"],
      ["No se pudo responder al permiso: boom", "Could not reply to permission: boom"],
      ["No se pudo leer la sesión: boom", "Could not read the session: boom"],
      ["No se pudo esperar la sesión: boom", "Could not wait for the session: boom"],
      ["No se pudo interrumpir la sesión: boom", "Could not interrupt the session: boom"],
      ["No se pudieron listar las sesiones: boom", "Could not list sessions: boom"],
      [
        "Mensaje enviado. La sesión sigue en segundo plano.",
        "Message sent. The session continues in the background.",
      ],
      [
        "Usa sessions.reply con el ID de la solicitud para responder.",
        "Use sessions.reply with the request ID to respond.",
      ],
      [
        "Usa sessions.reply con el ID de la solicitud para aprobar o rechazar.",
        "Use sessions.reply with the request ID to approve or reject.",
      ],
      [
        "Usa sessions.reply con sessionID y requestID para responder.",
        "Use sessions.reply with sessionID and requestID to respond.",
      ],
      ["… (transcripción recortada)", "… (transcript truncated)"],
      ["Nueva sesión", "New session"],
    ]

    for (const [spanish, english] of cases) {
      expect(localize(spanish, "en")).toBe(english)
    }
  })
})
