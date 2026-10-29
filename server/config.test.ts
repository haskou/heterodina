import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const KEYS = ['PLEX_URL', 'PLEX_TOKEN', 'PLEX_LIBRARY'] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => void): void {
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('config: works without a .env file, from the environment alone', () => {
  withEnv({ PLEX_URL: 'http://plex:32400/', PLEX_TOKEN: 't' }, () => {
    const c = loadConfig(join(tmpdir(), 'heterodina-missing.env'));
    assert.equal(c.plexUrl, 'http://plex:32400');
    assert.equal(c.plexToken, 't');
  });
});

test('config: the environment wins over .env, which fills the gaps', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'heterodina-')), '.env');
  writeFileSync(file, 'PLEX_URL=http://file:32400\nPLEX_TOKEN=file\nPLEX_LIBRARY=Songs\n');
  withEnv({ PLEX_URL: 'http://env:32400', PLEX_TOKEN: 'env' }, () => {
    const c = loadConfig(file);
    assert.equal(c.plexUrl, 'http://env:32400');
    assert.equal(c.plexToken, 'env');
    assert.equal(c.plexLibrary, 'Songs');
  });
});
