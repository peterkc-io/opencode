import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { instanceID, runID } from "@opencode-ai/core/observability/shared"
import type { BoundaryDetail, DiagnosticContext, DiagnosticEnvelope, DiagnosticEvent } from "./event"
import { errorDetails, SCHEMA_VERSION } from "./event"
import { makeFlightRecorder } from "./flight"
import { makeMetricsSink } from "./metrics"

export type DiagnosticSink = {
  name: string
  emit(event: DiagnosticEnvelope): void
}

export type TuiDiagnostics = {
  enabled: boolean
  file?: string
  emit(event: DiagnosticEvent): number | undefined
  setContext(context: DiagnosticContext): void
  correlate(object: object): number | undefined
  measureSync<A>(boundary: BoundaryDetail, operation: () => A): A
  measureAsync<A>(boundary: BoundaryDetail, operation: () => Promise<A>): Promise<A>
}

export const disabled: TuiDiagnostics = {
  enabled: false,
  emit: () => undefined,
  setContext: () => {},
  correlate: () => undefined,
  measureSync: (_boundary, operation) => operation(),
  measureAsync: (_boundary, operation) => operation(),
}

export function make(input: {
  enabled: boolean
  logDir: string
  component?: string
  directory?: string
  sessionID?: string
  identity?: DiagnosticIdentity
}): Effect.Effect<TuiDiagnostics, never, Scope.Scope> {
  if (!input.enabled) return Effect.succeed(disabled)

  return Effect.gen(function* () {
    const identity = input.identity ?? defaultIdentity
    const metricContext = yield* Effect.context<never>()
    const flight = yield* makeFlightRecorder({ enabled: true, logDir: input.logDir, instanceID: identity.instanceID })
    const diagnostics = create({
      sinks: [flight.sink, makeMetricsSink(metricContext)].filter((sink): sink is DiagnosticSink => sink !== undefined),
      file: flight.file,
      component: input.component ?? "tui",
      context: { directory: input.directory, sessionID: input.sessionID },
      identity,
    })
    diagnostics.emit({ type: "diagnostics.started", file: flight.file })
    yield* Effect.addFinalizer(() => Effect.sync(() => diagnostics.emit({ type: "diagnostics.stopped" })))
    return diagnostics
  })
}

export function create(input: {
  sinks: ReadonlyArray<DiagnosticSink>
  file?: string
  component?: string
  context?: DiagnosticContext
  clock?: () => Date
  monotonic?: () => number
  identity?: DiagnosticIdentity
}): TuiDiagnostics {
  let context = compact(input.context ?? {})
  let sequence = 0
  let correlationSequence = 0
  let operationSequence = 0
  const correlations = new WeakMap<object, number>()
  const active = new Set(input.sinks)
  const clock = input.clock ?? (() => new Date())
  const monotonic = input.monotonic ?? (() => performance.now())
  const component = input.component ?? "tui"
  const identity = input.identity ?? defaultIdentity

  const emit = (event: DiagnosticEvent) => {
    const current = ++sequence
    const override = event.type === "event.queued" ? event.context : undefined
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      "flight.sequence": current,
      timestamp: clock().toISOString(),
      monotonicMs: monotonic(),
      pid: identity.pid,
      "service.instance.id": identity.instanceID,
      "opencode.run": identity.runID,
      "opencode.component": component,
      ...context,
      ...compact(override ?? {}),
      ...event,
      ...(event.type === "event.queued" ? { context: undefined } : {}),
    } as DiagnosticEnvelope

    for (const sink of active) {
      try {
        sink.emit(envelope)
      } catch (error) {
        active.delete(sink)
        warn(`TUI diagnostics ${sink.name} sink disabled: ${errorMessage(error)}`)
      }
    }
    return current
  }

  const service: TuiDiagnostics = {
    enabled: true,
    file: input.file,
    emit,
    setContext(next) {
      context = compact(next)
      emit({ type: "context.updated" })
    },
    correlate(object) {
      const existing = correlations.get(object)
      if (existing !== undefined) return existing
      const id = ++correlationSequence
      correlations.set(object, id)
      return id
    },
    measureSync(boundary, operation) {
      const operationID = ++operationSequence
      emit({ type: "boundary.started", operationID, boundary })
      const started = monotonic()
      try {
        const result = operation()
        emit({ type: "boundary.completed", operationID, boundary, durationMs: monotonic() - started })
        return result
      } catch (error) {
        emit({
          type: "boundary.failed",
          operationID,
          boundary,
          durationMs: monotonic() - started,
          error: errorDetails(error),
        })
        throw error
      }
    },
    async measureAsync(boundary, operation) {
      const operationID = ++operationSequence
      emit({ type: "boundary.started", operationID, boundary })
      const started = monotonic()
      try {
        const result = await operation()
        emit({ type: "boundary.completed", operationID, boundary, durationMs: monotonic() - started })
        return result
      } catch (error) {
        emit({
          type: "boundary.failed",
          operationID,
          boundary,
          durationMs: monotonic() - started,
          error: errorDetails(error),
        })
        throw error
      }
    },
  }
  return service
}

export type DiagnosticIdentity = {
  instanceID: string
  runID: string
  pid: number
}

const defaultIdentity: DiagnosticIdentity = {
  instanceID,
  runID,
  pid: process.pid,
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined)) as T
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function warn(message: string) {
  process.stderr.write(message + "\n")
}
