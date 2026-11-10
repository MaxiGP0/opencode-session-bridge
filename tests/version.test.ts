import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { PLUGIN_VERSION } from "../src/version.ts"

describe("plugin version", () => {
  it("matches package.json", async () => {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8")
    const pkg = JSON.parse(raw) as { version?: string }
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })
})
