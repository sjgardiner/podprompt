// PodPrompt's OpenCode plugin: the second of the two shims over one
// implementation.
//
// Claude Code gets the same tools through an in-process SDK MCP server built
// per turn. OpenCode runs in its own process (`opencode2 serve`, spawned and
// supervised by driver.mjs), so this reaches the identical driver functions
// over HTTP instead. Deliberately thin: it contributes identity and nothing
// else. Every decision — resolution, authorization, budgets, parking — lives
// in driver.mjs, because two implementations of the same four tools is
// exactly the drift this project keeps getting bitten by.
//
// Why a plugin rather than an MCP server: a plugin can register tools
// directly, and the tool handler's second argument is supplied by OpenCode's
// own runtime. That last part is the whole security argument — the model
// passes only its declared arguments, and who is calling arrives alongside,
// out of its reach. A `from` the model could assert would make every
// downstream trust rule decorative. Verified against 2.2.7: `execute(input,
// ctx)` receives ctx.sessionID, ctx.agent, ctx.messageID and an AbortSignal.
//
// ── written for the v2 plugin API ──────────────────────────────────────────
// v2 rewrote this API and refuses a v1 plugin outright ("Plugin must export a
// default definition with an id and an effect or setup function"), which left
// v2 sessions with no messaging tools at all. The differences that matter:
//
//   v1                                  v2
//   export default (async () => ({…}))  export default { id, setup(ctx) }
//   return { tool: { name: tool({…}) } } ctx.tool.transform(e => e.add({…}))
//   args: { x: tool.schema.string() }   input: { JSON Schema }
//   context.ask({permission, patterns}) ctx.permission.assert({sessionID,
//                                         action, resources})
//
// Deliberately NO `@opencode/plugin` import. The documented `Plugin.define()`
// helper is a typing convenience, and a plain object loads identically — so
// this file has no npm dependency and the config directory needs no
// node_modules installed into it.
//
// One thing this file CANNOT do: make an action prompt for permission.
// `assert` only asks if a config rule says to, and a plugin cannot install
// one (ctx.agent.transform accepts the edit and drops it; ctx.permission.hook
// never fires for assert — both measured). driver.mjs therefore ships a
// config document declaring `podprompt-message` and `podprompt-delegate` as
// "ask". If that document is missing, these tools still work — they just stop
// asking, which is why the driver logs loudly when it cannot write it.

// Injected by driver.mjs when it spawns `opencode2 serve`. The token is
// minted per driver start and never written to disk, so it rotates on every
// restart. It identifies this plugin as a local-realm caller; see PD10 for
// why the driver's routes need that at all.
const DRIVER_URL = process.env.PODPROMPT_DRIVER_URL || "http://127.0.0.1:7844"
const TOKEN = process.env.PODPROMPT_TOKEN || ""

type Receipt = {
  ok: boolean
  reason?: string
  delivered?: boolean
  queued?: boolean
  parked?: boolean
  remaining?: number | null
  describe?: string
  cap?: number
}

async function driverFetch(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TOKEN) headers["X-PodPrompt-Token"] = TOKEN
  const res = await fetch(`${DRIVER_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { error: text } }
  return { status: res.status, body }
}

// A v2 tool returns structured content. The driver already renders every
// outcome as prose, so there is exactly one shape here and the title/metadata
// that v1 returned are dropped rather than faked: nothing downstream reads
// them on v2, because driver.mjs knows the parent/child pairing from its own
// /delegate call and never needed to recover it off a tool part.
const say = (text: string) => ({ content: text })

// Asks the user, via PodPrompt's own approval card, before an action that
// reaches outside this session. Parity with Claude Code, where an MCP tool
// call goes through canUseTool and so raises a card — otherwise the same
// action would be challenged on one backend and silent on the other.
//
// Resolves when allowed (including auto-approve), throws when declined.
async function gate(ctx: any, sessionID: string, action: string, resource: string) {
  await ctx.permission.assert({ sessionID, action, resources: [resource] })
}

export default {
  id: "podprompt",

  async setup(ctx: any) {
    // Inert unless driver.mjs spawned this `opencode2 serve`. The plugin lives
    // in OpenCode's global plugin directory because that is the only location
    // OpenCode actually auto-discovers, and that directory is shared with the
    // user's own OpenCode — including native, non-Docker installs on the same
    // host.
    //
    // So it registers NOTHING unless the driver put it there and set this
    // variable. Otherwise a plain `opencode2` run would advertise tools that
    // cannot reach any driver, and a model would waste turns discovering that
    // for itself.
    if (!process.env.PODPROMPT_DRIVER_URL) return

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "list_sessions",
        description:
          "List the other PodPrompt sessions (the chats in the user's PodPrompt window) "
          + "that you can message, with their @handle, backend, whether they are idle or "
          + "busy, and how they relate to you. Shows the most recently active first; use "
          + "search or all to reach the rest. These are not sub-agents and not your "
          + "harness's own agents.",
        input: {
          type: "object",
          properties: {
            search: { type: "string", description: "Only peers whose handle or title contains this text." },
            all: {
              type: "boolean",
              description: "Return every addressable peer instead of just the most recent."
                + " Lifts the default cap; a limit you pass alongside it is still respected.",
            },
            limit: { type: "number", description: "How many to return (default 20)." },
          },
          additionalProperties: false,
        },
        async execute(input: any, tctx: any) {
          const args = input || {}
          const params = new URLSearchParams({ from: tctx.sessionID })
          if (args.search) params.set("search", String(args.search))
          if (args.all) params.set("all", "1")
          if (args.limit) params.set("limit", String(args.limit))
          try {
            const { body } = await driverFetch(`/peers?${params.toString()}`)
            if (!body || body.error) return say(`Could not list peers: ${body?.error || "no response"}`)
            if (!body.peers?.length) {
              return say(args.search
                ? `No peer matches "${args.search}" (${body.total} sessions are addressable).`
                : "No other sessions are currently addressable.")
            }
            // Always say what was held back. Showing a subset silently would
            // leave a model unable to tell that a peer it needs exists at
            // all — the paging default lives in driver.mjs so both backends
            // page identically.
            const note = body.truncated
              ? `\n\nShowing ${body.shown} of ${body.matched}`
                + (body.search ? ` matching "${body.search}". ` : ` (${body.total} total). `)
                + `Call again with all=true, a higher limit, or a search term to see the rest.`
              : (body.search ? `\n\n${body.matched} of ${body.total} peers match "${body.search}".` : "")
            return say(JSON.stringify(body.peers, null, 2) + note)
          } catch (e: any) {
            return say(`Could not list peers: ${e?.message || String(e)}`)
          }
        },
      })

      editor.add({
        name: "delegate_session",
        description:
          "Create a NEW PodPrompt session on a chosen backend and give it work. PREFER THIS "
          + "over spawning an ordinary sub-agent for anything substantial: it can run on a "
          + "different backend or model than yours, and by default it is asynchronous — your "
          + "turn ends right away and the result arrives later as a message, so the user is "
          + "not left waiting. Use a plain sub-agent (or await=true) only when the work is "
          + "quick and you need its answer inside this turn. "
          + "You get back only its FINAL reply, not its whole transcript — so say what the "
          + "answer should look like and ask for it last. You also get an @handle: follow up "
          + "with message_session, and the user can open the session to read it in full.",
        input: {
          type: "object",
          properties: {
            backend: {
              type: "string", enum: ["claude-code", "opencode"],
              description: "Which backend the new session should run on.",
            },
            prompt: {
              type: "string",
              description: "The work, stated so it stands alone. The new session starts a FRESH"
                + " conversation: it cannot see this one, anything you have read, or the"
                + " instructions you were given — if it needs background, put it here. It DOES"
                + " share the same workspace and working directory, so refer to files by path"
                + " rather than pasting them.",
            },
            title: { type: "string", description: "Short label for the new session." },
            model: {
              type: "string",
              description: "Which model the new session runs on. Omit to inherit yours when the"
                + " backend matches, or that backend's default otherwise. Model ids differ by"
                + " backend and are not listed anywhere — if you want a particular one and do"
                + " not know its id, just guess: an unrecognized value is rejected with the"
                + " full list of ids that backend accepts, and nothing else happens, so you"
                + " can immediately call again with a real one.",
            },
            await: {
              type: "boolean",
              description: "Default false: returns immediately and the result arrives later as a"
                + " message. Set true ONLY for quick work whose answer you need inside this turn"
                + " — it holds your turn open until the new session finishes.",
            },
          },
          required: ["backend", "prompt"],
          additionalProperties: false,
        },
        async execute(input: any, tctx: any) {
          const args = input || {}
          try {
            await gate(ctx, tctx.sessionID, "podprompt-delegate", String(args.backend))
          } catch (e: any) {
            return say(`Not delegated: permission denied (${e?.message || "rejected"}).`)
          }
          try {
            const { body } = await driverFetch("/delegate", {
              method: "POST",
              body: JSON.stringify({
                from: tctx.sessionID,
                backend: args.backend,
                prompt: args.prompt,
                title: args.title || null,
                model: args.model || null,
                awaitResult: args.await === true,
              }),
            })
            const r = (body || {}) as any
            if (!r.ok) return say(r.describe || `Delegation failed (${r.reason || "unknown"}).`)
            if (!r.awaited) {
              return say(`Delegated to ${r.handle} on ${args.backend}. It is running now; its`
                + ` report will arrive as a message. You can also send it more instructions`
                + ` with the message tool.`)
            }
            return say(`${r.handle} (${args.backend}) finished [${r.outcome}].\n\n`
              + (r.text || "(it produced no text output)")
              + `\n\nYou can follow up with it using the message tool and this handle.`)
          } catch (e: any) {
            return say(`Delegation failed: ${e?.message || String(e)}`)
          }
        },
      })

      editor.add({
        name: "read_session",
        description:
          "Read the transcript of a PodPrompt session — another one, or your OWN. Use it to "
          + "recover something said EARLIER in this conversation that you no longer remember "
          + "or that was summarised away by compaction, to re-read what the user told you "
          + "before, or to find detail a delegated session did not include in its final "
          + "reply. Search by text, or page with from=. Returns numbered entries, most recent "
          + "by default.",
        input: {
          type: "object",
          properties: {
            session: { type: "string", description: 'Which session: an @handle from list_sessions, or "me" for this session\'s own transcript (the default).' },
            search: { type: "string", description: "Only entries containing this text. The main way to find something specific without reading everything." },
            from: { type: "number", description: "Start at this entry number and read forwards — use it to reach the BEGINNING of a long session, which the default (most recent) will not show." },
            last: { type: "number", description: "Only the final N entries." },
            role: { type: "string", enum: ["assistant", "user", "tool"], description: "Only entries of this kind: assistant, user or tool. Tool entries hold command output and are often where a detail actually lives." },
            limit: { type: "number", description: "How many entries to return (default 10, max 25)." },
          },
          additionalProperties: false,
        },
        async execute(input: any, tctx: any) {
          const args = input || {}
          const q = new URLSearchParams({ from: tctx.sessionID })
          if (args.session) q.set("session", String(args.session))
          if (args.search) q.set("search", String(args.search))
          if (args.from) q.set("start", String(args.from))
          if (args.last) q.set("last", String(args.last))
          if (args.role) q.set("role", String(args.role))
          if (args.limit) q.set("limit", String(args.limit))
          try {
            const { body } = await driverFetch(`/read-session?${q.toString()}`)
            // The driver renders it, so both backends print the same thing.
            return say((body?.rendered as string) || `Could not read that session.`)
          } catch (e: any) {
            return say(`Could not read that session: ${e?.message || String(e)}`)
          }
        },
      })

      editor.add({
        name: "message_session",
        description:
          "Send a message to another PodPrompt session, addressed by an @handle from "
          + "list_sessions. Delivered when that session is idle; it replies by messaging "
          + "you back, so this does not block and does not return their answer. Can also "
          + "restart a stalled session. Use this ONLY for PodPrompt sessions — not for "
          + "sub-agents you spawned, and not for any other agent-messaging tool your "
          + "harness provides.",
        input: {
          type: "object",
          properties: {
            to: { type: "string", description: 'Peer handle, e.g. "@researcher". Get these from list_sessions.' },
            text: { type: "string", description: "What to say. Include enough context to act on alone." },
            resume: {
              type: "boolean",
              description: "Set true for a session list_sessions reports as stalled. Sends the"
                + " standard continuation prompt for however its turn died; your text, if any,"
                + " is appended rather than replaced.",
            },
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        async execute(input: any, tctx: any) {
          const args = input || {}
          try {
            await gate(ctx, tctx.sessionID, "podprompt-message", String(args.to))
          } catch (e: any) {
            return say(`Message not sent: permission denied (${e?.message || "rejected"}).`)
          }
          try {
            const { body } = await driverFetch("/deliver", {
              method: "POST",
              body: JSON.stringify({
                // Supplied by OpenCode's runtime, never by the model.
                from: tctx.sessionID,
                to: args.to,
                text: args.text,
                kind: "peer",
                resume: args.resume === true,
              }),
            })
            const receipt = (body || {}) as Receipt
            // driver.mjs owns the wording of every outcome, including the
            // refusals, so both backends say the same thing. A receipt a
            // model cannot interpret gets retried.
            return say(receipt.describe
              || (receipt.ok
                ? `Message ${receipt.delivered ? "delivered" : "queued"} to ${args.to}.`
                : `Message not delivered (${receipt.reason || "unknown"}).`))
          } catch (e: any) {
            return say(`Message failed: ${e?.message || String(e)}`)
          }
        },
      })
    })
  },
}
