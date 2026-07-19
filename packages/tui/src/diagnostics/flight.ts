import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import type { DiagnosticEnvelope } from "./event"
import type { DiagnosticSink } from "./service"

type Writer = typeof writeSync

export type FlightRecorder = {
  file?: string
  sink?: DiagnosticSink
}

export function writeAll(fd: number, value: Uint8Array, writer: Writer = writeSync) {
  let offset = 0
  while (offset < value.byteLength) {
    try {
      const written = writer(fd, value, offset, value.byteLength - offset)
      if (written <= 0) throw new Error("Flight recorder write made no progress")
      offset += written
    } catch (error) {
      if (isErrno(error, "EINTR")) continue
      throw error
    }
  }
}

export function makeFlightRecorder(input: {
  enabled: boolean
  logDir: string
  instanceID: string
  now?: Date
}): Effect.Effect<FlightRecorder, never, Scope.Scope> {
  if (!input.enabled) return Effect.succeed({})
  const file = defaultPath(input.logDir, input.instanceID, input.now)

  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const directory = path.dirname(file)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const info = lstatSync(directory)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Flight recorder directory must be a directory")
        if (process.platform !== "win32") chmodSync(directory, 0o700)
        const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW
        const fd = openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY | noFollow,
          0o600,
        )
        try {
          if (process.platform !== "win32") fchmodSync(fd, 0o600)
        } catch (error) {
          closeSync(fd)
          throw error
        }
        return fd
      },
      catch: (cause) => cause,
    }),
    (fd) =>
      Effect.try({
        try: () => closeSync(fd),
        catch: () => undefined,
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.map((fd) => ({
      file,
      sink: {
        name: "flight",
        emit(envelope: DiagnosticEnvelope) {
          // High-frequency scheduler and frame statistics stay in metrics to limit the observer effect.
          if (envelope.type === "renderer.requested" || envelope.type === "renderer.frame.completed") return
          writeAll(fd, Buffer.from(JSON.stringify(withoutUndefined(envelope)) + "\n"))
        },
      },
    })),
    Effect.catch((error) =>
      Effect.sync(() => {
        warn(`TUI diagnostics flight recorder disabled: ${errorMessage(error)}`)
        return {}
      }),
    ),
  )
}

function defaultPath(logDir: string, instanceID: string, now = new Date()) {
  const timestamp = now.toISOString().replaceAll(":", "").replaceAll(".", "")
  return path.join(logDir, "flight", `tui-flight-${instanceID}-${process.pid}-${timestamp}.jsonl`)
}

function withoutUndefined(input: DiagnosticEnvelope) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function warn(message: string) {
  process.stderr.write(message + "\n")
}
