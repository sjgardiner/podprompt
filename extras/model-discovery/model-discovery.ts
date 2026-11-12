// Model discovery for OpenAI-compatible providers.
//
// WHAT IT IS FOR. A provider declared in opencode.jsonc with no `models` block
// contributes nothing at all — OpenCode drops it. Hand-listing model ids works
// but goes stale silently: the list only changes when you remember to change
// it, so a model added upstream is invisible and a model withdrawn upstream
// stays in the picker until it fails. This asks each provider what it serves
// and registers the answer.
//
// HOW IT REGISTERS. One call, measured against OpenCode 2.2.7:
//
//     ctx.model.transform(editor => editor.update(providerID, modelID, m => {...}))
//
// `update` UPSERTS, which is the part that makes this possible at all.
//
// Two things about that are worth knowing before changing any of it:
//
//   * THE TRANSFORM MUST BE PURE. It runs on every catalog resolution, several
//     times per startup. Doing I/O inside it, or mutating anything that
//     triggers a reload, re-enters immediately and wedges the server — the
//     provider-side equivalent (`provider.transform` + `add`) does exactly
//     that and had to be abandoned. So discovery happens OUTSIDE, writes a
//     cache, and asks for one reload; the transform only ever reads.
//
//   * ONLY PROVIDERS ALREADY IN opencode.jsonc CAN BE FILLED. `update` on a
//     provider the config has never heard of is accepted and silently does
//     nothing (measured). Each endpoint therefore needs its own provider block
//     — baseURL and apiKey, no models. That block is written once; what it
//     serves is discovered from then on.

const DEFAULT_CONTEXT = 32768
const DEFAULT_OUTPUT = 8192
const DEFAULT_INTERVAL_SECONDS = 600
const MIN_INTERVAL_SECONDS = 30
const FETCH_TIMEOUT_MS = 15000
const LOG = "[model-discovery]"

type Shape = "openai" | "alcf" | "litellm-info"

type Override = {
  // Absolute, or relative to the provider's baseURL. Needed when the model
  // list does not live at {baseURL}/models — ALCF publishes it outside the
  // OpenAI-compatible path entirely.
  endpoint?: string
  shape?: Shape
  enabled?: boolean
}

type Target = {
  providerID: string
  url: string
  apiKey?: string
  shape?: Shape
}

type Model = {
  id: string
  name: string
  context: number
  output: number
  tools?: boolean
  input?: string[]
}

// providerID -> last good result. Retained across failures on purpose: a
// provider that blips offline should not empty your model picker, and the
// stale entry is strictly better than nothing until it answers again.
const catalog = new Map<string, Model[]>()

// A slow poll must never commit over a newer one. Every refresh takes a ticket
// and throws its result away if another refresh started meanwhile.
let generation = 0

// ── config ────────────────────────────────────────────────────────────────
// Read from disk rather than from the plugin context: OpenCode 2 exposes no
// config hook, and the provider editors cannot see config-declared providers
// at all (measured) — so the file is the only place the provider list is.

export function stripJsonc(src: string): string {
  // Comment-stripping that respects strings, because a baseURL containing
  // "//" is the common case here, not an edge case.
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (inLine) { if (c === "\n") { inLine = false; out += c } ; continue }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++ } ; continue }
    if (inString) {
      out += c
      if (c === "\\") { out += next ?? ""; i++ ; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === "/" && next === "/") { inLine = true; i++; continue }
    if (c === "/" && next === "*") { inBlock = true; i++; continue }
    out += c
  }
  // Trailing commas are legal in jsonc and fatal in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function readJsonish(path: string): any {
  try {
    const fs = require("node:fs")
    if (!fs.existsSync(path)) return undefined
    return JSON.parse(stripJsonc(fs.readFileSync(path, "utf8")))
  } catch (e: any) {
    console.warn(`${LOG} could not read ${path}: ${e?.message ?? e}`)
    return undefined
  }
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const home = process.env.HOME ?? ""
  return xdg ? `${xdg}/opencode` : `${home}/.config/opencode`
}

// EVERY source, merged — not the first one that parses.
//
// OPENCODE_CONFIG does not REPLACE the config directory's file, it merges with
// it, and a host that sets it may well put something else entirely in there.
// PodPrompt does exactly that: it points OPENCODE_CONFIG at a generated file
// carrying only permission rules and an instructions path. Reading that and
// stopping finds no providers at all, so discovery silently did nothing for
// every PodPrompt-launched session — which is how this was found.
//
// Later sources win per provider id, matching how OpenCode layers them.
function collectProviders(): Record<string, any> {
  const dir = configDir()
  const sources = [
    `${dir}/opencode.json`,
    `${dir}/opencode.jsonc`,
    process.env.OPENCODE_CONFIG,
  ].filter((p): p is string => typeof p === "string" && p.length > 0)

  const merged: Record<string, any> = {}
  for (const path of sources) {
    const cfg = readJsonish(path)
    if (!cfg) continue
    // 2.x normalises `provider` to `providers`; a file on disk may use either.
    const providers = cfg.providers ?? cfg.provider
    if (!providers || typeof providers !== "object") continue
    for (const [id, provider] of Object.entries<any>(providers)) merged[id] = provider
  }
  return merged
}

function loadOverrides(): { intervalSeconds?: number; providers?: Record<string, Override> } {
  // Kept in its OWN file rather than inside opencode.jsonc: unknown keys in
  // that file are OpenCode's to validate, and this plugin should not be able
  // to make the user's config fail to load.
  return readJsonish(`${configDir()}/model-discovery.json`) ?? {}
}

// `{env:VAR}` is opencode.jsonc's own interpolation syntax; a provider key is
// usually written that way rather than inline.
export function interpolate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim())
  if (m) return process.env[m[1]]
  return value
}

export function joinUrl(baseURL: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  const base = baseURL.replace(/\/+$/, "")
  return `${base}/${endpoint.replace(/^\/+/, "")}`
}

export function resolveTargets(): Target[] {
  const providers = collectProviders()
  const overrides = loadOverrides().providers ?? {}
  const targets: Target[] = []

  for (const [providerID, provider] of Object.entries<any>(providers)) {
    if (!provider || typeof provider !== "object") continue
    const over = overrides[providerID] ?? {}
    if (over.enabled === false) continue

    const settings = provider.settings ?? provider.options ?? {}
    const baseURL = typeof settings.baseURL === "string" ? settings.baseURL : undefined
    const pkg = String(provider.package ?? provider.npm ?? "")

    // Auto-detect the openai-compatible ones; an explicit override opts in
    // anything else.
    const looksCompatible = pkg.includes("openai-compatible") || (baseURL?.includes("/v1") ?? false)
    if (!looksCompatible && over.endpoint === undefined && over.enabled !== true) continue
    if (!baseURL && over.endpoint === undefined) continue

    const endpoint = over.endpoint ?? "models"
    const url = baseURL ? joinUrl(baseURL, endpoint) : endpoint
    if (!/^https?:\/\//i.test(url)) {
      console.warn(`${LOG} skipping "${providerID}": no usable URL (${url})`)
      continue
    }
    targets.push({ providerID, url, apiKey: interpolate(settings.apiKey), shape: over.shape })
  }
  return targets
}

// ── parsing ───────────────────────────────────────────────────────────────
// Three upstreams, three shapes. Sniffed when not declared, because the shape
// is a property of the server rather than something worth configuring twice.

export function sniff(body: any): Shape {
  if (Array.isArray(body)) return "alcf"
  const first = Array.isArray(body?.data) ? body.data[0] : undefined
  if (first && typeof first.model_name === "string") return "litellm-info"
  return "openai"
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
  return undefined
}

export function parseModels(body: any, shape: Shape): Model[] {
  const out: Model[] = []

  if (shape === "alcf") {
    // A bare top-level array, with the richest metadata of the three.
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
    for (const m of list) {
      if (!m || typeof m.id !== "string" || !m.id) continue
      const caps = m.capabilities ?? {}
      out.push({
        id: m.id,
        name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
        context: num(caps.context_window_tokens) ?? DEFAULT_CONTEXT,
        output: num(caps.max_output_tokens) ?? DEFAULT_OUTPUT,
        tools: caps.tool_calling?.supported === true,
        input: Array.isArray(caps.input_modalities) ? caps.input_modalities : undefined,
      })
    }
    return out
  }

  if (shape === "litellm-info") {
    // LiteLLM's /model/info keys each row on `model_name`, not `id` — which is
    // why a parser written for /v1/models finds the list and then skips every
    // row in it.
    for (const m of Array.isArray(body?.data) ? body.data : []) {
      const id = typeof m?.model_name === "string" ? m.model_name : undefined
      if (!id) continue
      const info = m.model_info ?? {}
      out.push({
        id,
        name: id,
        context: num(info.max_input_tokens, info.max_tokens) ?? DEFAULT_CONTEXT,
        output: num(info.max_output_tokens) ?? DEFAULT_OUTPUT,
        tools: info.supports_function_calling === true,
        input: info.supports_vision === true ? ["text", "image"] : undefined,
      })
    }
    return out
  }

  // Plain OpenAI: llama.cpp carries its window in `meta.n_ctx`; most others
  // carry nothing and fall back to the defaults.
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    if (!m || typeof m.id !== "string" || !m.id) continue
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      context: num(m.meta?.n_ctx, m.context_length, m.max_input_tokens) ?? DEFAULT_CONTEXT,
      output: num(m.max_output_tokens) ?? DEFAULT_OUTPUT,
    })
  }
  return out
}

// ── discovery ─────────────────────────────────────────────────────────────

async function poll(target: Target): Promise<Model[] | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`
  const res = await fetch(target.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  const shape = target.shape ?? sniff(body)
  const models = parseModels(body, shape)
  if (!models.length) throw new Error(`no models parsed (shape "${shape}")`)
  return models
}

async function refresh(ctx: any): Promise<void> {
  const mine = ++generation
  const targets = resolveTargets()
  if (!targets.length) return

  let changed = false
  await Promise.all(targets.map(async (t) => {
    try {
      const models = await poll(t)
      if (mine !== generation) return      // a newer refresh owns the catalog
      if (!models) return
      const before = catalog.get(t.providerID)
      if (JSON.stringify(before) !== JSON.stringify(models)) changed = true
      catalog.set(t.providerID, models)
      console.info(`${LOG} ${t.providerID}: ${models.length} model(s) from ${t.url}`)
    } catch (e: any) {
      // Quiet failure is the point: an endpoint that is down should cost you
      // that provider, not the others, and not the models it served last time.
      const kept = catalog.get(t.providerID)?.length
      console.warn(`${LOG} ${t.providerID}: ${e?.message ?? e} (${t.url})`
        + (kept ? ` — keeping ${kept} model(s) from the last good poll` : ""))
    }
  }))

  if (mine !== generation) return
  // Only when something actually moved: reload re-runs every transform, and
  // asking for one on an unchanged catalog is pure churn.
  if (changed) { try { await ctx.model?.reload?.() } catch { /* best effort */ } }
}

// ── plugin ────────────────────────────────────────────────────────────────

export default {
  id: "model-discovery",

  async setup(ctx: any) {
    if (typeof ctx?.model?.transform !== "function") {
      console.warn(`${LOG} this OpenCode has no ctx.model.transform; discovery is inert.`)
      return
    }

    // PURE. Reads the cache, writes models, does nothing else. See the header.
    await ctx.model.transform((editor: any) => {
      for (const [providerID, models] of catalog) {
        for (const m of models) {
          try {
            editor.update(providerID, m.id, (model: any) => {
              model.name = m.name
              model.limit = { context: m.context, output: m.output }
              if (m.tools !== undefined || m.input !== undefined) {
                model.capabilities = {
                  ...(model.capabilities ?? {}),
                  ...(m.tools !== undefined ? { tools: m.tools } : {}),
                  ...(m.input !== undefined ? { input: m.input } : {}),
                }
              }
            })
          } catch (e: any) {
            console.warn(`${LOG} could not register ${providerID}/${m.id}: ${e?.message ?? e}`)
          }
        }
      }
    })

    // First pass now, then on a timer. Deliberately not awaited: a slow or
    // unreachable endpoint must not hold up the session that triggered this.
    refresh(ctx).catch((e) => console.warn(`${LOG} initial refresh failed: ${e?.message ?? e}`))

    const configured = loadOverrides().intervalSeconds
    const seconds = Math.max(MIN_INTERVAL_SECONDS,
      typeof configured === "number" && configured > 0 ? configured : DEFAULT_INTERVAL_SECONDS)
    const timer = setInterval(() => {
      refresh(ctx).catch((e) => console.warn(`${LOG} refresh failed: ${e?.message ?? e}`))
    }, seconds * 1000)
    timer.unref?.()
  },
}
