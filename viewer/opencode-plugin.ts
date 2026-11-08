// PodPrompt's OpenCode plugin: the second of the two shims over one
// implementation.
//
// Claude Code gets the same tools through an in-process SDK MCP server built
// per turn. OpenCode runs in its own process (`opencode serve`, spawned and
// supervised by driver.mjs), so this reaches the identical driver functions
// over HTTP instead. Deliberately thin: it contributes identity and nothing
// else. Every decision — resolution, authorization, budgets, parking — lives
// in driver.mjs, because two implementations of the same three tools is
// exactly the drift this project keeps getting bitten by.
//
// Why a plugin rather than an MCP server: verified live against opencode
// 1.18.30 that a plugin can register tools directly (Hooks.tool), and that
// ToolContext.sessionID is supplied by OpenCode's own runtime. That last
// part is the whole security argument — the model passes only its declared
// arguments, and who is calling arrives alongside, out of its reach. A
// `from` the model could assert would make every downstream trust rule
// decorative.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// Injected by driver.mjs when it spawns `opencode serve`. The token is
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

export default (async () => {
  // Inert unless driver.mjs spawned this `opencode serve`. The plugin lives
  // in OpenCode's global plugin directory because that is the only location
  // OpenCode actually auto-discovers (verified: a plugin listed in the
  // config `plugin` array is reported but never loaded), and that directory
  // is shared with the user's own OpenCode — including native, non-Docker
  // installs on the same host.
  //
  // So it registers NOTHING unless the driver put it there and set this
  // variable. Otherwise a plain `opencode` run would advertise tools that
  // cannot reach any driver, and a model would waste turns discovering that
  // for itself.
  if (!process.env.PODPROMPT_DRIVER_URL) return {}

  return {
    tool: {
      list_sessions: tool({
        description:
          "List the other PodPrompt sessions (the chats in the user's PodPrompt window) "
          + "that you can message, with their @handle, backend, whether they are idle or "
          + "busy, and how they relate to you. Shows the most recently active first; use "
          + "search or all to reach the rest. These are not sub-agents and not your "
          + "harness's own agents.",
        args: {
          search: tool.schema.string().optional()
            .describe("Only peers whose handle or title contains this text."),
          all: tool.schema.boolean().optional()
            .describe("Return every addressable peer instead of just the most recent."),
          limit: tool.schema.number().optional()
            .describe("How many to return (default 20)."),
        },
        async execute(args, context) {
          const params = new URLSearchParams({ from: context.sessionID })
          if (args.search) params.set("search", String(args.search))
          if (args.all) params.set("all", "1")
          if (args.limit) params.set("limit", String(args.limit))
          try {
            const { body } = await driverFetch(`/peers?${params.toString()}`)
            if (!body || body.error) {
              return `Could not list peers: ${body?.error || "no response"}`
            }
            if (!body.peers?.length) {
              return args.search
                ? `No peer matches "${args.search}" (${body.total} sessions are addressable).`
                : "No other sessions are currently addressable."
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
            return {
              title: `${body.shown} peer${body.shown === 1 ? "" : "s"}`,
              output: JSON.stringify(body.peers, null, 2) + note,
              metadata: { shown: body.shown, total: body.total },
            }
          } catch (e: any) {
            return `Could not list peers: ${e?.message || String(e)}`
          }
        },
      }),

      delegate_session: tool({
        description:
          "Create a NEW PodPrompt session on a chosen backend and give it a piece of work. "
          + "Use this to hand work to a different BACKEND or model than your own — it is "
          + "not the way to spawn an ordinary sub-agent within your own backend. "
          + "By default it waits and returns the result; set await=false to be told "
          + "later by message instead, which is what you want when fanning out.",
        args: {
          backend: tool.schema.enum(["claude-code", "opencode"])
            .describe("Which backend the new session should run on."),
          prompt: tool.schema.string()
            .describe("The work. Self-contained — the new session sees none of your context."),
          title: tool.schema.string().optional()
            .describe("Short label for the new session."),
          await: tool.schema.boolean().optional()
            .describe("Wait for the result (default true). false returns immediately."),
        },
        async execute(args, context) {
          try {
            await context.ask({
              permission: "podprompt-delegate",
              patterns: [String(args.backend)],
              always: ["podprompt-delegate"],
              metadata: { backend: args.backend, preview: String(args.prompt).slice(0, 200) },
            })
          } catch (e: any) {
            return `Not delegated: permission denied (${e?.message || "rejected"}).`
          }
          try {
            const { body } = await driverFetch("/delegate", {
              method: "POST",
              body: JSON.stringify({
                from: context.sessionID,
                backend: args.backend,
                prompt: args.prompt,
                title: args.title || null,
                awaitResult: args.await !== false,
              }),
            })
            const r = (body || {}) as any
            if (!r.ok) return r.describe || `Delegation failed (${r.reason || "unknown"}).`
            if (!r.awaited) {
              return {
                title: `delegate → ${r.handle}`,
                output: `Delegated to ${r.handle} on ${args.backend}. It is running now; its`
                  + ` report will arrive as a message. You can also send it more instructions`
                  + ` with the message tool.`,
                metadata: { childId: r.childId, awaited: false },
              }
            }
            return {
              title: `delegate → ${r.handle}`,
              output: `${r.handle} (${args.backend}) finished [${r.outcome}].\n\n`
                + (r.text || "(it produced no text output)")
                + `\n\nYou can follow up with it using the message tool and this handle.`,
              // The adoption path opencode.mjs already uses for sub-agents
              // reads exactly these keys off a completed tool part.
              metadata: { sessionId: r.childId, parentSessionId: context.sessionID, awaited: true },
            }
          } catch (e: any) {
            return `Delegation failed: ${e?.message || String(e)}`
          }
        },
      }),

      message_session: tool({
        description:
          "Send a message to another PodPrompt session, addressed by an @handle from "
          + "list_sessions. Delivered when that session is idle; it replies by messaging "
          + "you back, so this does not block and does not return their answer. Can also "
          + "restart a stalled session. Use this ONLY for PodPrompt sessions — not for "
          + "sub-agents you spawned, and not for any other agent-messaging tool your "
          + "harness provides.",
        args: {
          to: tool.schema.string()
            .describe('Peer handle, e.g. "@researcher". Get these from list_sessions.'),
          text: tool.schema.string()
            .describe("What to say. Include enough context to act on alone."),
          resume: tool.schema.boolean().optional().describe(
            "Set true for a session list_sessions reports as stalled. Sends the standard"
            + " continuation prompt for however its turn died; your text, if any, is"
            + " appended rather than replaced."),
        },
        async execute(args, context) {
          // Parity with Claude Code, where an MCP tool call goes through
          // canUseTool and so raises a permission card. OpenCode custom
          // tools do not gate themselves, so ask for it explicitly —
          // otherwise the same action would be challenged on one backend and
          // silent on the other. PodPrompt already intercepts this flow
          // (permission.v2.asked), so it surfaces as an ordinary card and
          // honours the session's auto-approve.
          try {
            await context.ask({
              permission: "podprompt-message",
              patterns: [String(args.to)],
              always: ["podprompt-message"],
              metadata: { to: args.to, preview: String(args.text).slice(0, 200) },
            })
          } catch (e: any) {
            return `Message not sent: permission denied (${e?.message || "rejected"}).`
          }

          try {
            const { body } = await driverFetch("/deliver", {
              method: "POST",
              body: JSON.stringify({
                // Supplied by OpenCode's runtime, never by the model.
                from: context.sessionID,
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
            const text = receipt.describe
              || (receipt.ok
                ? `Message ${receipt.delivered ? "delivered" : "queued"} to ${args.to}.`
                : `Message not delivered (${receipt.reason || "unknown"}).`)
            return {
              title: `message → ${args.to}`,
              output: text,
              metadata: { ok: !!receipt.ok, reason: receipt.reason || null },
            }
          } catch (e: any) {
            return `Message failed: ${e?.message || String(e)}`
          }
        },
      }),
    },
  }
}) satisfies Plugin
