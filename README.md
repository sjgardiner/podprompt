# PodPrompt

Run AI coding agents in a container and work with them in your browser — several
at once, on two different backends, in different projects. The agents can message
each other, hand each other work, and keep going while you are away.

```
                    your browser
                         │
               ┌─────────┴─────────┐
               │   PodPrompt UI    │   one window, every session
               └─────────┬─────────┘
                         │
   ╔═════════════════════╪═════════════════════╗
   ║   container         │                     ║
   ║            ┌────────┴────────┐            ║
   ║            │     driver      │            ║
   ║            └───┬─────────┬───┘            ║
   ║        ┌───────┴──┐   ┌──┴───────┐        ║
   ║        │  Claude  │   │ OpenCode │        ║
   ║        │   Code   │   │          │        ║
   ║        └───┬──────┘   └──────┬───┘        ║
   ║      @session-a ◀── mail ──▶ @session-b   ║
   ║            │                 │            ║
   ║       sub-agents        delegated         ║
   ║                          sessions         ║
   ╚═══════════════════════════════════════════╝
```

## Quickstart

Needs Docker, a browser, and a full checkout of this repository. Set up once:

```sh
export PATH="/path/to/podprompt/bin:$PATH"   # in ~/.bashrc or ~/.zshrc
podprompt --build                            # build the image (both backends live inside it)
podprompt --deploy-viewer                    # install the viewer app
podprompt --claude                           # one-time sign-in, for a Claude subscription
```

Then, from whichever project you want to work on:

```sh
cd ~/some/project
podprompt
```

That opens `http://localhost:7843`. **The directory you run it from becomes the
workspace**, mounted at `/workspace` for the agents — that is how you pick a
project, and there is no flag for it. Both ports bind to `127.0.0.1` only, so
nothing is exposed to your network.

Keep the checkout somewhere permanent: the command resolves it from its own
location on every run, which is what lets `--build` and `--deploy-viewer` work
from any directory.

Full detail, including API-key and LiteLLM setups: **[Install & launch](https://sjgardiner.github.io/podprompt/install.html)**.

## What it does

- **One window, many sessions.** Claude Code and OpenCode side by side, across
  projects, each with its own model.
- **Everything visible.** Streamed text and thinking, every tool call, real file
  diffs, permission cards inline where the request happened.
- **Sessions talk to each other.** Each has an `@handle`. Agents can list their
  peers, message one, and read a transcript — including their own.
- **Agents can spawn agents.** A session can create a new session on either
  backend and any model, hand it a job, and collect the result later.
- **Bounded by design.** One shared budget of automatic turns, with mail held for
  your approval, so autonomy is something you grant rather than something you
  discover.
- **It recovers on its own.** Stalled turns are resumed, provider limits are
  waited out with a stated estimate, and a turn that died never displays as one
  that finished.

## Documentation

**https://sjgardiner.github.io/podprompt/** — or open `docs/index.html` from a
clone. It is plain HTML with no build step and no dependencies.

| Page | What's in it |
| --- | --- |
| [Start here](https://sjgardiner.github.io/podprompt/) | What PodPrompt is, the five ideas, quickstart |
| [Install & launch](https://sjgardiner.github.io/podprompt/install.html) | Prerequisites, building, credentials, troubleshooting |
| [The interface](https://sjgardiner.github.io/podprompt/tour.html) | Header instruments, every bubble type, every setting and its default |
| [Many sessions](https://sjgardiner.github.io/podprompt/sessions.html) | Running several at once, sub-agents, and what each Stop stops |
| [Sessions talking](https://sjgardiner.github.io/podprompt/messaging.html) | Handles, the tools agents have, and why mail sometimes waits |
| [Delegating work](https://sjgardiner.github.io/podprompt/delegation.html) | Spawning sessions, choosing backend and model, collecting results |
| [Running unattended](https://sjgardiner.github.io/podprompt/unattended.html) | Budgets, time windows, usage limits, automatic recovery |
| [Playbook](https://sjgardiner.github.io/podprompt/playbook.html) | Patterns for real leverage, and a "nothing is happening" checklist |
| [Reference](https://sjgardiner.github.io/podprompt/reference.html) | Every flag, variable, path, port, and numeric default |

New here? Read [Start here](https://sjgardiner.github.io/podprompt/), then
[The interface](https://sjgardiner.github.io/podprompt/tour.html).

## The five ideas

| | |
| --- | --- |
| **session** | The unit of everything. One agent, one backend, one model, one directory. |
| **backend** | Claude Code or OpenCode. Both in the same interface, not at feature parity. |
| **@handle** | A session's address. Follows a rename you make; old names keep resolving. |
| **mail** | A message from one session to another, delivered as a turn. Sometimes held. |
| **autonomy** | One global budget of automatic turns. Spend it and everything parks. |
