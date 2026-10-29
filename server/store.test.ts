import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonStore } from './store.ts';

test('store: writes to disk and reads back', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'heterodina-')), 'a.json');
  const store = new JsonStore<number>(file);
  store.set('x', 1);
  store.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 1 });
  assert.equal(new JsonStore<number>(file).get('x'), 1);
});

test('store: an unwritable folder keeps the data in memory instead of throwing', (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere');
  const dir = mkdtempSync(join(tmpdir(), 'heterodina-'));
  chmodSync(dir, 0o500);
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: string) => errors.push(m));
  try {
    const store = new JsonStore<number>(join(dir, 'a.json'));
    store.set('x', 1);
    assert.doesNotThrow(() => store.flush());
    assert.doesNotThrow(() => store.flush());
    assert.equal(store.get('x'), 1);
    assert.equal(errors.length, 1, 'warns once');
    assert.match(errors[0] ?? '', /EACCES/);
  } finally {
    chmodSync(dir, 0o700);
  }
});
