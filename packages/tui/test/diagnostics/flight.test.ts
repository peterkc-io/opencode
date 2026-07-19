import { expect, test } from "bun:test"
import { mkdir, stat, symlink } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { DiagnosticEnvelope } from "../../src/diagnostics/event"
import { makeFlightRecorder, writeAll } from "../../src/diagnostics/flight"
import { make } from "../../src/diagnostics/service"
import { tmpdir } from "../fixture/fixture"

test("completes short writes and retries EINTR without duplicating bytes", () => {
  const chunks: number[] = []
  let interrupted = false
  const writer = ((_fd: number, value: Uint8Array, offset: number, length: number) => {
    if (!interrupted) {
      interrupted = true
      throw Object.assign(new Error("interrupted"), { code: "EINTR" })
    }
    const written = Math.min(2, length)
    chunks.push(...value.subarray(offset, offset + written))
    return written
  }) as typeof import("node:fs").writeSync

  writeAll(1, new TextEncoder().encode("abcdef"), writer)

  expect(new TextDecoder().decode(new Uint8Array(chunks))).toBe("abcdef")
})

test("writes a private versioned lifecycle file", async () => {
  await using tmp = await tmpdir()
  const file = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const diagnostics = yield* make({
          enabled: true,
          logDir: tmp.path,
          directory: "/workspace",
          identity: { instanceID: "instance-a", runID: "run-a", pid: 42 },
        })
        diagnostics.emit({
          type: "renderer.requested",
          frameID: 1,
          state: { running: false, rendering: false, scheduled: true, liveRequests: 0, controlState: "idle" },
        })
        diagnostics.emit({
          type: "renderer.frame.completed",
          frameID: 1,
          state: { running: false, rendering: false, scheduled: false, liveRequests: 0, controlState: "idle" },
          stats: {
            nativeLastFrameTime: 1,
            nativeAverageFrameTime: 1,
            nativeFrameCount: 1,
            cellsUpdated: 1,
            averageCellsUpdated: 1,
          },
        })
        diagnostics.emit({ type: "renderer.destroyed" })
        return diagnostics.file
      }),
    ),
  )

  expect(path.basename(file!)).toMatch(/^tui-flight-instance-a-\d+-.*\.jsonl$/)
  expect((await stat(file!)).mode & 0o777).toBe(0o600)
  const rows = await records(file!)
  expect(rows.map((row) => row.type)).toEqual(["diagnostics.started", "renderer.destroyed", "diagnostics.stopped"])
  expect(rows.map((row) => row["flight.sequence"])).toEqual([1, 4, 5])
  expect(rows.every((row) => row.schemaVersion === 2 && row["service.instance.id"] === "instance-a")).toBe(true)
})

test("does not collide for concurrent instances with the same timestamp", async () => {
  await using tmp = await tmpdir()
  const now = new Date("2026-07-18T12:00:00.000Z")
  const files = await Effect.runPromise(
    Effect.scoped(
      Effect.all(
        ["instance-a", "instance-b"].map((instanceID) =>
          makeFlightRecorder({ enabled: true, logDir: tmp.path, instanceID, now }).pipe(
            Effect.map((recorder) => recorder.file),
          ),
        ),
      ),
    ),
  )

  expect(files[0]).toBeDefined()
  expect(files[1]).toBeDefined()
  expect(files[0]).not.toBe(files[1])
})

test("refuses an existing immutable flight path without replacing it", async () => {
  await using tmp = await tmpdir()
  const now = new Date("2026-07-18T12:00:00.000Z")
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* makeFlightRecorder({ enabled: true, logDir: tmp.path, instanceID: "same", now })
        const second = yield* makeFlightRecorder({ enabled: true, logDir: tmp.path, instanceID: "same", now })
        return { first: first.file, second: second.file }
      }),
    ),
  )

  expect(result.first).toBeDefined()
  expect(result.second).toBeUndefined()
  expect(await Bun.file(result.first!).exists()).toBe(true)
})

test.skipIf(process.platform === "win32")("refuses a symlinked flight directory", async () => {
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "target")
  await mkdir(target)
  await symlink(target, path.join(tmp.path, "flight"))

  const recorder = await Effect.runPromise(
    Effect.scoped(makeFlightRecorder({ enabled: true, logDir: tmp.path, instanceID: "instance-a" })),
  )

  expect(recorder.file).toBeUndefined()
  expect(recorder.sink).toBeUndefined()
})

async function records(file: string) {
  return (await Bun.file(file).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as DiagnosticEnvelope)
}
