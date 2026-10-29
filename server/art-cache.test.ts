import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtCache, type Art } from './art-cache.ts';

const jpeg: Art = { type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 1, 2, 3]) };

test('art cache: Plex resizes a cover once, then it comes from disk, across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heterodina-art-'));
  let calls = 0;
  const fetch = async (): Promise<Art> => {
    calls++;
    return jpeg;
  };
  const cache = new ArtCache(dir);
  // A burst of identical requests: one fetch.
  const [a, b] = await Promise.all([cache.get('/library/metadata/1/thumb/9', 300, fetch), cache.get('/library/metadata/1/thumb/9', 300, fetch)]);
  assert.equal(calls, 1);
  assert.deepEqual(a?.body, jpeg.body);
  assert.deepEqual(b?.body, jpeg.body);
  const again = await new ArtCache(dir).get('/library/metadata/1/thumb/9', 300, fetch);
  assert.equal(calls, 1);
  assert.equal(again?.type, 'image/jpeg');
  // Another size is another image.
  await cache.get('/library/metadata/1/thumb/9', 80, fetch);
  assert.equal(calls, 2);
});

test('art cache: a missing cover is not stored', async () => {
  const cache = new ArtCache(mkdtempSync(join(tmpdir(), 'heterodina-art-')));
  let calls = 0;
  const none = async (): Promise<null> => {
    calls++;
    return null;
  };
  assert.equal(await cache.get('/library/metadata/2/thumb/1', 300, none), null);
  assert.equal(await cache.get('/library/metadata/2/thumb/1', 300, none), null);
  assert.equal(calls, 2);
});
