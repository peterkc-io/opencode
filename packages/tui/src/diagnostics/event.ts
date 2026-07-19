import { isRecord } from "../util/record"

export const SCHEMA_VERSION = 2

export type DiagnosticContext = {
  directory?: string
  projectID?: string
  sessionID?: string
  workspaceID?: string
}

export type DiagnosticErrorCode =
  | "renderer.text_buffer.create"
  | "renderer.text_buffer_view.create"
  | "renderer.editor_view.create"
  | "renderer.edit_buffer.create"
  | "renderer.syntax_style.create"

export type DiagnosticError = {
  type: "error" | "string" | "object" | "null" | "primitive"
  code?: DiagnosticErrorCode
}

export type ErrorStage = BoundaryName | "event.stream" | "renderer.frame" | "renderer.request" | "ui"

export type SchedulerState = {
  running: boolean
  rendering: boolean
  scheduled: boolean
  liveRequests: number
  controlState: string
}

export type NativeStats = {
  nativeLastFrameTime: number
  nativeAverageFrameTime: number
  nativeFrameCount: number
  cellsUpdated: number
  averageCellsUpdated: number
  nativeRenderTime?: number
  nativeStdoutWriteTime?: number
}

export type BoundaryDetail =
  | { name: "renderer.create" }
  | { name: "renderer.native"; frameID: number }
  | { name: "stdout.write"; bytes: number }
  | { name: "solid.mount" }
  | { name: "event.flush"; count: number; firstEventID?: number; lastEventID?: number }
  | { name: "store.apply"; eventID?: number; eventType: string }

export type BoundaryName = BoundaryDetail["name"]

export type DiagnosticEvent =
  | { type: "diagnostics.started"; file?: string }
  | { type: "diagnostics.stopped" }
  | { type: "context.updated" }
  | { type: "adapter.installed"; adapter: "renderer" | "stdout"; nativeAvailable?: boolean }
  | { type: "adapter.restored"; adapter: "renderer" | "stdout"; restored: boolean; nativeRestored?: boolean }
  | { type: "renderer.destroying" }
  | { type: "renderer.destroyed" }
  | { type: "renderer.requested"; frameID: number; state: SchedulerState }
  | { type: "renderer.frame.completed"; frameID: number; state: SchedulerState; stats: NativeStats }
  | {
      type: "event.queued"
      eventID?: number
      eventType: string
      queueSize: number
      context?: DiagnosticContext
    }
  | { type: "boundary.started"; operationID: number; boundary: BoundaryDetail }
  | { type: "boundary.completed"; operationID: number; boundary: BoundaryDetail; durationMs: number }
  | {
      type: "boundary.failed"
      operationID: number
      boundary: BoundaryDetail
      durationMs: number
      error: DiagnosticError
    }
  | { type: "diagnostics.error"; stage: ErrorStage; error: DiagnosticError }

export type DiagnosticEnvelope = DiagnosticContext &
  DiagnosticEvent & {
    schemaVersion: typeof SCHEMA_VERSION
    "flight.sequence": number
    timestamp: string
    monotonicMs: number
    pid: number
    "service.instance.id": string
    "opencode.run": string
    "opencode.component": string
  }

const codes = new Map<string, DiagnosticErrorCode>([
  ["Failed to create TextBuffer", "renderer.text_buffer.create"],
  ["Failed to create TextBufferView", "renderer.text_buffer_view.create"],
  ["Failed to create EditorView", "renderer.editor_view.create"],
  ["Failed to create EditBuffer", "renderer.edit_buffer.create"],
  ["Failed to create SyntaxStyle", "renderer.syntax_style.create"],
])

export function errorDetails(error: unknown): DiagnosticError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined
  const code = message === undefined ? undefined : codes.get(message)
  if (error instanceof Error) return { type: "error", code }
  if (error === null) return { type: "null", code }
  if (typeof error === "string") return { type: "string", code }
  if (typeof error === "object") return { type: "object", code }
  return { type: "primitive", code }
}

export function sessionID(event: unknown) {
  if (!isRecord(event)) return
  const properties = event.properties
  if (!isRecord(properties)) return
  if (typeof properties.sessionID === "string") return properties.sessionID
  if (isRecord(properties.info) && typeof properties.info.sessionID === "string") return properties.info.sessionID
  if (
    typeof event.type === "string" &&
    event.type.startsWith("session.") &&
    isRecord(properties.info) &&
    typeof properties.info.id === "string"
  )
    return properties.info.id
  if (isRecord(properties.part) && typeof properties.part.sessionID === "string") return properties.part.sessionID
}
