// LIVE_ANTIGRAVITY=1 node --test test/e2e/antigravity.e2e.test.ts
// Uses the official CLI on the local Google login, an isolated profile and
// a tiny Flash prompt. No real project or Threadbear data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AcpAdapter } from '../../src/adapters/acp/adapter.ts';
import { ACP_AGENTS } from '../../src/adapters/acp/agents.ts';
import type { AdapterOutput, AgentSession, SessionSink, ToolApprovalRequest, TurnResult } from '../../src/adapters/types.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { takenEndTurn } from '../../src/needs.ts';
import { makeHarness } from '../helpers/fakes.ts';

test('official Antigravity: streamed reply, MCP, denied edit, approved edit and resume', { skip: process.env.LIVE_ANTIGRAVITY !== '1', timeout: 240_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agy-e2e-'));
  const base = ACP_AGENTS.antigravity;
  const profileName = path.basename(root);
  const profile = path.join(os.homedir(), '.gemini', profileName);
  const agent = { ...base, args: base.args.map((v) => v === 'threadbear-acp' ? profileName : v), prepare() { fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ toolPermission: 'strict', agentMode: '', permissions: { allow: ['write_file(*)', 'command(*)'] } }), { mode: 0o600 }); } };
  const binary = base.findBinary({ home: os.homedir(), pathEnv: process.env.PATH ?? '' });
  assert.ok(binary, 'install the official agy CLI first');
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const outputs: AdapterOutput[] = [];
  const cards: ToolApprovalRequest[] = [];
  let nativeId: string | undefined;
  let pending: { resolve: (r: TurnResult) => void; reject: (e: Error) => void } | undefined;
  let mcpCalls = 0;
  const harness = makeHarness();
  // Exercise the full toolbox: the CLI silently dropped end_turn with a
  // verbose schema here, even though it worked with only one or two tools.
  const toolbox = buildThreadbearTools(harness.runner, 'antigravity-test', Date.now, {} as never, {} as never, {} as never, { provider: 'codex', oneReply: () => true });
  const finish = toolbox[0]!;
  finish.handler = async () => ({ content: [{ type: 'text' as const, text: 'Noted: this thread is done. Write your reply now.' }] });
  const sink: SessionSink = {
    output(o) { outputs.push(o); if (o.kind === 'session') nativeId = o.nativeSessionId; if (o.kind === 'result') pending?.resolve(o.result); },
    async requestApproval(r) { cards.push(r); return { decision: 'deny' }; },
    async requestQuestion() { return { answers: null }; },
    exited(e) { if (e) pending?.reject(e); },
  };
  const adapter = new AcpAdapter({ agent, binary: () => binary, on: () => true, registry, log: nullLogger,
    toolsFor: () => [...toolbox, { name: 'integration_check', description: 'Check the Threadbear connection. Returns a verification word.', inputSchema: { value: z.string() }, annotations: { readOnlyHint: true }, handler: async () => { mcpCalls++; return { content: [{ type: 'text', text: 'THREADBEAR_CONNECTED' }] }; } }],
  });
  const account = { id: 'antigravity-main', provider: 'antigravity' as const, title: 'Antigravity', configDir: profile };
  const opts = { threadId: 'antigravity-test', cwd: root, account, model: 'gemini-3.8-flash', permissionMode: 'ask' as const, sessionId: 'new', resume: false, mediaDir: path.join(root, 'media'), blobsDir: path.join(root, 'blobs'), tmpDir: path.join(root, 'tmp') };
  let session: AgentSession | undefined;
  const send = async (text: string) => {
    const done = new Promise<TurnResult>((resolve, reject) => { pending = { resolve, reject }; });
    session!.send({ id: crypto.randomUUID(), text, images: [] });
    const r = await done;
    assert.equal(r.outcome, 'completed', r.error ?? 'turn completed');
    pending = undefined;
  };
  try {
    const models = await adapter.models(account);
    assert.ok(models.some((m) => m.id === opts.model));
    session = adapter.start(opts, sink);
    await send('Call the threadbear integration_check tool with value hello, then say its verification word. Use no other tools.');
    assert.ok(mcpCalls > 0, 'the HTTP MCP tool reached Threadbear');
    assert.ok(outputs.some((o) => o.kind === 'event' && o.event.type === 'assistant.text' && o.event.text.includes('THREADBEAR_CONNECTED')), 'reply rendered');
    assert.ok(outputs.some((o) => o.kind === 'delta'), 'reply streamed');
    const offset = outputs.length;
    await send('Call end_turn with needs nothing and headline Connected. Then say Connected. No other tools.');
    const events = outputs.slice(offset).flatMap((o) => o.kind === 'event' ? [o.event] : []);
    assert.equal(takenEndTurn(events as never)?.headline, 'Connected', 'finish-turn call and result are recorded for the Done card');
    assert.equal(events.filter((e) => e.type === 'tool.call' && e.name === 'mcp__threadbear__end_turn').length, 1, 'ACP echoes did not duplicate the MCP call');
    await send('Use your file writing tool once to create denied.txt containing forbidden. If permission is denied, stop immediately. Use no other tools.');
    assert.ok(cards.some((c) => c.name === 'apply_patch'));
    assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false, 'strict beat the saved allow rule');
    await session.setPermissionMode('full');
    const before = cards.length;
    await send('Create allowed.txt containing approved using your file writing tool. Then say done.');
    assert.equal(fs.readFileSync(path.join(root, 'allowed.txt'), 'utf8').trim(), 'approved');
    assert.equal(cards.length, before, 'Full access needs no card');
    assert.ok(nativeId);
    await session.end();
    session = adapter.start({ ...opts, sessionId: nativeId, resume: true, permissionMode: 'full' }, sink);
    await send('Without using tools, repeat the verification word returned by integration_check earlier in this conversation.');
    const reply = outputs.filter((o) => o.kind === 'event' && o.event.type === 'assistant.text').at(-1);
    assert.ok(reply?.kind === 'event' && reply.event.type === 'assistant.text' && reply.event.text.includes('THREADBEAR_CONNECTED'), 'conversation resumed');
    console.log('Verified real Antigravity model discovery, streaming, MCP, deny, allow and resume.');
  } finally {
    await session?.end({ hard: true });
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(harness.home, { recursive: true, force: true });
  }
});
