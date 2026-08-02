import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, testInstanceBootstrapLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import path from "path"
import { symlink, unlink } from "node:fs/promises"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Worktree.node,
      FSUtil.node,
      Git.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [InstanceStore.bootstrapNode, testInstanceBootstrapLayer],
    ],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
const placed = testEffect(layer({ experimentalSubagentWorktrees: true }))
const placedBackground = testEffect(
  layer({ experimentalSubagentWorktrees: true, experimentalBackgroundSubagents: true }),
)

const withLinkedWorktree = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const svc = yield* Worktree.Service
      const git = yield* Git.Service
      const fs = yield* FSUtil.Service
      const info = yield* svc.makeWorktreeInfo({
        name: `task-target-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      })
      if (!info.branch) throw new Error("linked worktree test requires a branch")
      const result = yield* git.run(["worktree", "add", "-b", info.branch, info.directory], { cwd: test.directory })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
      return yield* fs.realPath(info.directory)
    }).pipe(Effect.orDie),
    use,
    (directory) => Worktree.Service.use((svc) => svc.remove({ directory }).pipe(Effect.ignore)),
  )

const canonical = (directory: string) => FSUtil.canonicalPath(directory)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, user, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects handcrafted worktree input before permission or child creation when disabled", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            worktree: test.directory,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("rejects non-assistant context before permission or child persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, user } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "reject context",
            prompt: "do not run",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: user.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("revalidates parent liveness after permission before child persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "remove parent",
            prompt: "do not run",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => sessions.remove(chat.id).pipe(Effect.orDie),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("cleans up a child when its parent is removed during creation", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Session.Event.Created.type) return Effect.void
        const info = (event.data as typeof Session.Event.Created.data.Type).info
        if (info.parentID !== chat.id) return Effect.void
        return sessions.remove(chat.id).pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const exit = yield* def
        .execute(
          {
            description: "race parent removal",
            prompt: "do not run",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("does not start a task when its parent is removed before job registration", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "race registration",
            prompt: "do not run",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => sessions.remove(chat.id).pipe(Effect.orDie),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("refuses child persistence after its parent has been deleted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      yield* sessions.remove(chat.id)

      const exit = yield* sessions.create({ parentID: chat.id, title: "orphan" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  placed.instance(
    "runs a task in the linked target while keeping its job and result parent-owned",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const owner = yield* InstanceState.context
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const agents = yield* Agent.Service
          const { chat, assistant } = yield* seed()
          yield* fs.writeFileString(
            path.join(test.directory, "opencode.json"),
            JSON.stringify({ experimental: { primary_tools: ["bash"] } }),
          )
          yield* fs.writeFileString(
            path.join(directory, "opencode.json"),
            JSON.stringify({
              experimental: { primary_tools: ["read"] },
              agent: {
                general: {
                  model: "target/worker",
                  permission: { task: "allow", write: "deny" },
                },
              },
            }),
          )

          const tool = yield* TaskTool
          const def = yield* tool.init()
          const roots: string[] = []
          let promptInput: SessionPrompt.PromptInput | undefined
          let permission: unknown
          const promptOps: TaskPromptOps = {
            cancel: () =>
              InstanceState.directory.pipe(
                Effect.tap((root) => Effect.sync(() => roots.push(root))),
                Effect.asVoid,
              ),
            resolvePromptParts: (template) =>
              InstanceState.directory.pipe(
                Effect.tap((root) => Effect.sync(() => roots.push(root))),
                Effect.as([{ type: "text" as const, text: template }]),
              ),
            prompt: (input) =>
              Effect.gen(function* () {
                const root = yield* InstanceState.directory
                roots.push(root)
                promptInput = input
                yield* fs.writeFileString(path.join(root, "task-marker"), "target").pipe(Effect.orDie)
                return reply(input, "placed")
              }),
          }

          const result = yield* def.execute(
            {
              description: "inspect target",
              prompt: "write the target marker",
              subagent_type: "general",
              worktree: directory,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) => Effect.sync(() => (permission = input)),
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)
          const resumed = yield* def.execute(
            {
              description: "resume target",
              prompt: "write the target marker again",
              subagent_type: "general",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(child.directory).toBe(canonical(directory))
          expect(child.metadata?.taskPlacement).toEqual({
            ownerDirectory: canonical(test.directory),
            executionDirectory: canonical(directory),
          })
          expect(child.permission).toEqual([{ permission: "read", pattern: "*", action: "deny" }])
          expect(promptInput?.model?.providerID).toBe(ProviderV2.ID.make("target"))
          expect(promptInput?.model?.modelID).toBe(ModelV2.ID.make("worker"))
          const targetAgent = yield* agents
            .get("general")
            .pipe(Effect.provideService(InstanceRef, { ...owner, directory, worktree: directory }))
          expect(targetAgent?.permission).toContainEqual({ permission: "write", pattern: "*", action: "deny" })
          expect(resumed.metadata.sessionId).toBe(child.id)
          expect(yield* sessions.children(chat.id)).toHaveLength(1)
          expect(roots).toEqual(Array(4).fill(canonical(directory)))
          expect(permission).toEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ worktree: canonical(directory) }) }),
          )
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "task-marker")).text())).toBe("target")
          expect(yield* fs.exists(path.join(test.directory, "task-marker"))).toBe(false)
          expect((yield* jobs.get(child.id))?.status).toBe("completed")
          expect(
            yield* jobs
              .get(child.id)
              .pipe(Effect.provideService(InstanceRef, { ...owner, directory, worktree: directory })),
          ).toBeUndefined()
          expect((yield* sessions.list({ directory: test.directory })).map((item) => item.id)).not.toContain(child.id)
          expect((yield* sessions.list({ directory: canonical(directory) })).map((item) => item.id)).toContain(child.id)
          expect((yield* sessions.list({ scope: "project" })).map((item) => item.id)).toContain(child.id)
        }),
      ),
    { git: true },
    15_000,
  )

  placed.instance(
    "revalidates an explicit linked root inherited by a nested caller",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const owner = yield* InstanceState.context
          const sessions = yield* Session.Service
          const worktrees = yield* Worktree.Service
          const execution = yield* worktrees.loadLinked(directory)
          const { chat, assistant } = yield* seed().pipe(Effect.provideService(InstanceRef, execution))
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let prompted = false

          const exit = yield* def
            .execute(
              {
                description: "revalidate target",
                prompt: "do not run",
                subagent_type: "general",
                worktree: directory,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    ...stubOps(),
                    prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () =>
                  worktrees
                    .remove({ directory })
                    .pipe(Effect.provideService(InstanceRef, owner), Effect.orDie, Effect.asVoid),
              },
            )
            .pipe(Effect.provideService(InstanceRef, execution), Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          expect(prompted).toBe(false)
          expect(yield* sessions.children(chat.id).pipe(Effect.provideService(InstanceRef, execution))).toHaveLength(0)
        }),
      ),
    { git: true },
    15_000,
  )

  placed.instance(
    "cleans up a child when its linked target is removed during creation",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const owner = yield* InstanceState.context
          const events = yield* EventV2Bridge.Service
          const sessions = yield* Session.Service
          const worktrees = yield* Worktree.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let prompted = false

          const unsubscribe = yield* events.listen((event) => {
            if (event.type !== Session.Event.Created.type) return Effect.void
            const info = (event.data as typeof Session.Event.Created.data.Type).info
            if (info.parentID !== chat.id) return Effect.void
            return worktrees
              .remove({ directory })
              .pipe(Effect.provideService(InstanceRef, owner), Effect.orDie, Effect.asVoid)
          })
          yield* Effect.addFinalizer(() => unsubscribe)

          const exit = yield* def
            .execute(
              {
                description: "race target removal",
                prompt: "do not run",
                subagent_type: "general",
                worktree: directory,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    ...stubOps(),
                    prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          expect(prompted).toBe(false)
          expect(yield* sessions.children(chat.id)).toHaveLength(0)
        }),
      ),
    { git: true },
    15_000,
  )

  placed.instance(
    "records explicit same-root placement for a nested caller",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const worktrees = yield* Worktree.Service
          const execution = yield* worktrees.loadLinked(directory)
          const { chat, assistant } = yield* seed().pipe(Effect.provideService(InstanceRef, execution))
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let permission: unknown

          const result = yield* def
            .execute(
              {
                description: "record target",
                prompt: "inspect this root",
                subagent_type: "general",
                worktree: directory,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: { promptOps: stubOps() },
                messages: [],
                metadata: () => Effect.void,
                ask: (input) => Effect.sync(() => (permission = input)),
              },
            )
            .pipe(Effect.provideService(InstanceRef, execution))

          const child = yield* sessions
            .get(result.metadata.sessionId)
            .pipe(Effect.provideService(InstanceRef, execution))
          expect(child.metadata?.taskPlacement).toEqual({
            ownerDirectory: canonical(directory),
            executionDirectory: canonical(directory),
          })
          expect(result.metadata.taskPlacement).toEqual(child.metadata?.taskPlacement)
          expect(permission).toEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ worktree: canonical(directory) }) }),
          )
        }),
      ),
    { git: true },
    15_000,
  )

  placed.instance("rejects invalid placement before permission, persistence, or prompt work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "reject target",
            prompt: "do not run",
            subagent_type: "general",
            worktree: "relative-target",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  placed.instance(
    "revalidates a linked target after permission before child persistence",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const worktrees = yield* Worktree.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let prompted = false

          const exit = yield* def
            .execute(
              {
                description: "remove target",
                prompt: "do not run",
                subagent_type: "general",
                worktree: directory,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    ...stubOps(),
                    prompt: (input) => Effect.sync(() => (prompted = true)).pipe(Effect.as(reply(input, "unexpected"))),
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () => worktrees.remove({ directory }).pipe(Effect.orDie, Effect.asVoid),
              },
            )
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          expect(prompted).toBe(false)
          expect(yield* sessions.children(chat.id)).toHaveLength(0)
        }),
      ),
    { git: true },
    15_000,
  )

  placed.instance(
    "keeps concurrent task fibers pinned to distinct linked worktrees",
    () =>
      withLinkedWorktree((first) =>
        withLinkedWorktree((second) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const { chat, assistant } = yield* seed()
            const tool = yield* TaskTool
            const def = yield* tool.init()
            const firstReady = yield* Deferred.make<void>()
            const secondReady = yield* Deferred.make<void>()
            const roots = new Map<string, string>()
            const promptOps: TaskPromptOps = {
              cancel: () => Effect.void,
              resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
              prompt: (input) =>
                Effect.gen(function* () {
                  const text = input.parts.find((part) => part.type === "text")?.text ?? ""
                  const root = yield* InstanceState.directory
                  roots.set(text, root)
                  yield* fs.writeFileString(path.join(root, `${text}.marker`), root).pipe(Effect.orDie)
                  if (text === "first") {
                    yield* Deferred.succeed(firstReady, undefined)
                    yield* Deferred.await(secondReady)
                  } else {
                    yield* Deferred.succeed(secondReady, undefined)
                    yield* Deferred.await(firstReady)
                  }
                  return reply(input, text)
                }),
            }
            const context = {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            }

            yield* Effect.all(
              [
                def.execute(
                  { description: "first target", prompt: "first", subagent_type: "general", worktree: first },
                  context,
                ),
                def.execute(
                  { description: "second target", prompt: "second", subagent_type: "general", worktree: second },
                  context,
                ),
              ],
              { concurrency: "unbounded" },
            )

            expect(roots).toEqual(
              new Map([
                ["first", canonical(first)],
                ["second", canonical(second)],
              ]),
            )
            expect(yield* Effect.promise(() => Bun.file(path.join(first, "first.marker")).text())).toBe(canonical(first))
            expect(yield* Effect.promise(() => Bun.file(path.join(second, "second.marker")).text())).toBe(
              canonical(second),
            )
          }),
        ),
      ),
    { git: true },
    20_000,
  )

  placed.instance(
    "inherits a nested caller's linked execution root",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const worktrees = yield* Worktree.Service
          const execution = yield* worktrees.loadLinked(directory)
          yield* fs.writeFileString(path.join(directory, "opencode.json"), JSON.stringify({ subagent_depth: 2 }))
          const { chat, assistant } = yield* seed().pipe(Effect.provideService(InstanceRef, execution))
          const child = yield* sessions
            .create({ parentID: chat.id, title: "placed parent", agent: "general" })
            .pipe(Effect.provideService(InstanceRef, execution))
          const nestedAssistant = yield* sessions
            .updateMessage({
              ...assistant,
              id: MessageID.ascending(),
              parentID: MessageID.ascending(),
              sessionID: child.id,
              agent: "general",
            })
            .pipe(Effect.provideService(InstanceRef, execution))
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const roots: string[] = []

          const result = yield* def
            .execute(
              {
                description: "inherit target",
                prompt: "inspect inherited root",
                subagent_type: "general",
              },
              {
                sessionID: child.id,
                messageID: nestedAssistant.id,
                agent: "general",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    ...stubOps(),
                    prompt: (input) =>
                      InstanceState.directory.pipe(
                        Effect.tap((root) => Effect.sync(() => roots.push(root))),
                        Effect.as(reply(input, "inherited")),
                      ),
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.provideService(InstanceRef, execution))

          const grandchild = yield* sessions
            .get(result.metadata.sessionId)
            .pipe(Effect.provideService(InstanceRef, execution))
          expect(grandchild.directory).toBe(canonical(directory))
          expect(grandchild.metadata?.taskPlacement).toBeUndefined()
          expect(roots).toEqual([canonical(directory)])
        }),
      ),
    { git: true, config: { subagent_depth: 2 } },
    15_000,
  )

  placed.instance(
    "places a nested task in a second linked worktree",
    () =>
      withLinkedWorktree((first) =>
        withLinkedWorktree((second) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const sessions = yield* Session.Service
            const worktrees = yield* Worktree.Service
            const execution = yield* worktrees.loadLinked(first)
            yield* fs.writeFileString(path.join(first, "opencode.json"), JSON.stringify({ subagent_depth: 2 }))
            const { chat, assistant } = yield* seed().pipe(Effect.provideService(InstanceRef, execution))
            const child = yield* sessions
              .create({ parentID: chat.id, title: "first target parent", agent: "general" })
              .pipe(Effect.provideService(InstanceRef, execution))
            const nestedAssistant = yield* sessions
              .updateMessage({
                ...assistant,
                id: MessageID.ascending(),
                parentID: MessageID.ascending(),
                sessionID: child.id,
                agent: "general",
              })
              .pipe(Effect.provideService(InstanceRef, execution))
            const tool = yield* TaskTool
            const def = yield* tool.init()
            let root: string | undefined

            const result = yield* def
              .execute(
                {
                  description: "switch target",
                  prompt: "inspect second root",
                  subagent_type: "general",
                  worktree: second,
                },
                {
                  sessionID: child.id,
                  messageID: nestedAssistant.id,
                  agent: "general",
                  abort: new AbortController().signal,
                  extra: {
                    promptOps: {
                      ...stubOps(),
                      prompt: (input) =>
                        InstanceState.directory.pipe(
                          Effect.tap((directory) => Effect.sync(() => (root = directory))),
                          Effect.as(reply(input, "switched")),
                        ),
                    } satisfies TaskPromptOps,
                  },
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              )
              .pipe(Effect.provideService(InstanceRef, execution))

            const grandchild = yield* sessions.get(result.metadata.sessionId).pipe(
              Effect.provideService(InstanceRef, {
                ...execution,
                directory: second,
                worktree: second,
              }),
            )
            expect(root).toBe(canonical(second))
            expect(grandchild.directory).toBe(canonical(second))
            expect(grandchild.metadata?.taskPlacement).toEqual({
              ownerDirectory: canonical(first),
              executionDirectory: canonical(second),
            })
          }),
        ),
      ),
    { git: true, config: { subagent_depth: 2 } },
    20_000,
  )

  placedBackground.instance(
    "routes direct placed-child removal to the owner job and target cancellation",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const cancelled = yield* Deferred.make<string>()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              description: "wait in target",
              prompt: "wait for cancellation",
              subagent_type: "general",
              worktree: directory,
              background: true,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () =>
                    InstanceState.directory.pipe(
                      Effect.flatMap((root) => Deferred.succeed(cancelled, root)),
                      Effect.asVoid,
                    ),
                  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: () => Effect.never,
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
          yield* sessions.remove(result.metadata.sessionId)
          expect(yield* Deferred.await(cancelled)).toBe(canonical(directory))
          expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.status).toBe("cancelled")
          expect(Exit.isFailure(yield* sessions.get(result.metadata.sessionId).pipe(Effect.exit))).toBe(true)
        }),
      ),
    { git: true },
    15_000,
  )

  placedBackground.instance(
    "cancels the owner job when the parent uses a symlink alias",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const owner = yield* InstanceState.context
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const alias = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-alias`)
          yield* Effect.promise(() => symlink(test.directory, alias))
          yield* Effect.addFinalizer(() => Effect.promise(() => unlink(alias)).pipe(Effect.ignore))
          const aliasedOwner = { ...owner, directory: alias, worktree: alias }
          const { chat, assistant } = yield* seed().pipe(Effect.provideService(InstanceRef, aliasedOwner))
          const cancelled = yield* Deferred.make<string>()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def
            .execute(
              {
                description: "wait through alias",
                prompt: "wait for cancellation",
                subagent_type: "general",
                worktree: directory,
                background: true,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    cancel: () =>
                      InstanceState.directory.pipe(
                        Effect.flatMap((root) => Deferred.succeed(cancelled, root)),
                        Effect.asVoid,
                      ),
                    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                    prompt: () => Effect.never,
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.provideService(InstanceRef, aliasedOwner))

          expect(
            (yield* jobs.get(result.metadata.sessionId).pipe(Effect.provideService(InstanceRef, aliasedOwner)))?.status,
          ).toBe("running")
          yield* sessions.remove(result.metadata.sessionId).pipe(Effect.provideService(InstanceRef, aliasedOwner))
          expect(yield* Deferred.await(cancelled)).toBe(canonical(directory))
          expect(
            (yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.provideService(InstanceRef, aliasedOwner)))
              .info?.status,
          ).toBe("cancelled")
        }),
      ),
    { git: true },
    15_000,
  )

  placedBackground.instance(
    "routes cross-root removal of an unplaced target child to its persisted directory",
    () =>
      withLinkedWorktree((directory) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const worktrees = yield* Worktree.Service
          const execution = yield* worktrees.loadLinked(directory)
          const parent = yield* sessions
            .create({ title: "target parent" })
            .pipe(Effect.provideService(InstanceRef, execution))
          const child = yield* sessions
            .create({ parentID: parent.id, title: "nested target child" })
            .pipe(Effect.provideService(InstanceRef, execution))

          yield* jobs
            .start({
              id: child.id,
              type: "task",
              metadata: { parentSessionId: parent.id, sessionId: child.id },
              run: Effect.never,
            })
            .pipe(Effect.provideService(InstanceRef, execution))

          yield* sessions.remove(child.id)

          const waited = yield* jobs
            .wait({ id: child.id, timeout: 1_000 })
            .pipe(Effect.provideService(InstanceRef, execution))
          expect(waited.timedOut).toBe(false)
          expect(waited.info?.status).toBe("cancelled")
          expect(Exit.isFailure(yield* sessions.get(child.id).pipe(Effect.exit))).toBe(true)
        }),
      ),
    { git: true },
    15_000,
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("serializes concurrent resumes when the prior job has completed", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let updates = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.succeed(reply(input, "notified"))
          const text = input.parts.find((part) => part.type === "text")?.text ?? ""
          if (text === "initial") return Effect.succeed(reply(input, text))
          return Effect.gen(function* () {
            updates++
            if (updates === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            } else {
              yield* Deferred.succeed(secondStarted, undefined)
              yield* Deferred.await(releaseSecond)
            }
            return reply(input, text)
          })
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const initial = yield* def.execute(
        {
          description: "complete initial",
          prompt: "initial",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      expect((yield* jobs.wait({ id: initial.metadata.sessionId, timeout: 1_000 })).info?.status).toBe("completed")

      yield* Effect.all(
        [
          def.execute(
            {
              description: "first resume",
              prompt: "first update",
              subagent_type: "general",
              task_id: initial.metadata.sessionId,
              background: true,
            },
            context,
          ),
          def.execute(
            {
              description: "second resume",
              prompt: "second update",
              subagent_type: "general",
              task_id: initial.metadata.sessionId,
              background: true,
            },
            context,
          ),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(firstStarted)
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Deferred.await(secondStarted)
      yield* Deferred.succeed(releaseSecond, undefined)

      const completed = yield* jobs.wait({ id: initial.metadata.sessionId, timeout: 1_000 })
      expect(completed.info?.status).toBe("completed")
      expect(updates).toBe(2)
    }),
  )

  background.instance("cancelling an active background update cancels its prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = yield* Deferred.make<void>()
      const extensionStarted = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<SessionID>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) => Deferred.succeed(cancelled, sessionID).pipe(Effect.asVoid),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          prompts++
          if (prompts === 1) return Deferred.await(first).pipe(Effect.as(reply(input, "first done")))
          return Deferred.succeed(extensionStarted, undefined).pipe(Effect.andThen(Effect.never))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "inspect the first path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      yield* def.execute(
        {
          description: "extend scope",
          prompt: "inspect the second path",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )
      yield* Deferred.succeed(first, undefined)
      yield* Deferred.await(extensionStarted)
      yield* sessions.remove(started.metadata.sessionId)

      expect(yield* Deferred.isDone(cancelled)).toBe(true)
      expect(yield* Deferred.await(cancelled)).toBe(started.metadata.sessionId)
      expect((yield* jobs.wait({ id: started.metadata.sessionId })).info?.status).toBe("cancelled")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run catches descendants registered during cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const lateID = "late-descendant"

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never.pipe(
          Effect.ensuring(
            jobs
              .start({
                id: lateID,
                type: "task",
                metadata: { parentSessionId: child.id },
                run: Effect.never,
              })
              .pipe(Effect.asVoid),
          ),
        ),
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(lateID))?.status).toBe("cancelled")
    }),
  )
})
