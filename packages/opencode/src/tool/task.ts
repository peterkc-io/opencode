import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Deferred, Effect, Exit, Schema, Scope, Semaphore } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "@/worktree"
import { NotFoundError } from "@/storage/storage"
import path from "path"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const registrationLocks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>()

function withRegistrationLock<A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const existing = registrationLocks.get(sessionID)
      if (existing) {
        existing.users++
        return existing
      }
      const created = { semaphore: Semaphore.makeUnsafe(1), users: 1 }
      registrationLocks.set(sessionID, created)
      return created
    }),
    (entry) => entry.semaphore.withPermits(1)(effect),
    (entry) =>
      Effect.sync(() => {
        entry.users--
        if (entry.users === 0 && registrationLocks.get(sessionID) === entry) registrationLocks.delete(sessionID)
      }),
  )
}

const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")
const WORKTREE_DESCRIPTION = [
  "Worktree placement: worktree must be the absolute path of an existing linked Git worktree for this project.",
  "OpenCode will not create, reset, remove, or clean the worktree.",
  "Omit worktree to inherit the invoking session's execution root.",
].join(" ")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

const BackgroundParameterField = Schema.optional(Schema.Boolean).annotate({
  description:
    "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
})

const WorktreeParameterField = Schema.optional(Schema.String).annotate({
  description: "Absolute path of an existing linked Git worktree where a new task should run",
})

const BackgroundParameters = Schema.Struct({
  ...BaseParameterFields,
  background: BackgroundParameterField,
})

const WorktreeParameters = Schema.Struct({
  ...BaseParameterFields,
  worktree: WorktreeParameterField,
})

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: BackgroundParameterField,
  worktree: WorktreeParameterField,
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const fs = yield* FSUtil.Service

    const canonical = Effect.fnUntraced(function* (input: string) {
      const real = yield* fs.realPath(path.resolve(input))
      const normalized = path.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function eligible(input: Agent.Info | undefined) {
      return input && input.mode !== "primary" ? input : undefined
    }

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.worktree !== undefined && !flags.experimentalSubagentWorktrees) {
        return yield* Effect.fail(new Error("Subagent worktrees require OPENCODE_EXPERIMENTAL_SUBAGENT_WORKTREES=true"))
      }
      const placementBridge = yield* EffectBridge.make()
      const resolveLinked = (directory: string) =>
        placementBridge.run(Worktree.Service.use((worktree) => worktree.resolveLinked(directory)))
      const loadLinked = (directory: string) =>
        placementBridge.run(Worktree.Service.use((worktree) => worktree.loadLinked(directory)))
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const owner = yield* InstanceState.context
      const ownerDirectory = yield* canonical(owner.directory)
      const parent = yield* sessions.assertInstanceDirectory(ctx.sessionID)
      const workspaceID = yield* InstanceState.workspaceID
      if (parent.projectID !== owner.project.id) {
        return yield* Effect.fail(new Error(`Parent session belongs to another project: ${parent.id}`))
      }
      if (parent.workspaceID !== workspaceID) {
        return yield* Effect.fail(new Error(`Parent session belongs to another workspace: ${parent.id}`))
      }
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const ownerAgent = eligible(yield* agent.get(params.subagent_type))
      if (!ownerAgent) {
        return yield* Effect.fail(new Error(`Unknown or ineligible agent type: ${params.subagent_type}`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(
            Effect.catchIf(
              (error) => NotFoundError.isInstance(error),
              () => Effect.succeed(undefined),
            ),
          )
        : undefined
      const explicit = params.worktree ? yield* resolveLinked(params.worktree) : undefined
      const sessionDirectory = session ? yield* canonical(session.directory) : undefined
      const placement = session ? yield* Session.taskPlacement(session) : undefined

      if (session) {
        if (session.parentID !== ctx.sessionID) {
          return yield* Effect.fail(new Error(`Task session does not belong to the invoking parent: ${session.id}`))
        }
        if (session.projectID !== parent.projectID) {
          return yield* Effect.fail(new Error(`Task session belongs to another project: ${session.id}`))
        }
        if (session.workspaceID !== parent.workspaceID) {
          return yield* Effect.fail(new Error(`Task session belongs to another workspace: ${session.id}`))
        }
        if (session.agent !== ownerAgent.name) {
          return yield* Effect.fail(
            new Error(`Task session agent does not match ${params.subagent_type}: ${session.id}`),
          )
        }
      }

      if (placement) {
        const placementOwner = yield* canonical(placement.ownerDirectory)
        const placementExecution = yield* canonical(placement.executionDirectory)
        if (placementOwner !== ownerDirectory || placementExecution !== sessionDirectory) {
          return yield* Effect.fail(
            new Error(`Task session placement does not match its persisted roots: ${session?.id}`),
          )
        }
      }

      const executionDirectory = sessionDirectory ?? explicit?.directory ?? ownerDirectory
      if (sessionDirectory !== undefined && sessionDirectory !== ownerDirectory && !placement) {
        return yield* Effect.fail(new Error(`Placed task session is missing taskPlacement metadata: ${session?.id}`))
      }
      if (sessionDirectory !== undefined && explicit && explicit.directory !== sessionDirectory) {
        return yield* Effect.fail(new Error(`Requested worktree conflicts with the task session root: ${session?.id}`))
      }

      const placed = executionDirectory !== ownerDirectory
      const taskPlacement = placement ?? (explicit ? { ownerDirectory, executionDirectory } : undefined)
      const linkedExecution = placed || taskPlacement !== undefined
      if (linkedExecution) {
        const linked = yield* resolveLinked(executionDirectory)
        if (linked.directory !== executionDirectory) {
          return yield* Effect.fail(new Error(`Linked worktree changed during validation: ${executionDirectory}`))
        }
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            ...(taskPlacement ? { worktree: executionDirectory } : {}),
          },
        })
      }

      if (linkedExecution) {
        const linked = yield* resolveLinked(executionDirectory)
        if (linked.directory !== executionDirectory) {
          return yield* Effect.fail(
            new Error(`Linked worktree changed while permission was pending: ${executionDirectory}`),
          )
        }
      }

      const execution = placed ? yield* loadLinked(executionDirectory) : owner
      if (linkedExecution) {
        const loadedDirectory = yield* canonical(execution.directory)
        const loadedWorktree = yield* canonical(execution.worktree)
        if (
          loadedDirectory !== executionDirectory ||
          loadedWorktree !== executionDirectory ||
          execution.project.id !== parent.projectID
        ) {
          return yield* Effect.fail(
            new Error(`Loaded instance does not match the accepted worktree: ${executionDirectory}`),
          )
        }
        const linked = yield* resolveLinked(executionDirectory)
        if (linked.directory !== executionDirectory) {
          return yield* Effect.fail(
            new Error(`Linked worktree changed during instance bootstrap: ${executionDirectory}`),
          )
        }
      }
      const targetWorkspace = yield* InstanceState.workspaceID.pipe(Effect.provideService(InstanceRef, execution))
      if (targetWorkspace !== parent.workspaceID) {
        return yield* Effect.fail(new Error(`Target instance belongs to another workspace: ${executionDirectory}`))
      }
      const targetCfg = yield* config.get().pipe(Effect.provideService(InstanceRef, execution))

      const next = eligible(yield* agent.get(params.subagent_type).pipe(Effect.provideService(InstanceRef, execution)))
      if (!next) {
        return yield* Effect.fail(new Error(`Target worktree has no eligible agent type: ${params.subagent_type}`))
      }
      if (session && session.agent !== next.name) {
        return yield* Effect.fail(new Error(`Target worktree agent does not match the task session: ${session.id}`))
      }

      const assertLiveBoundary = Effect.fnUntraced(function* () {
        const liveParent = yield* sessions.assertInstanceDirectory(ctx.sessionID)
        if (liveParent.projectID !== owner.project.id) {
          return yield* Effect.fail(new Error(`Parent session belongs to another project: ${liveParent.id}`))
        }
        if (liveParent.workspaceID !== workspaceID) {
          return yield* Effect.fail(new Error(`Parent session belongs to another workspace: ${liveParent.id}`))
        }
        const liveMsg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.orDie,
        )
        const message = liveMsg.info
        if (message.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
        if (linkedExecution) {
          const linked = yield* resolveLinked(executionDirectory)
          if (linked.directory !== executionDirectory) {
            return yield* Effect.fail(
              new Error(`Linked worktree changed before task persistence: ${executionDirectory}`),
            )
          }
        }
        return { parent: liveParent, message }
      })
      let live = yield* assertLiveBoundary()

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: live.parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(targetCfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession = session
        ? session
        : yield* sessions
            .create({
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              agent: next.name,
              metadata: taskPlacement ? { taskPlacement } : undefined,
              permission: [
                ...childPermission,
                ...childToolDenies.filter(
                  (deny) =>
                    !childPermission.some(
                      (rule) =>
                        rule.permission === deny.permission &&
                        rule.pattern === deny.pattern &&
                        rule.action === deny.action,
                    ),
                ),
              ],
            })
            .pipe(Effect.provideService(InstanceRef, execution))

      if (!session) {
        const confirmed = yield* assertLiveBoundary().pipe(Effect.exit)
        if (Exit.isFailure(confirmed)) {
          yield* sessions.remove(nextSession.id).pipe(Effect.provideService(InstanceRef, execution), Effect.ignore)
          return yield* Effect.failCause(confirmed.cause)
        }
        live = confirmed.value
      }

      const model = next.model ?? {
        modelID: live.message.modelID,
        providerID: live.message.providerID,
      }
      const variant = live.message.variant
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
        ...(taskPlacement ? { taskPlacement } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })
      const runTaskInTarget = () =>
        runTask().pipe(
          Effect.provideService(InstanceRef, execution),
          Effect.onInterrupt(() => ops.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, execution))),
        )
      const registrationReady = yield* Deferred.make<void>()
      const registeredRun = Deferred.await(registrationReady).pipe(Effect.andThen(runTaskInTarget()))

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed")
              return inject("completed", result.info.output ?? "").pipe(Effect.provideService(InstanceRef, owner))
            if (result.info?.status === "error")
              return inject("error", result.info.error ?? "").pipe(Effect.provideService(InstanceRef, owner))
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      let registered = false
      const cleanupRegistration = Effect.gen(function* () {
        if (!registered) return
        yield* background.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, owner))
        if (!session)
          yield* sessions.remove(nextSession.id).pipe(Effect.provideService(InstanceRef, execution), Effect.ignore)
      })
      const registration = yield* withRegistrationLock(
        nextSession.id,
        Effect.gen(function* () {
          const extended = yield* background
            .extend({
              id: nextSession.id,
              run: registeredRun,
            })
            .pipe(
              Effect.provideService(InstanceRef, owner),
              Effect.tap((value) => Effect.sync(() => (registered = value))),
              Effect.uninterruptible,
            )
          if (extended) {
            const accepted = yield* assertLiveBoundary().pipe(Effect.exit)
            if (Exit.isFailure(accepted)) {
              yield* background.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, owner))
              if (!session)
                yield* sessions
                  .remove(nextSession.id)
                  .pipe(Effect.provideService(InstanceRef, execution), Effect.ignore)
              return yield* Effect.failCause(accepted.cause)
            }
            yield* Deferred.succeed(registrationReady, undefined)
            return { extended: true as const }
          }

          const info = yield* background
            .start({
              id: nextSession.id,
              type: id,
              title: params.description,
              metadata,
              onPromote: Effect.all([
                ctx.metadata({
                  title: params.description,
                  metadata: { ...metadata, background: true, jobId: nextSession.id },
                }),
                notify(nextSession.id).pipe(Effect.provideService(InstanceRef, owner)),
              ]),
              run: registeredRun,
            })
            .pipe(
              Effect.provideService(InstanceRef, owner),
              Effect.tap(() => Effect.sync(() => (registered = true))),
              Effect.uninterruptible,
            )
          const accepted = yield* assertLiveBoundary().pipe(Effect.exit)
          if (Exit.isFailure(accepted)) {
            yield* background.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, owner))
            if (!session)
              yield* sessions.remove(nextSession.id).pipe(Effect.provideService(InstanceRef, execution), Effect.ignore)
            return yield* Effect.failCause(accepted.cause)
          }
          yield* Deferred.succeed(registrationReady, undefined)
          return { extended: false as const, info }
        }).pipe(Effect.onInterrupt(() => cleanupRegistration)),
      )

      if (registration.extended) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = registration.info

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id).pipe(Effect.provideService(InstanceRef, owner))
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, execution))

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(
                Effect.provideService(InstanceRef, owner),
                Effect.map((waited) => waited.info),
              ),
              background.waitForPromotion(nextSession.id).pipe(Effect.provideService(InstanceRef, owner)),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all(
                [cancel, background.cancel(nextSession.id).pipe(Effect.provideService(InstanceRef, owner))],
                { discard: true },
              )
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: [
        DESCRIPTION,
        ...(flags.experimentalBackgroundSubagents ? [BACKGROUND_DESCRIPTION] : []),
        ...(flags.experimentalSubagentWorktrees ? [WORKTREE_DESCRIPTION] : []),
      ].join("\n\n"),
      parameters: Parameters,
      jsonSchema:
        flags.experimentalBackgroundSubagents && flags.experimentalSubagentWorktrees
          ? undefined
          : ToolJsonSchema.fromSchema(
              flags.experimentalBackgroundSubagents
                ? BackgroundParameters
                : flags.experimentalSubagentWorktrees
                  ? WorktreeParameters
                  : BaseParameters,
            ),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
