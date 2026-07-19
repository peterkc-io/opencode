import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("diagnostics start from the feature flag and close with the TUI", async () => {
  await using tmp = await tmpdir()
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  const previous = process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS
  process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS = "1"
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { sessionID: "ses_start" },
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.layerWith({ log: tmp.path }))),
    )

    await ready
    setup.renderer.requestRender()
    await setup.renderOnce()
    process.emit("SIGHUP")
    await task

    const files = Array.fromAsync(
      new Bun.Glob("tui-flight-*.jsonl").scan({ cwd: `${tmp.path}/flight`, absolute: true }),
    )
    const file = (await files)[0]
    expect(file).toBeDefined()
    const rows = (await Bun.file(file!).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.find((row) => row.type === "diagnostics.started")).toMatchObject({
      directory,
      sessionID: "ses_start",
    })
    expect(rows.some((row) => row.type === "context.updated" && row.projectID === "proj_test")).toBe(true)
    expect(
      rows.some(
        (row) =>
          row.type === "boundary.completed" &&
          (row.boundary as { name?: string } | undefined)?.name === "renderer.native",
      ),
    ).toBe(true)
    expect(rows.some((row) => row.type === "diagnostics.error" && row.stage === "event.stream")).toBe(false)
    const types = rows.map((row) => row.type)
    expect(types.filter((type) => type === "renderer.destroying")).toHaveLength(1)
    expect(types.filter((type) => type === "renderer.destroyed")).toHaveLength(1)
    expect(types.indexOf("renderer.destroying")).toBeLessThan(types.indexOf("renderer.destroyed"))
    expect(rows.at(-1)?.type).toBe("diagnostics.stopped")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS = previous
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("fatal renderer allocation restores the terminal and exits nonzero", async () => {
  const result = await allocationFailure(false)

  expect(result.destroyCalls).toBe(1)
  expect(result.disposes).toBe(1)
  expect(result.titles.at(-1)).toBe("")
  expect(result.stderr).toContain("Failed to create TextBuffer")
  expect(result.exitCode).toBe(1)
  const destroying = result.rows.findIndex((row) => row.type === "renderer.destroying")
  const destroyed = result.rows.findIndex((row) => row.type === "renderer.destroyed")
  const failure = result.rows.findIndex((row) => row.type === "diagnostics.error" && row.stage === "ui")
  expect(destroying).toBeGreaterThanOrEqual(0)
  expect(destroying).toBeLessThan(destroyed)
  expect(destroyed).toBeLessThan(failure)
  expect(result.rows[failure]).toMatchObject({
    error: { type: "error", code: "renderer.text_buffer.create" },
  })
  expect(JSON.stringify(result.rows)).not.toContain("Failed to create TextBuffer")
})

test("fatal renderer allocation preserves the reason when destruction competes", async () => {
  const result = await allocationFailure(true)

  expect(result.destroyCalls).toBe(1)
  expect(result.stderr).toContain("Failed to create TextBuffer")
  expect(result.exitCode).toBe(1)
})

async function allocationFailure(competingDestroy: boolean) {
  await using tmp = await tmpdir()
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  const previousRoute = process.env.OPENCODE_ROUTE
  const previousDiagnostics = process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS
  const previousExitCode = process.exitCode
  const originalParse = JSON.parse
  const originalWrite = process.stderr.write.bind(process.stderr)
  const originalDestroy = setup.renderer.destroy.bind(setup.renderer)
  const originalTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  const marker = "__text_buffer_failure__"
  const titles: string[] = []
  let stderr = ""
  let destroyCalls = 0
  let disposes = 0

  setup.renderer.destroy = () => {
    destroyCalls++
    originalDestroy()
  }
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    originalTitle(title)
  }
  process.env.OPENCODE_ROUTE = marker
  process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS = "1"
  process.exitCode = undefined
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (text === marker) {
      if (competingDestroy) queueMicrotask(() => process.emit("SIGHUP"))
      throw new Error("Failed to create TextBuffer")
    }
    return originalParse(text, reviver)
  }) as typeof JSON.parse
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    const { run } = await import("../src/app")
    await Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {},
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(Global.layerWith({ log: tmp.path }))),
    )

    const files = Array.fromAsync(
      new Bun.Glob("tui-flight-*.jsonl").scan({ cwd: `${tmp.path}/flight`, absolute: true }),
    )
    const file = (await files)[0]
    expect(file).toBeDefined()
    const rows = (await Bun.file(file!).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    return { destroyCalls, disposes, titles, stderr, exitCode: Number(process.exitCode), rows }
  } finally {
    JSON.parse = originalParse
    process.stderr.write = originalWrite
    process.exitCode = previousExitCode
    if (previousRoute === undefined) delete process.env.OPENCODE_ROUTE
    else process.env.OPENCODE_ROUTE = previousRoute
    if (previousDiagnostics === undefined) delete process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS
    else process.env.OPENCODE_EXPERIMENTAL_TUI_DIAGNOSTICS = previousDiagnostics
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}
