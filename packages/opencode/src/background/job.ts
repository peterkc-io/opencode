import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer, ScopedCache } from "effect"

export type ExtendInput = CoreBackgroundJob.ExtendInput
export type Info = CoreBackgroundJob.Info
export type StartInput = CoreBackgroundJob.StartInput
export type Status = CoreBackgroundJob.Status
export type WaitInput = CoreBackgroundJob.WaitInput
export type WaitResult = CoreBackgroundJob.WaitResult

export interface Interface extends CoreBackgroundJob.Interface {
  readonly cancelSessionAt: (input: { directory: string; sessionID: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

const cancelSession = Effect.fnUntraced(function* (jobs: CoreBackgroundJob.Interface, sessionID: string) {
  const items = yield* jobs.list()
  const pending = new Set([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: CoreBackgroundJob.Info) => {
    if (job.status !== "running" || cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }

  let batch = items.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        jobs.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = items.filter(matches)
  }
})

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => CoreBackgroundJob.make, FSUtil.resolve)
    const cancelSessionAt = Effect.fn("BackgroundJob.cancelSessionAt")(function* (input: {
      directory: string
      sessionID: string
    }) {
      const directory = FSUtil.resolve(input.directory)
      if (!(yield* ScopedCache.has(state.cache, directory))) return
      yield* cancelSession(yield* ScopedCache.get(state.cache, directory), input.sessionID)
    })

    return Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
      cancelSessionAt,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as BackgroundJob from "./job"
