import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { DiagnosticEnvelope } from "../../src/diagnostics/event"
import { instrumentRenderer, instrumentStdout } from "../../src/diagnostics/renderer"
import { create } from "../../src/diagnostics/service"

function memoryDiagnostics() {
  const rows: DiagnosticEnvelope[] = []
  return {
    rows,
    diagnostics: create({ sinks: [{ name: "memory", emit: (event) => rows.push(event) }] }),
  }
}

test("records stdout boundaries without recording contents and restores safely", () => {
  const { diagnostics, rows } = memoryDiagnostics()
  const chunks: string[] = []
  const stdout = {
    write: ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write,
  }
  const restore = instrumentStdout(diagnostics, stdout)

  stdout.write("secret output")
  const replacement = (() => true) as typeof process.stdout.write
  stdout.write = replacement
  restore()

  expect(stdout.write).toBe(replacement)
  expect(chunks).toEqual(["secret output"])
  expect(rows.find((row) => row.type === "boundary.started" && row.boundary.name === "stdout.write")).toMatchObject({
    boundary: { bytes: 13 },
  })
  expect(rows.find((row) => row.type === "adapter.restored")).toMatchObject({ restored: false })
  expect(JSON.stringify(rows)).not.toContain("secret output")
})

test("records renderer boundaries, state, and completed frames", async () => {
  const { diagnostics, rows } = memoryDiagnostics()
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })

  try {
    const restore = instrumentRenderer(diagnostics, setup.renderer)
    setup.renderer.requestRender()
    await setup.renderOnce()
    restore()

    expect(rows.some((row) => row.type === "renderer.requested")).toBe(true)
    expect(rows.some((row) => row.type === "boundary.completed" && row.boundary.name === "renderer.native")).toBe(true)
    expect(rows.some((row) => row.type === "renderer.frame.completed")).toBe(true)
    expect(rows.find((row) => row.type === "adapter.restored")).toMatchObject({
      adapter: "renderer",
      restored: true,
      nativeRestored: true,
    })
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
  }
})
