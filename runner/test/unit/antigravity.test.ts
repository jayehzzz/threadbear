import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACP_AGENTS, acpAccounts, antigravitySchema } from '../../src/adapters/acp/agents.ts';
import { activeProviders, providerInfo } from '../../src/providers.ts';
import { loadConfig } from '../../src/config.ts';

test('Antigravity is an ACP provider with its own official login command', () => {
  assert.equal(providerInfo('antigravity').name, 'Antigravity');
  assert.equal(providerInfo('antigravity').loginCommand, 'agy acp --login');
  assert.equal(providerInfo('antigravity').smallJobs, false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agy-'));
  try {
    assert.ok(!activeProviders(root).includes('antigravity'));
    fs.writeFileSync(path.join(root, 'runner.json'), JSON.stringify({ experiments: { acpAgents: true } }));
    assert.ok(activeProviders(root).includes('antigravity'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Antigravity MCP declarations omit dictionary keywords without removing named arguments', () => {
  const original = { type: 'object', description: 'Verbose declaration', properties: { propertyNames: { type: 'string', description: 'Keep the field name' }, findings: { type: 'array', items: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} } } }, additionalProperties: false };
  assert.deepEqual(antigravitySchema(original), { type: 'object', properties: { propertyNames: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } });
  assert.equal(original.additionalProperties, false, 'declarations do not mutate the original validation schema');
});

test('Antigravity uses a strict separate profile without changing terminal settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agy-'));
  try {
    const terminal = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    fs.mkdirSync(path.dirname(terminal), { recursive: true });
    fs.writeFileSync(terminal, '{"toolPermission":"always-proceed"}');
    const agent = ACP_AGENTS.antigravity;
    agent.prepare!(home);
    const file = path.join(agent.configDir(home), 'settings.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { toolPermission: 'strict', agentMode: '' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(terminal, 'utf8'), '{"toolPermission":"always-proceed"}');
    assert.ok(agent.args.includes('--process-per-session'), 'client HTTP MCP tools require a worker');
    assert.ok(!agent.args.includes('--dangerously-skip-permissions'));
    assert.equal(agent.modeFor('full'), 'default');
    assert.equal(agent.modeFor('ask'), 'default');
    assert.equal(agent.modeFor('auto'), 'default');
    assert.equal(agent.modeFor('plan'), 'plan');
    fs.writeFileSync(file, '{"toolPermission":"always-proceed"}');
    agent.prepare!(home);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).toolPermission, 'strict', 'reset before every new process');
    fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ antigravityPath: '~/.local/bin/agy' }));
    const cfg = loadConfig({ THREADBEAR_HOME: home }, { readOnly: true });
    assert.equal(cfg.antigravityPath, path.join(os.homedir(), '.local', 'bin', 'agy'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Antigravity is discovered without opening credentials, including before login', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agy-'));
  try {
    const bin = path.join(root, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    const account = acpAccounts({ home: root, pathEnv: '' }).find((a) => a.provider === 'antigravity');
    assert.equal(account?.id, 'antigravity-main');
    assert.equal(account?.configDir, path.join(root, '.gemini', 'threadbear-acp'));
    assert.equal(ACP_AGENTS.antigravity.findBinary({ explicit: './agy', home: root, pathEnv: '' }), undefined);
    assert.ok(ACP_AGENTS.antigravity.identifies({ agentInfo: { name: 'Antigravity ACP Server' } }));
    assert.ok(!ACP_AGENTS.antigravity.identifies({ agentInfo: { name: 'OpenCode' } }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
