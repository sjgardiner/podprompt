# model-discovery

An optional OpenCode plugin that asks each of your OpenAI-compatible providers
what models it serves, and registers the answer — so you stop hand-listing
model ids in `opencode.jsonc`.

Not installed by PodPrompt. Copy it in if you want it.

## Why you might want it

A provider declared in `opencode.jsonc` with no `models` block contributes
nothing at all — OpenCode drops it. So you hand-list ids, and that list goes
stale silently: a model added upstream stays invisible until you notice, and
one withdrawn upstream sits in your picker until it fails mid-turn.

## Before you rely on it

**This uses an API OpenCode does not document.** It was derived by
experiment and verified against **OpenCode 2.2.7**. An upgrade could change it
without warning. Run `verify/run.sh` after upgrading — it checks the whole
path against stand-in servers in about a minute, and needs none of your real
providers to be up.

## Install

```sh
cp model-discovery.ts            ~/.config/opencode/plugin/
cp model-discovery.example.json  ~/.config/opencode/model-discovery.json
```

Then add provider blocks to `~/.config/opencode/opencode.jsonc` — see
`opencode.example.jsonc`. Restart OpenCode (or, under PodPrompt, restart the
viewer) and your models appear a few seconds later.

## How it decides what to poll

Every provider in your config is polled if its `npm`/`package` mentions
`openai-compatible`, or its `baseURL` contains `/v1`. It asks
`{baseURL}/models` unless you say otherwise.

`model-discovery.json` is where you say otherwise. It lives in its own file
rather than inside `opencode.jsonc` deliberately: a mistake here cannot stop
your OpenCode config from loading.

| Key | Scope | Meaning |
| --- | --- | --- |
| `intervalSeconds` | top level | How often to re-poll. Default 600, minimum 30. |
| `providers.<id>.endpoint` | provider | Poll this instead of `{baseURL}/models`. Relative resolves against `baseURL`; absolute is used as-is, for lists published outside the API path. |
| `providers.<id>.shape` | provider | Skip sniffing and parse as this. |
| `providers.<id>.enabled` | provider | `false` to never poll it. |

## Response shapes

Sniffed from the response unless you set `shape`.

| Shape | Looks like | Metadata it can read |
| --- | --- | --- |
| `openai` | `{"data": [{"id": …}]}` | llama.cpp's `meta.n_ctx`; otherwise defaults |
| `litellm-info` | `{"data": [{"model_name": …, "model_info": {…}}]}` | `max_input_tokens`, `max_output_tokens`, `supports_function_calling`, `supports_vision` |
| `alcf` | a bare top-level array | `capabilities.context_window_tokens`, `tool_calling.supported`, `input_modalities`, `display_name` |

`alcf` is one specific site's schema (Argonne's inference service), included
because it is a worked example of a provider whose list is neither at the
conventional path nor in the conventional shape. Use it if yours happens to
match; most won't.

Anything the response does not carry falls back to a 32768-token context and
8192-token output.

## Behaviour worth knowing

- **Models arrive a few seconds after startup**, not instantly. Discovery is a
  network call; blocking startup on it would be worse.
- **A provider that is down costs you only that provider.** It warns, keeps
  whatever it found last time, and leaves the others alone. A provider that has
  never answered simply contributes nothing.
- **Only providers already in `opencode.jsonc` can be filled.** Registering
  models for a provider the config has never heard of silently does nothing, so
  each endpoint needs its block — endpoint and key, written once.

## Verifying

```sh
verify/run.sh
```

Stands up stand-in servers for each supported shape, runs an isolated OpenCode
against them, and reports whether the discovered models reached the catalog.
Touches nothing of yours: its own config directory, its own port, no network.
