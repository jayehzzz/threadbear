import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { DictationLearning, FluidVoiceClient, type DictionaryEntry, type DictationEvent } from '../../src/dictation-learning.ts';

function setup() {
  const home = tmpDir();
  const events: DictationEvent[] = [];
  const notes: string[] = [];
  let privateFolder = false, enabled = true;
  let items: DictionaryEntry[] = [{ id: 'existing', triggers: ['thread bear'], replacement: 'Threadbear' }];
  const writes: unknown[] = [];
  let reads = 0;
  let concurrent: (() => void) | undefined;
  const client = new FluidVoiceClient(async (route, body) => {
    if (route === '/v1/health') return { status: 'ok', version: '1.6.12' };
    if (body) {
      writes.push(body);
      const b = body as { mode: string; entries: DictionaryEntry[] };
      items = b.mode === 'replace' ? b.entries : [...b.entries, ...items.filter(x => !b.entries.some(e => e.replacement.toLowerCase() === x.replacement.toLowerCase()))];
    } else if (++reads === 2) concurrent?.();
    return { count: items.length, items: structuredClone(items) };
  });
  const host = {
    threads: () => [{ id: 'thread', cwd: '/work', lastSeq: events.at(-1)?.seq ?? 0 }],
    events: (_id: string, after: number, limit: number) => events.filter(e => e.seq > after).slice(0, limit),
    privateFolder: () => privateFolder,
    note: (_id: string, text: string) => notes.push(text),
  };
  const service = new DictationLearning({ home, host, enabled: () => enabled, client });
  service.start();
  const user = (text: string, origin?: DictationEvent['origin']) => { const e = { seq: events.length + 1, type: 'user.message', text, origin }; events.push(e); return e.seq; };
  return { home, service, host, client, events, writes, notes, user, items: () => items,
    makePrivate: () => { privateFolder = true; }, disable: () => { enabled = false; },
    concurrent: (f: () => void) => { concurrent = f; }, addManual: () => { items[0].triggers.push('manual spelling'); } };
}

test('a model/agent guess stays pending; real user confirmation is independently checked', () => {
  const s = setup();
  const seq = s.user('Open Threadbare');
  const c = s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq });
  assert.equal(c.status, 'pending');
  const unrelated = s.user('Threadbear has useful features.');
  assert.throws(() => s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: unrelated }), /explicit.*correction/i);
  const confirm = s.user('I meant Threadbear, not Threadbare.');
  assert.equal(s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: confirm }).status, 'confirmed');
  assert.equal(s.service.status().corrections.length, 1);
});

test('quotes, agent-origin messages, fabricated evidence and private folders cannot teach vocabulary', () => {
  const s = setup();
  const seq = s.user('Open Threadbare');
  for (const text of ['The document says "I meant Threadbear, not Threadbare".', '```\nI meant Threadbear, not Threadbare\n```']) {
    const confirmationSeq = s.user(text);
    assert.throws(() => s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq }), /explicit.*correction/i);
  }
  const generated = s.user('I meant Threadbear, not Threadbare.', 'agent' as never);
  assert.throws(() => s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: generated }));
  assert.throws(() => s.service.record('thread', { heard: 'MadeUp', replacement: 'Threadbear', sourceSeq: seq }), /source/i);
  s.makePrivate();
  assert.throws(() => s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq }), /private/i);
  assert.equal(s.service.batch('thread'), undefined);
});

test('short correction messages trigger review, and yes needs an unambiguous mapping question', () => {
  const s = setup();
  const seq = s.user('Open Threadbare');
  assert.equal(s.service.needsReview('thread'), false);
  s.events.push({ seq: 2, type: 'assistant.text', text: 'Should we avoid replacing Threadbare with Threadbear?' });
  const ambiguous = s.user('Yes.');
  assert.throws(() => s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: ambiguous }), /explicit.*correction/i);
  s.events.push({ seq: 4, type: 'assistant.text', text: 'Should I replace Threadbare with Threadbear?' });
  const confirmationSeq = s.user('Yes.');
  assert.equal(s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq }).status, 'confirmed');
  s.user('I meant Threadbear, not Threadbare.');
  assert.equal(s.service.needsReview('thread'), true);
});

test('pending candidates survive restart and review does not skip messages arriving during a call', async () => {
  const s = setup();
  s.user('Open Threadbare');
  const batch = s.service.batch('thread')!;
  s.user('I meant Threadbear, not Threadbare.');
  await s.service.review(batch, [{ heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: 1 }]);
  assert.equal(s.service.batch('thread')!.messages[0].seq, 2);
  const again = new DictationLearning({ home: s.home, host: s.host, enabled: () => true, client: s.client });
  again.start();
  assert.equal(again.status().corrections[0].status, 'pending');
  assert.equal(again.batch('thread')!.messages[0].seq, 2);
});

test('a chat still on a draining runner supplies independently fetched evidence', async () => {
  const s = setup();
  s.user('Open Threadbare');
  s.user('I meant Threadbear, not Threadbare.');
  const remote = new DictationLearning({home: tmpDir(), enabled: () => true, client: s.client, host: {
    ...s.host,
    events: () => { throw new Error('This chat is still on the old runner'); },
    evidence: async () => structuredClone(s.events),
  }});
  remote.start();
  const c = await remote.capture('thread', {heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: 1, confirmationSeq: 2});
  await remote.sync();
  assert.equal(c.status, 'synced');
  await assert.rejects(remote.capture('thread', {heard: 'Fabricated', replacement: 'Threadbear', sourceSeq: 1}), /source/i);
  remote.stop();
});

test('sync merges triggers without changing other entries, saves provenance and is idempotent', async () => {
  const s = setup();
  const seq = s.user('I meant Threadbear, not Threadbare.');
  const c = s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: seq });
  await s.service.sync();
  assert.equal(c.status, 'synced');
  assert.deepEqual(s.items()[0].triggers, ['thread bear', 'Threadbare']);
  assert.equal(s.items()[0].id, 'existing');
  assert.equal(s.writes.length, 1);
  assert.equal((s.writes[0] as { mode: string }).mode, 'append');
  assert.ok(c.backup && fs.existsSync(c.backup));
  assert.match(s.notes[0], /Threadbare.*Threadbear/);
  await s.service.sync();
  assert.equal(s.writes.length, 1);
  await s.service.decide(c.id, 'undo');
  assert.deepEqual(s.items()[0].triggers, ['thread bear']);
  assert.equal(c.status, 'undone');
});

test('a concurrent edit aborts before write; undo refuses to overwrite later user changes', async () => {
  const s = setup();
  const seq = s.user('I meant Threadbear, not Threadbare.');
  const c = s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: seq });
  s.concurrent(s.addManual);
  await s.service.sync();
  assert.equal(s.writes.length, 0);
  assert.equal(c.status, 'confirmed');
  assert.match(s.service.status().syncError!, /changed/i);
  s.concurrent(() => {});
  await s.service.sync();
  assert.ok(s.items()[0].triggers.includes('manual spelling'));
  s.addManual();
  await assert.rejects(s.service.decide(c.id, 'undo'), /changed/i);
  assert.equal(c.status, 'synced');
});

test('turning learning off or making its source private prevents queued sync', async () => {
  for (const change of ['makePrivate', 'disable'] as const) {
    const s = setup();
    const seq = s.user('I meant Threadbear, not Threadbare.');
    s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: seq });
    s[change]();
    await s.service.sync();
    assert.equal(s.writes.length, 0);
  }
});

test('an unavailable API queues confirmation and conflicting existing spellings are not overwritten', async () => {
  const s = setup();
  const seq = s.user('I meant Threadbare, not thread bear.');
  const c = s.service.record('thread', { heard: 'thread bear', replacement: 'Threadbare', sourceSeq: seq, confirmationSeq: seq });
  await s.service.sync();
  assert.equal(c.status, 'conflict');
  assert.equal(s.writes.length, 0);
  const offline = new DictationLearning({ home: tmpDir(), host: s.host, enabled: () => true, client: new FluidVoiceClient(async () => { throw new Error('API is off'); }) });
  offline.start();
  const queued = offline.record('thread', { heard: 'thread bear', replacement: 'Threadbare', sourceSeq: seq, confirmationSeq: seq });
  await offline.sync();
  assert.equal(queued.status, 'confirmed');
  assert.match(offline.status().syncError!, /API is off/);
});

test('an interrupted transaction is recovered without a second write after restart', async () => {
  const s = setup();
  const seq = s.user('I meant Threadbear, not Threadbare.');
  const c = s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: seq });
  await s.service.sync();
  const file = path.join(s.home, 'dictation-learning.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.corrections[0].status = 'confirmed'; // POST landed before the process saved its acknowledgement.
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = new DictationLearning({ home: s.home, host: s.host, enabled: () => true, client: s.client });
  again.start(); await again.sync();
  assert.equal(again.status().corrections[0].status, 'synced');
  assert.equal(s.writes.length, 1);
  assert.equal(again.status().corrections[0].id, c.id);
});

test('unsupported saved state is kept rather than erased, and a live writer lock is respected', async () => {
  const s = setup();
  const seq = s.user('I meant Threadbear, not Threadbare.');
  s.service.record('thread', { heard: 'Threadbare', replacement: 'Threadbear', sourceSeq: seq, confirmationSeq: seq });
  fs.writeFileSync(path.join(s.home, 'dictation-sync.lock'), String(process.pid));
  await s.service.sync(); assert.equal(s.writes.length, 0);
  const file = path.join(s.home, 'dictation-learning.json');
  fs.writeFileSync(file, '{corrupt');
  const again = new DictationLearning({ home: s.home, host: s.host, enabled: () => true, client: s.client });
  assert.throws(() => again.start(), /kept unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
});
