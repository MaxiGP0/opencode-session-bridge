import { describe, expect, it } from "vitest"
import { formatSummary, summarizeTurn } from "../src/format.ts"
import { localize, STRINGS, t } from "../src/i18n.ts"

describe("structured i18n", () => {
  it("translates only plugin labels, never assistant content", () => {
    expect(localize("Asistente: Estado: en ejecución", "en")).toBe(
      "Assistant: Estado: en ejecución",
    )
    expect(localize("El usuario dijo: Estado: en ejecución", "en")).toBe(
      "El usuario dijo: Estado: en ejecución",
    )
  })

  it("keeps user and assistant text intact in a full report", () => {
    const summary = summarizeTurn(
      [
        { id: "u1", type: "user", text: "El usuario dijo: Estado: en ejecución", time: { created: 1 } },
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "Estado: en ejecución" }],
          time: { created: 2 },
        },
        { id: "i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
      ],
      0,
    )
    const report = formatSummary("Session: ses_1", summary, { lang: "en" })
    expect(report).toContain("Message sent: El usuario dijo: Estado: en ejecución")
    expect(report).toContain("Final text:\nEstado: en ejecución")
    expect(report).toContain("State: idle (succeeded)")
    expect(report).not.toContain("State: running")
  })

  it("fixes the feminine unknown label", () => {
    expect(localize("Última actualización: (desconocida)", "en")).toBe(
      "Last update: (unknown)",
    )
    expect(t("en", "unknownF")).toBe("(unknown)")
  })

  it("keeps Spanish and English key sets in parity", () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.es).sort())
  })

  it("interpolates variables without translating their content", () => {
    expect(t("en", "actionsOmitted", { count: 3 })).toBe("… 3 actions omitted")
    expect(t("en", "afterNotFound", { id: "msg_x", limit: 30 })).toContain("msg_x")
    expect(t("en", "afterNotFound", { id: "msg_x", limit: 30 })).toContain("30")
  })
})
