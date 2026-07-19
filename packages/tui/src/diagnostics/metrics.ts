import { Context, Metric } from "effect"
import type { BoundaryName, DiagnosticEnvelope, ErrorStage } from "./event"
import type { DiagnosticSink } from "./service"

const durations = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]

const eventsQueued = Metric.counter("opencode.tui.events.queued", { incremental: true })
const eventsApplied = Metric.counter("opencode.tui.events.applied", { incremental: true })
const eventQueueSize = Metric.gauge("opencode.tui.event_queue.size")
const eventBatchSize = Metric.histogram("opencode.tui.event_batch.size", {
  boundaries: [1, 2, 4, 8, 16, 32, 64, 128, 256],
})
const eventFlushDuration = Metric.histogram("opencode.tui.event_flush.duration", {
  boundaries: durations,
  attributes: { unit: "s" },
})
const storeApplyDuration = Metric.histogram("opencode.tui.store_apply.duration", {
  boundaries: durations,
  attributes: { unit: "s" },
})
const renderRequests = Metric.counter("opencode.tui.render.requests", { incremental: true })
const liveRequests = Metric.gauge("opencode.tui.renderer.live_requests")
const rendererScheduled = Metric.gauge("opencode.tui.renderer.scheduled")
const rendererRendering = Metric.gauge("opencode.tui.renderer.rendering")
const nativeRenderDuration = Metric.histogram("opencode.tui.native_render.duration", {
  boundaries: durations,
  attributes: { unit: "s" },
})
const stdoutWriteDuration = Metric.histogram("opencode.tui.stdout_write.duration", {
  boundaries: durations,
  attributes: { unit: "s" },
})
const framesCompleted = Metric.counter("opencode.tui.frames.completed", { incremental: true })
const cellsUpdated = Metric.histogram("opencode.tui.cells_updated", {
  boundaries: [0, 1, 10, 100, 1_000, 10_000, 100_000],
})
const errors = Metric.counter("opencode.tui.errors", { incremental: true })

const errorStages = [
  "renderer.create",
  "renderer.request",
  "renderer.native",
  "stdout.write",
  "solid.mount",
  "event.flush",
  "store.apply",
  "event.stream",
  "renderer.frame",
  "ui",
] as const satisfies ReadonlyArray<ErrorStage>

const errorsByStage = Object.fromEntries(
  errorStages.map((stage) => [stage, Metric.withAttributes(errors, { stage })]),
) as Record<ErrorStage, typeof errors>

export function makeMetricsSink(context: Context.Context<never>): DiagnosticSink {
  const update = <Input, State>(metric: Metric.Metric<Input, State>, input: Input) =>
    metric.updateUnsafe(input, context)
  const state = (value: { liveRequests: number; scheduled: boolean; rendering: boolean }) => {
    if (Number.isFinite(value.liveRequests) && value.liveRequests >= 0) update(liveRequests, value.liveRequests)
    update(rendererScheduled, Number(value.scheduled))
    update(rendererRendering, Number(value.rendering))
  }
  const duration = (name: BoundaryName, durationMs: number) => {
    const seconds = durationMs / 1_000
    if (!Number.isFinite(seconds) || seconds < 0) return
    if (name === "event.flush") update(eventFlushDuration, seconds)
    if (name === "store.apply") update(storeApplyDuration, seconds)
    if (name === "renderer.native") update(nativeRenderDuration, seconds)
    if (name === "stdout.write") update(stdoutWriteDuration, seconds)
  }

  return {
    name: "metrics",
    emit(event) {
      switch (event.type) {
        case "event.queued":
          update(eventsQueued, 1)
          if (Number.isFinite(event.queueSize) && event.queueSize >= 0) update(eventQueueSize, event.queueSize)
          return
        case "boundary.started":
          return
        case "boundary.completed":
          duration(event.boundary.name, event.durationMs)
          if (event.boundary.name === "event.flush") {
            if (Number.isFinite(event.boundary.count) && event.boundary.count >= 0)
              update(eventBatchSize, event.boundary.count)
            update(eventQueueSize, 0)
          }
          if (event.boundary.name === "store.apply") update(eventsApplied, 1)
          return
        case "boundary.failed":
          update(errorsByStage[event.boundary.name], 1)
          if (event.boundary.name === "event.flush") update(eventQueueSize, 0)
          return
        case "renderer.requested":
          update(renderRequests, 1)
          state(event.state)
          return
        case "renderer.frame.completed":
          update(framesCompleted, 1)
          state(event.state)
          if (Number.isFinite(event.stats.cellsUpdated) && event.stats.cellsUpdated >= 0)
            update(cellsUpdated, event.stats.cellsUpdated)
          return
        case "diagnostics.error":
          update(errorsByStage[event.stage], 1)
          return
        case "diagnostics.started":
        case "diagnostics.stopped":
        case "context.updated":
        case "adapter.installed":
        case "adapter.restored":
        case "renderer.destroying":
        case "renderer.destroyed":
          return
        default:
          return assertNever(event)
      }
    },
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI diagnostic event: ${JSON.stringify(value)}`)
}
