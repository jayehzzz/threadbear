import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';

function executable(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

test('Claude discovery finds a Homebrew/npm symlink on PATH when the native install is absent', (t) => {
  const home = tmpDir();
  t.mock.method(os, 'homedir', () => home);
  const bin = path.join(home, 'opt', 'homebrew', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const target = executable(path.join(home, 'opt', 'homebrew', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  const link = path.join(bin, 'claude');
  fs.symlinkSync(path.relative(bin, target), link);
  assert.equal(loadConfig({ THREADBEAR_HOME: home, PATH: bin }).claudePath, link);
  const h = makeHarness(undefined, { claudePath: link });
  assert.deepEqual(h.runner.noticesForNewClient(), []);
});

test('Claude discovery prefers the native install and keeps explicit paths authoritative', (t) => {
  const home = tmpDir();
  t.mock.method(os, 'homedir', () => home);
  const native = executable(path.join(home, '.local', 'bin', 'claude'));
  const other = executable(path.join(home, 'bin', 'claude'));
  const env = { THREADBEAR_HOME: home, PATH: path.dirname(other) };
  assert.equal(loadConfig(env).claudePath, native);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ claudePath: '~/chosen/claude' }));
  assert.equal(loadConfig(env).claudePath, path.join(home, 'chosen', 'claude'));
  assert.equal(loadConfig({ ...env, THREADBEAR_CLAUDE_PATH: '/missing/explicit-claude' }).claudePath, '/missing/explicit-claude');
});

test('Claude discovery skips broken links, directories, nonexecutables and relative PATH entries', (t) => {
  const home = tmpDir();
  t.mock.method(os, 'homedir', () => home);
  const native = path.join(home, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync('/nonexistent/claude', native);
  const directory = path.join(home, 'directory');
  fs.mkdirSync(path.join(directory, 'claude'), { recursive: true });
  const plain = executable(path.join(home, 'plain', 'claude'));
  fs.chmodSync(plain, 0o644);
  const good = executable(path.join(home, 'good', 'claude'));
  const env = { THREADBEAR_HOME: home, PATH: ['', '.', 'relative', directory, path.dirname(plain), path.dirname(good)].join(path.delimiter) };
  assert.equal(loadConfig(env).claudePath, good);
  fs.unlinkSync(good);
  assert.equal(loadConfig(env).claudePath, native, 'the diagnostic still names the native path when nothing is installed');
});

test('a missing Claude notice describes only Claude turns', () => {
  const h = makeHarness();
  const notice = h.runner.noticesForNewClient().find((n) => /claude CLI isn't at/.test(n.message));
  assert.ok(notice);
  assert.match(notice.message, /Claude turns cannot start/);
  assert.doesNotMatch(notice.message, /no turn can start/);
});
