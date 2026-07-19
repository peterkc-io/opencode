import { expect, test } from "bun:test"
import { Effect, Metric } from "effect"
import { makeMetricsSink } from "../../src/diagnostics/metrics"
import { create } from "../../src/diagnostics/service"

test("projects queue, boundary, renderer, frame, and error events", async () => {
  const { before, after } = await collect((diagnostics) => {
    diagnostics.emit({ type: "event.queued", eventType: "todo.updated", queueSize: 3 })
    diagnostics.emit({
      type: "boundary.completed",
      operationID: 1,
      boundary: { name: "event.flush", count: 3 },
      durationMs: 250,
    })
    diagnostics.emit({
      type: "boundary.completed",
      operationID: 2,
      boundary: { name: "store.apply", eventType: "todo.updated" },
      durationMs: 10,
    })
    diagnostics.emit({
      type: "renderer.frame.completed",
      frameID: 1,
      state: { running: true, rendering: false, scheduled: false, liveRequests: 2, controlState: "idle" },
      stats: {
        nativeLastFrameTime: 0,
        nativeAverageFrameTime: 0,
        nativeFrameCount: 1,
        cellsUpdated: 12,
        averageCellsUpdated: 12,
      },
    })
    diagnostics.emit({
      type: "diagnostics.error",
      stage: "event.stream",
      error: { type: "error" },
    })
  })

  expect(delta(before, after, "opencode.tui.events.queued", "Counter", "count")).toBe(1)
  expect(delta(before, after, "opencode.tui.events.applied", "Counter", "count")).toBe(1)
  expect(state(after, "opencode.tui.event_queue.size", "Gauge").value).toBe(0)
  expect(delta(before, after, "opencode.tui.event_batch.size", "Histogram", "count")).toBe(1)
  expect(delta(before, after, "opencode.tui.event_batch.size", "Histogram", "sum")).toBe(3)
  expect(delta(before, after, "opencode.tui.event_flush.duration", "Histogram", "sum")).toBeCloseTo(0.25)
  expect(delta(before, after, "opencode.tui.store_apply.duration", "Histogram", "sum")).toBeCloseTo(0.01)
  expect(delta(before, after, "opencode.tui.frames.completed", "Counter", "count")).toBe(1)
  expect(state(after, "opencode.tui.renderer.live_requests", "Gauge").value).toBe(2)
  expect(delta(before, after, "opencode.tui.cells_updated", "Histogram", "sum")).toBe(12)
  expect(delta(before, after, "opencode.tui.errors", "Counter", "count", { stage: "event.stream" })).toBe(1)
})

test("failed boundaries increment a bounded error series and reset affected gauges", async () => {
  const { before, after } = await collect((diagnostics) => {
    diagnostics.emit({ type: "event.queued", eventType: "todo.updated", queueSize: 10 })
    diagnostics.emit({
      type: "boundary.failed",
      operationID: 1,
      boundary: { name: "event.flush", count: 10 },
      durationMs: 25,
      error: { type: "error" },
    })
  })

  expect(state(after, "opencode.tui.event_queue.size", "Gauge").value).toBe(0)
  expect(delta(before, after, "opencode.tui.event_flush.duration", "Histogram", "count")).toBe(0)
  expect(delta(before, after, "opencode.tui.errors", "Counter", "count", { stage: "event.flush" })).toBe(1)
})

test("high-cardinality flight context does not create metric series", async () => {
  const { before, after } = await collect(
    (diagnostics) => {
      for (let index = 0; index < 1_000; index++) {
        diagnostics.emit({
          type: "event.queued",
          eventType: "message.updated",
          queueSize: index,
          eventID: index,
          context: {
            directory: `/workspace/${index}`,
            projectID: `project-${index}`,
            sessionID: `session-${index}`,
          },
        })
      }
    },
    (diagnostics) => diagnostics.emit({ type: "event.queued", eventType: "message.updated", queueSize: 0 }),
  )

  expect(series(after)).toEqual(series(before))
  expect(delta(before, after, "opencode.tui.events.queued", "Counter", "count")).toBe(1_000)
})

async function collect(
  run: (diagnostics: ReturnType<typeof create>) => void,
  setup?: (diagnostics: ReturnType<typeof create>) => void,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      const diagnostics = create({ sinks: [makeMetricsSink(context)] })
      setup?.(diagnostics)
      const before = Metric.snapshotUnsafe(context)
      run(diagnostics)
      return { before, after: Metric.snapshotUnsafe(context) }
    }),
  )
}

type Snapshot = {
  id: string
  type: string
  attributes?: Readonly<Record<string, string>>
  state: unknown
}

function delta(
  before: ReadonlyArray<Snapshot>,
  after: ReadonlyArray<Snapshot>,
  id: string,
  type: string,
  field: string,
  attributes?: Readonly<Record<string, string>>,
) {
  return state(after, id, type, attributes)[field] - (optionalState(before, id, type, attributes)?.[field] ?? 0)
}

function state(
  snapshots: ReadonlyArray<Snapshot>,
  id: string,
  type: string,
  attributes?: Readonly<Record<string, string>>,
): Record<string, number> {
  const value = optionalState(snapshots, id, type, attributes)
  if (!value) throw new Error(`missing ${id} ${type} metric`)
  return value
}

function optionalState(
  snapshots: ReadonlyArray<Snapshot>,
  id: string,
  type: string,
  attributes?: Readonly<Record<string, string>>,
) {
  const snapshot = snapshots.find(
    (item) =>
      item.id === id &&
      item.type === type &&
      Object.entries(attributes ?? {}).every(([key, value]) => item.attributes?.[key] === value),
  )
  return snapshot?.state as Record<string, number> | undefined
}

function series(snapshots: ReadonlyArray<Snapshot>) {
  return snapshots.map((snapshot) => `${snapshot.id}:${JSON.stringify(snapshot.attributes ?? {})}`).toSorted()
}
