---
id: acpAgents
name: ACP agents
title: ACP agents: run OpenCode, Cursor and Antigravity next to Claude and Codex
added: 2026-11-09
on: false
reminder: b74daed5
---

## What it does

Agent CLIs that speak the Agent Client Protocol get threads of their own, next to Claude and Codex: OpenCode (free models work with no login) and Cursor (after `agent login`). If one is installed it turns up as a login and a pool, and its models in the picker. Everything the agent wants to do comes through Threadbear first: on Ask and Plan first you get the usual cards, Auto behaves like Ask, and Full access goes ahead without them. A folder's own OpenCode config and plugins aren't read in these threads. Cursor can't be told to always ask, so its Ask, Auto and Plan first threads run in its read-only modes and can't change anything; to let Cursor change files, use Full access. Small jobs (titles and summaries) stay on Claude unless you pick a pool of only OpenCode logins for them in Settings. No usage readings, sandbox or going back to an earlier message for these yet, and Threadbear only updates their CLIs when you press Update in the Updates panel.

Antigravity uses the official `agy acp` CLI, reusing your Google sign-in. If
needed, run `agy acp --login`. Threadbear creates a separate strict settings
profile under `~/.gemini/threadbear-acp`, so terminal settings and saved grants
don't bypass Threadbear's cards. Models come from your account; thinking level
uses the CLI default. Antigravity cannot take small jobs. Its Update button runs
`agy update`.

## Lives in

`runner/src/adapters/acp/`; `ACP_PROVIDERS` rows in `runner/src/providers.ts`; `acpAccounts` in `runner/src/accounts.ts`; the adapters built in `runner/src/main.ts`

## Taking it out

Delete `runner/src/adapters/acp/` (`runner/src/adapters/tool-gate.ts` stays, as Codex uses it). Remove `cursor`, `opencode` and `antigravity` from `Provider` and `PROVIDER_INFO`, the `acpAdapters` lines in `main.ts`, the `acpAccounts` call in `accounts.ts`, and `cursorPath`/`opencodePath`/`antigravityPath` in `config.ts`.
