import { expect, test } from "bun:test"
import type { DiagnosticEnvelope } from "../../src/diagnostics/event"
import { errorDetails, sessionID } from "../../src/diagnostics/event"
import { create, disabled } from "../../src/diagnostics/service"

const identity = { instanceID: "instance-a", runID: "run-a", pid: 42 }

test("disabled diagnostics preserve operations without emitting", async () => {
  const value = { ok: true }
  expect(disabled.measureSync({ name: "solid.mount" }, () => value)).toBe(value)
  expect(await disabled.measureAsync({ name: "renderer.create" }, async () => value)).toBe(value)
  expect(disabled.emit({ type: "diagnostics.stopped" })).toBeUndefined()
  expect(disabled.correlate({})).toBeUndefined()
})

test("enriches ordered events and applies event context without undefined overrides", () => {
  const rows: DiagnosticEnvelope[] = []
  let wall = 2
  let monotonic = 10
  const diagnostics = create({
    sinks: [{ name: "memory", emit: (event) => rows.push(event) }],
    context: { directory: "/workspace", projectID: "project-a", sessionID: "session-a" },
    identity,
    clock: () => new Date(wall-- * 1_000),
    monotonic: () => monotonic++,
  })

  diagnostics.emit({
    type: "event.queued",
    eventType: "todo.updated",
    queueSize: 1,
    context: { projectID: "project-b", sessionID: undefined },
  })
  diagnostics.emit({ type: "renderer.destroyed" })

  expect(rows.map((row) => row["flight.sequence"])).toEqual([1, 2])
  expect(rows.map((row) => row.monotonicMs)).toEqual([10, 11])
  expect(rows[0]).toMatchObject({
    schemaVersion: 2,
    pid: 42,
    "service.instance.id": "instance-a",
    "opencode.run": "run-a",
    directory: "/workspace",
    projectID: "project-b",
    sessionID: "session-a",
  })
  expect(Reflect.get(rows[0], "context")).toBeUndefined()
  expect(Date.parse(rows[0].timestamp)).toBeGreaterThan(Date.parse(rows[1].timestamp))
})

test("correlates objects and preserves boundary results and failures", async () => {
  const rows: DiagnosticEnvelope[] = []
  let monotonic = 0
  const diagnostics = create({
    sinks: [{ name: "memory", emit: (event) => rows.push(event) }],
    identity,
    monotonic: () => (monotonic += 5),
  })
  const first = {}
  const second = {}

  expect(diagnostics.correlate(first)).toBe(diagnostics.correlate(first))
  expect(diagnostics.correlate(first)).not.toBe(diagnostics.correlate(second))
  expect(diagnostics.measureSync({ name: "solid.mount" }, () => 7)).toBe(7)
  await expect(
    diagnostics.measureAsync({ name: "renderer.create" }, async () => {
      throw new Error("renderer failed")
    }),
  ).rejects.toThrow("renderer failed")

  const completed = rows.find((row) => row.type === "boundary.completed")
  const failed = rows.find((row) => row.type === "boundary.failed")
  expect(completed).toMatchObject({ operationID: 1, durationMs: 5 })
  expect(failed).toMatchObject({ operationID: 2, durationMs: 5, error: { type: "error" } })
  expect(JSON.stringify(failed)).not.toContain("renderer failed")
})

test("isolates a failing sink from remaining diagnostics", () => {
  const rows: DiagnosticEnvelope[] = []
  let attempts = 0
  const diagnostics = create({
    sinks: [
      {
        name: "broken",
        emit() {
          attempts++
          throw new Error("disk full")
        },
      },
      { name: "memory", emit: (event) => rows.push(event) },
    ],
    identity,
  })

  diagnostics.emit({ type: "renderer.destroyed" })
  diagnostics.emit({ type: "diagnostics.stopped" })

  expect(attempts).toBe(1)
  expect(rows.map((row) => row.type)).toEqual(["renderer.destroyed", "diagnostics.stopped"])
})

test("records only categorical allowlisted error details", () => {
  const secret = "prompt-token-do-not-record"
  const error = Object.assign(new Error(secret), { name: secret, stack: secret, token: secret })

  expect(errorDetails(error)).toEqual({ type: "error" })
  expect(errorDetails(new Error("Failed to create TextBuffer"))).toEqual({
    type: "error",
    code: "renderer.text_buffer.create",
  })
  expect(errorDetails("Failed to create SyntaxStyle")).toEqual({
    type: "string",
    code: "renderer.syntax_style.create",
  })
  expect(JSON.stringify(errorDetails(error))).not.toContain(secret)
  expect(sessionID({ type: "session.updated", properties: { info: { id: "session-a" } } })).toBe("session-a")
})
