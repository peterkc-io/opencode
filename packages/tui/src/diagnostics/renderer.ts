import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { errorDetails, type SchedulerState } from "./event"
import type { TuiDiagnostics } from "./service"

export function schedulerState(renderer: CliRenderer): SchedulerState {
  const scheduler = renderer.getSchedulerState()
  return {
    running: scheduler.isRunning,
    rendering: scheduler.isRendering,
    scheduled: scheduler.hasScheduledRender,
    liveRequests: renderer.liveRequestCount,
    controlState: renderer.currentControlState,
  }
}

export function instrumentStdout(
  diagnostics: TuiDiagnostics,
  stdout: { write: typeof process.stdout.write } = process.stdout,
) {
  if (!diagnostics.enabled) return () => {}
  const original = stdout.write
  const instrumented = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
    return diagnostics.measureSync(
      { name: "stdout.write", bytes },
      () => Reflect.apply(original, stdout, [chunk, ...args]) as boolean,
    )
  }) as typeof process.stdout.write

  stdout.write = instrumented
  diagnostics.emit({ type: "adapter.installed", adapter: "stdout" })
  return () => {
    const restored = stdout.write === instrumented
    if (restored) stdout.write = original
    diagnostics.emit({ type: "adapter.restored", adapter: "stdout", restored })
  }
}

export function instrumentRenderer(diagnostics: TuiDiagnostics, renderer: CliRenderer) {
  if (!diagnostics.enabled) return () => {}
  renderer.setGatherStats(true)
  const original = renderer.requestRender
  const native = renderer as unknown as { renderNative?: () => unknown }
  const originalNative = native.renderNative

  const instrumented = () => {
    try {
      original.call(renderer)
      diagnostics.emit({ type: "renderer.requested", frameID: renderer.frameId, state: schedulerState(renderer) })
    } catch (error) {
      diagnostics.emit({ type: "diagnostics.error", stage: "renderer.request", error: errorDetails(error) })
      throw error
    }
  }
  const instrumentedNative = () =>
    diagnostics.measureSync({ name: "renderer.native", frameID: renderer.frameId }, () =>
      originalNative?.call(renderer),
    )
  const onFrame = (event: { frameId: number }) => {
    try {
      diagnostics.emit({
        type: "renderer.frame.completed",
        frameID: event.frameId,
        state: schedulerState(renderer),
        stats: renderer.getNativeStats(),
      })
    } catch (error) {
      diagnostics.emit({ type: "diagnostics.error", stage: "renderer.frame", error: errorDetails(error) })
    }
  }

  renderer.requestRender = instrumented
  if (originalNative) native.renderNative = instrumentedNative
  renderer.on(CliRenderEvents.FRAME, onFrame)
  diagnostics.emit({
    type: "adapter.installed",
    adapter: "renderer",
    nativeAvailable: originalNative !== undefined,
  })

  return () => {
    renderer.off(CliRenderEvents.FRAME, onFrame)
    const restored = renderer.requestRender === instrumented
    const nativeRestored = originalNative !== undefined && native.renderNative === instrumentedNative
    if (restored) renderer.requestRender = original
    if (nativeRestored) native.renderNative = originalNative
    diagnostics.emit({ type: "adapter.restored", adapter: "renderer", restored, nativeRestored })
  }
}
