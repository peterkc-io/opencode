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
} satisfies SessionV1.OpenAICompactionSuccess

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

  test("preserves replay failures across retries and strips the token", async () => {
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
    const request = (bodyInput: unknown, contentLength?: string) =>
      wrapped("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          [OpenAICompaction.TOKEN_HEADER]: token,
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
        body: JSON.stringify({ model: "gpt-5.6", input: bodyInput }),
      })

    const missing = [{ role: "user", content: "unrelated" }]
    await request(missing)
    await request(input, "999")

    expect(requests).toHaveLength(2)
    expect(requests[0]?.headers.has(OpenAICompaction.TOKEN_HEADER)).toBe(false)
    expect(requests[0]?.body.input).toEqual(missing)
    expect(requests[1]?.headers.get(OpenAICompaction.HTTP_HEADER)).toBe("true")
    expect(requests[1]?.headers.has("content-length")).toBe(false)
    expect(requests[1]?.body.input).toEqual([input[0], ...canonical, input[3]])
    expect(OpenAICompaction.release(token)).toBe("boundary_not_found")
  })

  test("expires replay state at lookup time", async () => {
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
      let captured: RequestInit | undefined
      const abandoned = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      now += 5 * 60 * 1000 + 1
      const token = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      expect(OpenAICompaction.release(abandoned)).toBe("expired")
      const wrapped = OpenAICompaction.wrapFetch(async (_request, init) => {
        captured = init
        return new Response("{}")
      })
      now += 5 * 60 * 1000 + 1

      await wrapped("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [OpenAICompaction.TOKEN_HEADER]: token },
        body: JSON.stringify({ model: "gpt-5.6", input }),
      })

      if (typeof captured?.body !== "string") throw new Error("Expected original request body")
      expect(JSON.parse(captured.body).input).toEqual(input)
      expect(OpenAICompaction.release(token)).toBe("expired")

      const direct = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      now += 5 * 60 * 1000 + 1
      expect(OpenAICompaction.release(direct)).toBe("expired")

      const tombstone = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      now += 5 * 60 * 1000 + 1
      const trigger = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      now += 60 * 60 * 1000 + 1
      const cleanup = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      expect(OpenAICompaction.release(tombstone)).toBeUndefined()
      expect(OpenAICompaction.release(trigger)).toBe("expired")
      expect(OpenAICompaction.release(cleanup)).toBeUndefined()
    } finally {
      Date.now = originalNow
    }
  })

  test("reports invalid replay requests and builds compact requests", async () => {
    const token = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
    const wrapped = OpenAICompaction.wrapFetch(async () => new Response("{}"))
    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { [OpenAICompaction.TOKEN_HEADER]: token },
      body: JSON.stringify({ model: "gpt-5.5", input }),
    })
    expect(OpenAICompaction.release(token)).toBe("invalid_request")

    for (const [url, method] of [
      ["https://api.openai.com/v1/chat/completions", "POST"],
      ["https://api.openai.com/v1/responses", "GET"],
    ]) {
      const skipped = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
      await wrapped(url, {
        method,
        headers: { [OpenAICompaction.TOKEN_HEADER]: skipped },
        body: JSON.stringify({ model: "gpt-5.6", input }),
      })
      expect(OpenAICompaction.release(skipped)).toBe("invalid_request")
    }

    expect(OpenAICompaction.compactURL("https://api.openai.com/v1/responses/")?.pathname).toBe("/v1/responses/compact")
    expect(OpenAICompaction.compactURL("https://api.openai.com/v1/chat/completions")).toBeUndefined()
    expect(OpenAICompaction.compactURL("not a URL")).toBeUndefined()
    expect(OpenAICompaction.compactBody({ model: "gpt-5.6", input, stream: true, tools: [] })).toEqual({
      model: "gpt-5.6",
      input,
      tools: [],
    })
    expect(OpenAICompaction.compactBody({ model: "gpt-5.6", input: [] })).toBeUndefined()
  })

  test("rewrites Request inputs and validates configured fetch helpers", async () => {
    let captured: RequestInit | undefined
    const token = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
    const wrapped = OpenAICompaction.wrapFetch(async (_input, init) => {
      captured = init
      return new Response("{}")
    })
    await wrapped(
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [OpenAICompaction.TOKEN_HEADER]: token },
        body: JSON.stringify({ model: "gpt-5.6", input }),
      }),
    )
    if (typeof captured?.body !== "string") throw new Error("Expected rewritten request body")
    expect(JSON.parse(captured.body).input).toEqual([input[0], ...canonical, input[3]])
    expect(OpenAICompaction.release(token)).toBeUndefined()

    const binaryToken = OpenAICompaction.register({ state, summary: "local summary", oauth: false })
    const binary = new Uint8Array([1, 2, 3])
    let forwardedBody: BodyInit | null | undefined
    const binaryWrapped = OpenAICompaction.wrapFetch(async (_input, init) => {
      forwardedBody = init?.body
      return new Response("{}")
    })
    await binaryWrapped(
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6", input }),
      }),
      {
        method: "POST",
        headers: { [OpenAICompaction.TOKEN_HEADER]: binaryToken },
        body: binary,
      },
    )
    expect(forwardedBody).toBe(binary)
    expect(OpenAICompaction.release(binaryToken)).toBe("invalid_request")

    expect(OpenAICompaction.headers({ authorization: "Bearer test", ignored: 1 })).toEqual({
      authorization: "Bearer test",
    })
    expect(OpenAICompaction.fetcher(undefined)).toBeUndefined()
    const valid = OpenAICompaction.fetcher(async () => new Response("ok"))
    const invalid = OpenAICompaction.fetcher(async () => ({}))
    if (!valid || !invalid) throw new Error("Expected configured fetch wrappers")
    expect(await valid("https://api.openai.com/v1/responses")).toBeInstanceOf(Response)
    await expect(invalid("https://api.openai.com/v1/responses")).rejects.toThrow(
      "Configured OpenAI fetch did not return a Response",
    )
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
    const baseURL = state.baseURL
    const bound = {
      ...state,
      credentialFingerprint: OpenAICompaction.credentialFingerprint(provider, auth, state.credentialSalt)!,
    }
    const changedAuth: Auth.Info = { type: "api", key: "sk-different" }
    const oauth: Auth.Info = {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
      accountId: "account",
    }
    const oauthState = {
      ...bound,
      authType: "oauth" as const,
      credentialFingerprint: OpenAICompaction.credentialFingerprint(provider, oauth, state.credentialSalt)!,
    }
    expect(
      OpenAICompaction.matches({
        state: bound,
        model,
        provider,
        auth,
        baseURL,
      }),
    ).toBe(true)
    expect(OpenAICompaction.matches({ state: oauthState, model, provider, auth: oauth, baseURL })).toBe(true)
    expect(
      OpenAICompaction.matches({
        state: bound,
        model: { ...model, id: ModelV2.ID.make("gpt-5.7") },
        provider,
        auth,
        baseURL,
      }),
    ).toBe(false)
    expect(
      OpenAICompaction.matches({
        state: bound,
        model,
        provider,
        auth: changedAuth,
        baseURL,
      }),
    ).toBe(false)
    expect(
      OpenAICompaction.matches({
        state: bound,
        model,
        provider: ProviderTest.info({}, model),
        auth: undefined,
        baseURL,
      }),
    ).toBe(false)
    expect(OpenAICompaction.credentialFingerprint(provider, auth, "other-salt")).not.toBe(bound.credentialFingerprint)
    const defaultBaseURL = OpenAICompaction.baseURL(undefined)
    expect(defaultBaseURL).toBe(OpenAICompaction.DEFAULT_BASE_URL)
    expect(OpenAICompaction.matches({ state: bound, model, provider, auth, baseURL: defaultBaseURL })).toBe(true)
    const compatibleModel = structuredClone(model)
    compatibleModel.api.npm = "@ai-sdk/openai-compatible"
    expect(OpenAICompaction.matches({ state: bound, model: compatibleModel, provider, auth, baseURL })).toBe(false)
    expect(
      OpenAICompaction.matches({
        state: { ...bound, baseURL: "https://proxy.example/v1" },
        model,
        provider,
        auth,
        baseURL,
      }),
    ).toBe(false)
    expect(
      OpenAICompaction.matches({
        state: { ...bound, output: [{ type: "compaction", encrypted_content: "" }] },
        model,
        provider,
        auth,
        baseURL,
      }),
    ).toBe(false)
    const oauthWithoutAccount: Auth.Info = {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    }
    expect(OpenAICompaction.credentialFingerprint(provider, oauthWithoutAccount, state.credentialSalt)).toBeUndefined()
    expect(OpenAICompaction.matches({ state: oauthState, model, provider, auth: oauthWithoutAccount, baseURL })).toBe(
      false,
    )
  })
})
