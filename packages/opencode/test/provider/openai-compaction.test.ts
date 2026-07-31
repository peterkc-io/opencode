import { describe, expect, test } from "bun:test"
import { OpenAICompaction } from "@/provider/openai-compaction"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Auth } from "@/auth"
import { ProviderTest } from "../fake/provider"

const canonical = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "older" }] },
  { id: "cmp_1", type: "compaction", encrypted_content: "encrypted" },
]

const state = {
  status: "success",
  responseID: "resp_1",
  providerID: ProviderV2.ID.make("openai"),
  modelID: ModelV2.ID.make("gpt-5.6"),
  apiModelID: "gpt-5.6",
  baseURL: "https://api.openai.com/v1",
  authType: "api",
  credentialSalt: "salt",
  credentialFingerprint: "fingerprint",
  output: canonical,
  time: 1,
} as SessionV1.OpenAICompactionSuccess

const input = [
  { role: "developer", content: "current instructions" },
  { role: "user", content: [{ type: "input_text", text: OpenAICompaction.COMPACTION_PROMPT }] },
  { role: "assistant", content: [{ type: "output_text", text: "local summary" }] },
  { role: "user", content: [{ type: "input_text", text: "next" }] },
]

describe("OpenAICompaction", () => {
  test("accepts exactly one encrypted compaction item", () => {
    expect(OpenAICompaction.output(canonical)).toEqual(canonical)
    expect(OpenAICompaction.output([])).toBeUndefined()
    expect(OpenAICompaction.output([{ type: "compaction", encrypted_content: "" }])).toBeUndefined()
    expect(OpenAICompaction.output([{ type: "compaction_summary", encrypted_content: "encrypted" }])).toEqual([
      { type: "compaction", encrypted_content: "encrypted" },
    ])
    expect(OpenAICompaction.output([...canonical, canonical[1]])).toBeUndefined()
    expect(OpenAICompaction.response({ id: "resp_1", output: canonical })).toEqual({
      id: "resp_1",
      output: canonical,
    })
    expect(OpenAICompaction.response({ id: "", output: canonical })).toBeUndefined()
  })

  test("replaces the local boundary and preserves current instructions", () => {
    expect(OpenAICompaction.replayInput(input, { state, summary: "local summary", oauth: false })).toEqual([
      input[0],
      ...canonical,
      input[3],
    ])
    expect(OpenAICompaction.replayInput(input, { state, summary: "different", oauth: false })).toBeUndefined()
  })

  test("normalizes summary chunks and refuses a later matching pair", () => {
    const chunks = [
      input[0],
      { role: "user", content: [{ type: "input_text", text: OpenAICompaction.COMPACTION_PROMPT }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "local " },
          { type: "output_text", text: "summary\n" },
        ],
      },
      input[3],
    ]
    expect(OpenAICompaction.replayInput(chunks, { state, summary: "local summary", oauth: false })).toEqual([
      input[0],
      ...canonical,
      input[3],
    ])
    expect(
      OpenAICompaction.replayInput([{ role: "user", content: "before" }, ...chunks.slice(1)], {
        state,
        summary: "local summary",
        oauth: false,
      }),
    ).toBeUndefined()
  })

  test("uses scoped replay state across retries and strips the token", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    const base: OpenAICompaction.FetchLike = async (_request, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(init.body),
      })
      return new Response("{}")
    }
    const token = OpenAICompaction.register({ state, summary: "local summary", oauth: true })
    const wrapped = OpenAICompaction.wrapFetch(base)
    const request = () =>
      wrapped("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [OpenAICompaction.TOKEN_HEADER]: token },
        body: JSON.stringify({ model: "gpt-5.6", input }),
      })

    await request()
    await request()

    expect(requests).toHaveLength(2)
    for (const item of requests) {
      expect(item.headers.has(OpenAICompaction.TOKEN_HEADER)).toBe(false)
      expect(item.headers.get(OpenAICompaction.HTTP_HEADER)).toBe("true")
      expect(item.body.input).toEqual([input[0], ...canonical, input[3]])
    }
    expect(OpenAICompaction.release(token)).toBeUndefined()
  })

  test("keeps the local summary when the boundary cannot be found", async () => {
    let captured: RequestInit | undefined
    const token = OpenAICompaction.register({ state, summary: "missing", oauth: false })
    const wrapped = OpenAICompaction.wrapFetch(async (_request, init) => {
      captured = init
      return new Response("{}")
    })

    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { [OpenAICompaction.TOKEN_HEADER]: token },
      body: JSON.stringify({ model: "gpt-5.6", input }),
    })

    expect(new Headers(captured?.headers).has(OpenAICompaction.TOKEN_HEADER)).toBe(false)
    if (typeof captured?.body !== "string") throw new Error("Expected JSON request body")
    expect(JSON.parse(captured.body).input).toEqual(input)
    expect(OpenAICompaction.release(token)).toBe("boundary_not_found")
  })

  test("refuses replay after a model or credential binding change", () => {
    const model = ProviderTest.model({
      id: ModelV2.ID.make("gpt-5.6"),
      providerID: ProviderV2.ID.make("openai"),
      api: { id: "gpt-5.6", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    })
    const provider = ProviderTest.info({ key: "sk-test" }, model)
    const auth: Auth.Info = { type: "api", key: "sk-test" }
    const bound = {
      ...state,
      credentialFingerprint: OpenAICompaction.credentialFingerprint(provider, auth, state.credentialSalt)!,
    }
    const changedAuth: Auth.Info = { type: "api", key: "sk-different" }
    expect(
      OpenAICompaction.matches({
        state: bound,
        model,
        provider,
        auth,
      }),
    ).toBe(true)
    expect(
      OpenAICompaction.matches({
        state: bound,
        model: { ...model, id: ModelV2.ID.make("gpt-5.7") },
        provider,
        auth,
      }),
    ).toBe(false)
    expect(
      OpenAICompaction.matches({
        state: bound,
        model,
        provider,
        auth: changedAuth,
      }),
    ).toBe(false)
    expect(OpenAICompaction.credentialFingerprint(provider, auth, "other-salt")).not.toBe(bound.credentialFingerprint)
    const defaultModel = structuredClone(model)
    Reflect.deleteProperty(defaultModel.api, "url")
    expect(OpenAICompaction.matches({ state: bound, model: defaultModel, provider, auth })).toBe(true)
    expect(
      OpenAICompaction.matches({
        state: { ...bound, baseURL: "https://proxy.example/v1" },
        model: defaultModel,
        provider,
        auth,
      }),
    ).toBe(false)
  })
})
