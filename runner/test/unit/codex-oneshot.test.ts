import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAsker } from '../../src/models/codex-oneshot.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { FakeCodex } from '../helpers/fake-app-server.ts';
import type { AskRequest } from '../../src/models/acp-oneshot.ts';

const roots: string[] = [];
let shared: Promise<FakeCodex> | undefined;
after(async () => {
  if (shared) await (await shared).close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
async function rig(extra: Partial<AskRequest> = {}) {
  const fake = await (shared ??= FakeCodex.create());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-small-codex-'));
  roots.push(root);
  const registry = new ProcessRegistry(root, nullLogger);
  const ask = codexAsker({ binary: () => fake.bin, registry, log: nullLogger, timings: { closeWaitMs: 500, spawnRetryForMs: 0 } });
  const req: AskRequest = { account: { id: 'codex-main', title: 'Codex', provider: 'codex', configDir: '/work/codex' }, model: 'gpt-6-luna', user: 'PRIVATE thread text', system: 'Give a title', cwd: path.join(root, 'empty'), timeoutMs: 8000, ...extra };
  const result = ask(req);
  const conn = await fake.next();
  await conn.init();
  const config = await conn.request('config/read');
  conn.respond(config.id, { config: { mcp_servers: { inherited: { command: '/must/not/run' }, 'with.dot': { url: 'http://localhost' } } } });
  const skills = await conn.request('skills/list');
  conn.respond(skills.id, { data: [{ skills: [{ name: 'private-standalone-skill', path: '/work/SKILL.md' }], errors: [] }] });
  const start = await conn.request('thread/start');
  conn.respond(start.id, { thread: { id: 'small' }, model: 'actual-gpt' });
  const turn = await conn.request('turn/start');
  conn.respond(turn.id, { turn: { id: 'turn' } });
  return { req, result, conn, start, turn, registry };
}
function finish(conn: Awaited<ReturnType<typeof rig>>['conn'], text = 'A useful title') {
  conn.notify('item/completed', { threadId: 'other', item: { type: 'agentMessage', text: 'wrong thread' } });
  conn.notify('item/completed', { threadId: 'small', item: { type: 'agentMessage', phase: 'commentary', text: 'thinking' } });
  conn.notify('item/completed', { threadId: 'small', item: { type: 'agentMessage', phase: 'final_answer', text } });
  conn.notify('thread/tokenUsage/updated', { threadId: 'small', tokenUsage: { last: { inputTokens: 90, outputTokens: 8 } } });
  conn.notify('turn/completed', { threadId: 'small', turn: { status: 'completed' } });
}

test('Codex small jobs are ephemeral, disable inherited MCP and tools, send text over stdin and collect final text and usage', async () => {
  const h = await rig();
  assert.equal(h.conn.hello.env.CODEX_HOME, h.req.account.configDir);
  assert.ok(!h.conn.hello.argv.some(a => a.includes('PRIVATE')));
  for (const feature of ['hooks', 'plugins', 'apps', 'shell_tool', 'code_mode_host', 'memories', 'goals', 'view_image']) assert.ok(h.conn.hello.argv.includes(`features.${feature}=false`));
  assert.ok(h.conn.hello.argv.includes('notify=[]'));
  assert.equal(h.start.params.ephemeral, true);
  assert.equal(h.start.params.baseInstructions, 'Give a title');
  assert.deepEqual(h.start.params.dynamicTools, []);
  assert.equal(h.start.params.sandbox, 'read-only');
  assert.deepEqual((h.start.params.config as any).skills, { include_instructions: false, bundled: { enabled: false }, config: [{ name: 'private-standalone-skill', enabled: false }] });
  const config = h.start.params.config as Record<string, unknown>;
  assert.equal((config.mcp_servers as any).inherited.enabled, false);
  assert.equal((config.mcp_servers as any)['with.dot'].enabled, false);
  assert.deepEqual(h.turn.params.input, [{ type: 'text', text: h.req.user, text_elements: [] }]);
  finish(h.conn);
  assert.deepEqual(await h.result, { ok: true, text: 'A useful title', model: 'actual-gpt', inputTokens: 90, outputTokens: 8 });
  await h.conn.closed;
  assert.deepEqual(h.registry.pids(), []);
});

test('structured output goes in outputSchema and every unexpected server request is refused', async () => {
  const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
  const h = await rig({ jsonSchema: schema });
  assert.deepEqual(h.turn.params.outputSchema, schema);
  const denied = await h.conn.serverRequest('item/commandExecution/requestApproval', { command: 'touch /tmp/not-allowed' });
  assert.ok(denied.error);
  finish(h.conn, '{"label":"bug"}');
  const r = await h.result;
  assert.ok(r.ok && r.text === '{"label":"bug"}');
});

test('usage-limit errors let the pool try another login', async () => {
  const h = await rig();
  h.conn.notify('turn/completed', { threadId: 'small', turn: { status: 'failed', error: { message: 'No room', codexErrorInfo: 'usageLimitExceeded' } } });
  const r = await h.result;
  assert.ok(!r.ok && r.limit && !r.timedOut);
});

test('empty answers fail, a crashed process fails promptly, and a hung turn times out', async () => {
  const empty = await rig();
  finish(empty.conn, '');
  assert.equal((await empty.result).ok, false);
  const crashed = await rig();
  crashed.conn.exit(2);
  assert.equal((await crashed.result).ok, false);
  const hung = await rig({ timeoutMs: 1200 });
  const r = await hung.result;
  assert.ok(!r.ok && r.timedOut);
  await hung.conn.closed;
  assert.deepEqual(hung.registry.pids(), []);
});


test('cumulative usage and the rerouted model describe the whole job', async () => {
  const h = await rig();
  h.conn.notify('model/rerouted', { threadId: 'small', toModel: 'gpt-rerouted' });
  h.conn.notify('thread/tokenUsage/updated', { threadId: 'small', tokenUsage: { total: { inputTokens: 250, outputTokens: 60 }, last: { inputTokens: 80, outputTokens: 10 } } });
  h.conn.notify('item/completed', { threadId: 'small', item: { type: 'agentMessage', text: 'done' } });
  h.conn.notify('turn/completed', { threadId: 'small', turn: { status: 'completed' } });
  assert.deepEqual(await h.result, { ok: true, text: 'done', model: 'gpt-rerouted', inputTokens: 250, outputTokens: 60 });
});
