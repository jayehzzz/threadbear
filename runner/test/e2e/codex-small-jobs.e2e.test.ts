// Tiny real-model checks for the same Codex asker the live runner uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAsker } from '../../src/models/codex-oneshot.ts';
import { fallbackCodexPath } from '../../src/adapters/codex/appserver.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';

const skip = process.env.TB_E2E_SKIP_CODEX === '1';
test('Codex small jobs: real title and structured librarian result, no persistent thread', { skip, timeout: 150_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-small-e2e-'));
  const registry = new ProcessRegistry(root, nullLogger);
  const marker = path.join(root, 'notification-must-not-run');
  const notify = JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]);
  const ask = codexAsker({ args: ['-c', `notify=${notify}`], binary: () => process.env.TB_E2E_CODEX_BINARY ?? fallbackCodexPath(), registry, log: nullLogger });
  const common = { account: { id: 'codex-main', title: 'Codex', provider: 'codex' as const, configDir: path.join(os.homedir(), '.codex') }, model: process.env.TB_E2E_CODEX_MODEL ?? 'gpt-6-luna', cwd: path.join(root, 'work'), timeoutMs: 60_000 };
  try {
    const title = await ask({ ...common, system: 'Give a title of three to six words. Only the title.', user: 'Fixing the login button on a website.' });
    assert.ok(title.ok, !title.ok ? title.message : '');
    assert.ok(title.text.trim().split(/\s+/).length <= 8, title.text);
    assert.ok(title.model?.startsWith('gpt-'));
    console.log(`Codex title: ${title.text.trim()} (${title.model}, ${title.inputTokens} input tokens)`);
    const structured = await ask({ ...common, system: 'Extract the project name and owner. Use null when the owner is not given.', user: 'I am working on Threadbear.', jsonSchema: { type: 'object', properties: { project: { type: 'string' }, owner: { type: ['string', 'null'] } }, required: ['project', 'owner'], additionalProperties: false } });
    assert.ok(structured.ok, !structured.ok ? structured.message : '');
    assert.deepEqual(JSON.parse(structured.text), { project: 'Threadbear', owner: null });
    assert.deepEqual(registry.pids(), []);
    assert.equal(fs.existsSync(marker), false, 'the inherited notifier never runs');
    console.log(`Codex librarian JSON: ${structured.text.trim()} (${structured.inputTokens} input tokens)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
