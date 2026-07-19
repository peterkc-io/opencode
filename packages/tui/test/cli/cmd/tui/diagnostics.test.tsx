/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { DiagnosticEnvelope } from "../../../../src/diagnostics/event"
import { create } from "../../../../src/diagnostics/service"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"

test("correlates queued events with completed store application", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const rows: DiagnosticEnvelope[] = []
  const diagnostics = create({
    sinks: [{ name: "memory", emit: (event) => rows.push(event) }],
  })
  const { app, emit, sync } = await mount(undefined, tmp.path, diagnostics)

  try {
    emit(todoEvent())
    await wait(() => Array.isArray(sync.data.todo.ses_trace))
  } finally {
    app.renderer.destroy()
  }

  const queued = rows.find((row) => row.type === "event.queued")
  const applied = rows.find((row) => row.type === "boundary.completed" && row.boundary.name === "store.apply")
  expect(queued).toMatchObject({
    eventType: "todo.updated",
    directory,
    projectID: "proj_test",
    sessionID: "ses_trace",
  })
  if (queued?.type !== "event.queued") throw new Error("missing queued diagnostic")
  if (applied?.type !== "boundary.completed" || applied.boundary.name !== "store.apply")
    throw new Error("missing store diagnostic")
  expect(queued.eventID).toBe(applied.boundary.eventID)
  expect(rows.some((row) => row.type === "boundary.completed" && row.boundary.name === "event.flush")).toBe(true)
})

function todoEvent(): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: "evt_trace",
      type: "todo.updated",
      properties: { sessionID: "ses_trace", todos: [] },
    },
  }
}
