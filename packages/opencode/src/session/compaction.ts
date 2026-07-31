import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Cause, Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { Auth } from "@/auth"
import { ProviderTransform } from "@/provider/transform"
import { OpenAICompaction } from "@/provider/openai-compaction"
import { LLMNative } from "./llm/native-request"
import { LLMClient } from "@opencode-ai/llm/route"
import type { OpenAIResponses } from "@opencode-ai/llm/protocols"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { mergeDeep } from "remeda"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const auth = yield* Auth.Service
    const client = yield* LLMClient.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    const remote = Effect.fn("SessionCompaction.remote")(function* (input: {
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      user: SessionV1.User
      model: Provider.Model
    }) {
      const attemptedAt = Date.now()
      const fallback = (
        reason: SessionV1.OpenAICompactionFallback["reason"],
        statusCode?: number,
      ): SessionV1.OpenAICompactionFallback => ({
        status: "fallback",
        reason,
        statusCode,
        time: attemptedAt,
      })
      const info = yield* provider.getProvider(input.model.providerID)
      const credentials = yield* auth.get(input.model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const credentialSalt = crypto.randomUUID()
      const fingerprint = OpenAICompaction.credentialFingerprint(info, credentials, credentialSalt)
      const apiKey = OpenAICompaction.apiKey(info, credentials)
      if (!fingerprint || (credentials?.type === "oauth" && !credentials.accountId)) {
        return fallback("unsupported_auth")
      }

      const baseURL = OpenAICompaction.baseURL(yield* provider.getBaseURL(input.model))
      const responsesURL = (() => {
        try {
          return new URL(baseURL)
        } catch {
          return undefined
        }
      })()
      if (!responsesURL) return fallback("invalid_response")
      responsesURL.pathname = `${responsesURL.pathname.replace(/\/+$/, "")}/responses`
      const query = info.options.queryParams
      if (query && typeof query === "object") {
        for (const [key, value] of Object.entries(query)) {
          if (typeof value === "string") responsesURL.searchParams.set(key, value)
        }
      }
      const endpoint = OpenAICompaction.compactURL(responsesURL.toString())
      if (!endpoint) return fallback("invalid_response")

      const base = ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: info.options,
      })
      const variant =
        input.user.model.variant && input.model.variants ? input.model.variants[input.user.model.variant] : undefined
      const options = mergeDeep(mergeDeep(base, input.model.options), variant ?? {}) as Record<string, any>
      const messages = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      const transformed = ProviderTransform.message(messages, input.model, options)
      const request = LLMNative.request({
        model: input.model,
        apiKey,
        baseURL,
        messages: transformed,
        providerOptions: ProviderTransform.providerOptions(input.model, options),
      })
      const prepared = yield* client
        .prepare<OpenAIResponses.OpenAIResponsesBody>(request)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!prepared) return fallback("internal_error")
      const body = OpenAICompaction.compactBody(prepared.body)
      if (!body) return fallback("invalid_response")
      if (credentials?.type !== "oauth") delete body.service_tier

      const previous = MessageV2.openAICompaction(input.messages)
      if (
        previous &&
        OpenAICompaction.matches({
          state: previous.state,
          model: input.model,
          provider: info,
          auth: credentials,
          baseURL,
        })
      ) {
        const replayed = OpenAICompaction.replayInput(body.input, {
          ...previous,
          oauth: credentials?.type === "oauth",
        })
        if (replayed) body.input = replayed
      }

      const hook = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.user.agent,
          model: input.model,
          provider: info,
          message: input.user,
        },
        { headers: {} as Record<string, string> },
      )
      const headers = new Headers({
        ...OpenAICompaction.headers(info.options.headers),
        ...input.model.headers,
        ...hook.headers,
        "content-type": "application/json",
      })
      if (credentials?.type !== "oauth" && apiKey && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${apiKey}`)
      }
      const fetcher = OpenAICompaction.fetcher(info.options.fetch) ?? ((input, init) => fetch(input, init))
      const timeout =
        typeof info.options.timeout === "number" && info.options.timeout > 0 ? info.options.timeout : 60_000
      const headerTimeout =
        typeof info.options.headerTimeout === "number" && info.options.headerTimeout > 0
          ? info.options.headerTimeout
          : undefined
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const headerController = headerTimeout ? new AbortController() : undefined
          const headerTimer = headerController
            ? setTimeout(
                () => headerController.abort(new Error("OpenAI compact response header timeout")),
                headerTimeout,
              )
            : undefined
          const signals = [signal, AbortSignal.timeout(timeout)]
          if (headerController) signals.push(headerController.signal)
          try {
            return await fetcher(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: AbortSignal.any(signals),
            })
          } finally {
            if (headerTimer) clearTimeout(headerTimer)
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!response) return fallback("network_error")
      if (!response.ok) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)
        return fallback("http_error", response.status)
      }
      const payload = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => undefined,
      }).pipe(
        Effect.catch(() =>
          Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore, Effect.as(undefined)),
        ),
      )
      const result = OpenAICompaction.response(payload)
      if (!result) return fallback("invalid_response")
      return {
        status: "success",
        responseID: result.id,
        providerID: input.model.providerID,
        modelID: input.model.id,
        apiModelID: input.model.api.id,
        baseURL,
        authType: credentials?.type === "oauth" ? "oauth" : "api",
        credentialSalt,
        credentialFingerprint: fingerprint,
        output: result.output,
        time: attemptedAt,
      } satisfies SessionV1.OpenAICompactionSuccess
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const remoteModel =
        !input.auto && !flags.experimentalNativeLlm && userMessage.model.providerID === "openai"
          ? yield* provider
              .getModel(userMessage.model.providerID, userMessage.model.modelID)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : (remoteModel ??
          (yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)))
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const remoteInput =
        compactionPart && remoteModel?.api.npm === "@ai-sdk/openai"
          ? {
              messages: history,
              sessionID: input.sessionID,
              user: userMessage,
              model: remoteModel,
            }
          : undefined
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (processor.message.error) return "stop"
      const remoteState =
        remoteInput && result === "continue"
          ? yield* remote(remoteInput).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed({
                      status: "fallback" as const,
                      reason: "internal_error" as const,
                      statusCode: undefined,
                      time: Date.now(),
                    }),
              ),
            )
          : undefined

      if (
        compactionPart &&
        (remoteState || (selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id))
      ) {
        yield* session.updatePart({
          ...compactionPart,
          ...(remoteState ? { openai: remoteState } : {}),
          ...(selected.tail_start_id ? { tail_start_id: selected.tail_start_id } : {}),
        })
        if (remoteState?.status === "fallback") {
          yield* Effect.logWarning("OpenAI remote compaction fell back to local summary", {
            "session.id": input.sessionID,
            reason: remoteState.reason,
            statusCode: remoteState.statusCode,
          })
        }
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Auth.node,
    llmClient,
  ],
})

export * as SessionCompaction from "./compaction"
