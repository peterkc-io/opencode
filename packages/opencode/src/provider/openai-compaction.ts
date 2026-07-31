import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "./provider"
import type { Auth } from "@/auth"

export const TOKEN_HEADER = "x-opencode-compaction-token"
export const HTTP_HEADER = "x-opencode-http"
export const COMPACTION_PROMPT = "What did we do so far?"
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"

type JsonObject = Record<string, unknown>
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type Replay = {
  state: SessionV1.OpenAICompactionSuccess
  summary: string
  oauth: boolean
}

type ActiveReplay = Replay & {
  registeredAt: number
  failure?: "invalid_request" | "boundary_not_found"
}

const active = new Map<string, ActiveReplay>()
const MAX_ACTIVE_AGE_MS = 5 * 60 * 1000

function sweep() {
  const cutoff = Date.now() - MAX_ACTIVE_AGE_MS
  for (const [token, replay] of active) {
    if (replay.registeredAt < cutoff) active.delete(token)
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item]
      const value = record(item)?.text
      return typeof value === "string" ? [value] : []
    })
    .join("")
}

export function summaryText(value: unknown) {
  return text(value).trim()
}

function role(item: unknown) {
  const value = record(item)?.role
  return typeof value === "string" ? value : undefined
}

function content(item: unknown) {
  return text(record(item)?.content)
}

function isCompaction(value: unknown): value is JsonObject & { type: "compaction"; encrypted_content: string } {
  const item = record(value)
  return item?.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
}

export function output(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map((value) => {
    const item = record(value)
    if (item?.type !== "compaction_summary") return item
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) return undefined
    return { ...item, type: "compaction" }
  })
  if (!items.every(isRecord)) return undefined
  if (items.filter(isCompaction).length !== 1) return undefined
  return items
}

export function response(value: unknown) {
  const item = record(value)
  const id = item?.id
  const items = output(item?.output)
  if (typeof id !== "string" || id.length === 0 || !items) return undefined
  return { id, output: items }
}

export function compactBody(value: unknown) {
  const body = record(value)
  if (typeof body?.model !== "string" || !Array.isArray(body.input) || body.input.length === 0) return undefined
  const result: JsonObject = { model: body.model, input: body.input }
  for (const key of [
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "service_tier",
    "prompt_cache_key",
    "text",
  ]) {
    if (body[key] !== undefined) result[key] = body[key]
  }
  return result
}

export function compactURL(value: string) {
  const url = new URL(value)
  const path = url.pathname.replace(/\/+$/, "")
  if (!path.endsWith("/responses")) return undefined
  url.pathname = `${path}/compact`
  return url
}

export function baseURL(provider: Provider.Info, model: Provider.Model) {
  return String(provider.options.baseURL ?? model.api.url ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

function boundary(input: unknown[], summary: string) {
  let start = 0
  while (start < input.length) {
    const next = role(input[start])
    if (next !== "system" && next !== "developer") break
    start++
  }
  if (role(input[start]) !== "user" || summaryText(content(input[start])) !== COMPACTION_PROMPT) return undefined
  const chunks: string[] = []
  for (let end = start + 1; end < input.length && role(input[end]) === "assistant"; end++) {
    chunks.push(content(input[end]))
    if (summaryText(chunks) === summary) return { start, end: end + 1 }
  }
  return undefined
}

export function replayInput(input: unknown, replay: Replay) {
  if (!Array.isArray(input)) return undefined
  const found = boundary(input, replay.summary)
  if (!found) return undefined
  return [...input.slice(0, found.start), ...structuredClone(replay.state.output), ...input.slice(found.end)]
}

export function register(replay: Replay) {
  sweep()
  const token = crypto.randomUUID()
  active.set(token, { ...replay, registeredAt: Date.now() })
  return token
}

export function release(token: string) {
  const item = active.get(token)
  active.delete(token)
  return item?.failure
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

function requestURL(input: RequestInfo | URL) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(input.toString())
  } catch {
    return undefined
  }
}

function requestBody(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body
  if (input instanceof Request) return input.clone().text()
  return Promise.resolve(undefined)
}

export function wrapFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const headers = requestHeaders(input, init)
    const token = headers.get(TOKEN_HEADER)
    headers.delete(TOKEN_HEADER)
    headers.delete(HTTP_HEADER)
    if (!token) return base(input, { ...init, headers })

    const replay = active.get(token)
    const url = requestURL(input)
    const method = init?.method ?? (input instanceof Request ? input.method : undefined)
    if (!replay) return base(input, { ...init, headers })
    if (!url || method !== "POST" || !url.pathname.replace(/\/+$/, "").endsWith("/responses")) {
      replay.failure = "invalid_request"
      return base(input, { ...init, headers })
    }

    const body = await requestBody(input, init)
    let parsed: JsonObject | undefined
    try {
      parsed = record(body ? JSON.parse(body) : undefined)
    } catch {}
    if (!parsed || parsed.model !== replay.state.apiModelID) {
      replay.failure = "invalid_request"
      return base(input, { ...init, headers })
    }

    const rewritten = replayInput(parsed.input, replay)
    if (!rewritten) {
      replay.failure = "boundary_not_found"
      return base(input, { ...init, headers })
    }

    if (replay.oauth) headers.set(HTTP_HEADER, "true")
    replay.failure = undefined
    headers.delete("content-length")
    return base(input, {
      ...init,
      headers,
      body: JSON.stringify({ ...parsed, input: rewritten }),
    })
  }
}

export function matches(input: {
  state: SessionV1.OpenAICompactionSuccess
  model: Provider.Model
  provider: Provider.Info
  auth: Auth.Info | undefined
}) {
  const authType = input.auth?.type === "oauth" ? "oauth" : "api"
  const currentBaseURL = baseURL(input.provider, input.model)
  const fingerprint = credentialFingerprint(input.provider, input.auth, input.state.credentialSalt)
  return (
    input.model.providerID === "openai" &&
    input.model.api.npm === "@ai-sdk/openai" &&
    input.state.providerID === input.model.providerID &&
    input.state.modelID === input.model.id &&
    input.state.apiModelID === input.model.api.id &&
    input.state.baseURL === currentBaseURL &&
    input.state.authType === authType &&
    fingerprint !== undefined &&
    input.state.credentialFingerprint === fingerprint &&
    output(input.state.output) !== undefined
  )
}

export function credentialFingerprint(provider: Provider.Info, auth: Auth.Info | undefined, salt: string) {
  const value =
    auth?.type === "oauth"
      ? auth.accountId
      : auth?.type === "api" || auth?.type === "wellknown"
        ? auth.key
        : apiKey(provider, auth)
  if (!value) return undefined
  return new Bun.CryptoHasher("sha256").update(`${salt}:${auth?.type ?? "provider"}:${value}`).digest("hex")
}

export function apiKey(provider: Provider.Info, auth: Auth.Info | undefined) {
  if (auth?.type === "api" || auth?.type === "wellknown") return auth.key
  if (typeof provider.options.apiKey === "string") return provider.options.apiKey
  return provider.key
}

export function headers(value: unknown) {
  const item = record(value)
  if (!item) return {}
  return Object.fromEntries(
    Object.entries(item).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

export function fetcher(value: unknown): FetchLike | undefined {
  if (typeof value !== "function") return undefined
  return async (input, init) => {
    const response = await Promise.resolve(Reflect.apply(value, undefined, [input, init]))
    if (!(response instanceof Response)) throw new Error("Configured OpenAI fetch did not return a Response")
    return response
  }
}

export * as OpenAICompaction from "./openai-compaction"
