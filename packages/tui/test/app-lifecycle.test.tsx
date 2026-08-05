import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

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
  const previousExitCode = process.exitCode
  process.exitCode = undefined

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
    expect(process.exitCode).toBeUndefined()
  } finally {
    process.exitCode = previousExitCode
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
  const previousExitCode = process.exitCode
  process.exitCode = undefined
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
    expect(process.exitCode).toBeUndefined()
  } finally {
    process.stdout.write = originalWrite
    process.exitCode = previousExitCode
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("nonfatal renderer errors do not force exit", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  const previousRoute = process.env.OPENCODE_ROUTE
  const previousExitCode = process.exitCode
  const originalParse = JSON.parse
  const marker = "__ordinary_render_failure__"
  process.env.OPENCODE_ROUTE = marker
  process.exitCode = undefined
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (text === marker) throw new Error("ordinary render failure")
    return originalParse(text, reviver)
  }) as typeof JSON.parse

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
          async start() {},
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    setup.renderer.requestRender()
    await setup.renderOnce()
    await setup.renderOnce()
    expect(setup.renderer.isDestroyed).toBe(false)
    expect(process.exitCode).toBeUndefined()
    process.emit("SIGHUP")
    await task
    expect(process.exitCode).toBeUndefined()
  } finally {
    JSON.parse = originalParse
    process.exitCode = previousExitCode
    if (previousRoute === undefined) delete process.env.OPENCODE_ROUTE
    else process.env.OPENCODE_ROUTE = previousRoute
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("fatal renderer allocation restores the terminal and exits nonzero", async () => {
  const result = await allocationFailure({})

  expect(result.destroyCalls).toBe(1)
  expect(result.disposes).toBe(1)
  expect(result.titles.at(-1)).toBe("")
  expect(result.stderr.split("Failed to create TextBuffer")).toHaveLength(2)
  expect(result.exitCode).toBe(1)
  expect(result.listenersRestored).toBe(true)
})

test("fatal renderer allocation replaces an explicit success status", async () => {
  const result = await allocationFailure({ exitCode: 0 })

  expect(result.exitCode).toBe(1)
})

test("fatal renderer allocation preserves an existing failure status", async () => {
  const result = await allocationFailure({ exitCode: 7 })

  expect(result.exitCode).toBe(7)
})

test("fatal renderer allocation preserves the reason when destruction competes", async () => {
  const result = await allocationFailure({ competingDestroy: true })

  expect(result.destroyCalls).toBe(1)
  expect(result.stderr.split("Failed to create TextBuffer")).toHaveLength(2)
  expect(result.exitCode).toBe(1)
})

async function allocationFailure(input: { competingDestroy?: boolean; exitCode?: number }) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  const listeners = new Set(process.listeners("SIGHUP"))
  const previousRoute = process.env.OPENCODE_ROUTE
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
  process.exitCode = input.exitCode
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (text === marker) {
      if (input.competingDestroy) queueMicrotask(() => process.emit("SIGHUP"))
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
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    return {
      destroyCalls,
      disposes,
      titles,
      stderr,
      exitCode: Number(process.exitCode),
      listenersRestored: process.listeners("SIGHUP").every((listener) => listeners.has(listener)),
    }
  } finally {
    JSON.parse = originalParse
    process.stderr.write = originalWrite
    process.exitCode = previousExitCode
    if (previousRoute === undefined) delete process.env.OPENCODE_ROUTE
    else process.env.OPENCODE_ROUTE = previousRoute
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}
