---
id: dictationLearning
name: Learn dictation spellings
title: Learn confirmed dictation spellings and sync them to FluidVoice
added: 2026-11-12
on: false
reminder: a6bc4449
---

## What it does

Agents record likely misheard names during a chat. The librarian reviews new user messages and pending corrections during its usual looks, so leaving a chat does not lose them. Guesses stay pending until an explicit user correction or your review confirms them. Confirmed spellings sync to FluidVoice through its optional local API without opening windows. Private folders are excluded. The vocabulary, provenance and backups stay on this runner. `tb dictation` lists them; `confirm`, `reject`, `sync` and `undo` manage them. FluidVoice's local API must already be enabled on port 47733. This feature never enables that API or changes your voice models.

## Lives in

`runner/src/dictation-learning.ts`, librarian integration in `runner/src/librarian.ts`, the agent tool in `runner/src/threadbear-mcp.ts`, and lifecycle/RPC wiring in `runner/src/main.ts`. The runner data directory holds `dictation-learning.json`, the readable `dictation-vocabulary.html`, `dictation-backups/` and the temporary writer lock. FluidVoice is an optional Mac app, not installed by Threadbear. No extra AI timer is created.

## Taking it out

Turn the experiment off to stop learning and syncing. Existing FluidVoice entries remain. Undo a synced correction before turning it off if wanted; undo refuses to overwrite later edits. Remove the module and its wiring/tool/CLI/docs to remove the feature. Keep or delete the local journal and backups deliberately; never restore a whole backup over later user changes.
