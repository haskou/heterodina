import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from './app.ts';
import { Radio } from './radio.ts';
import { Library, rankSearch, toTrack } from './library.ts';
import { PlexClient, type PlexMetadata } from './plex.ts';
import { JsonStore } from './store.ts';

const TOKEN = 'secret-token-123';
const AUDIO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

const trackMeta = (id: string, title: string): PlexMetadata => ({
  ratingKey: id,
  type: 'track',
  title,
  grandparentTitle: 'Test Composer',
  originalTitle: 'Test Artist',
  parentTitle: 'Test Soundtrack Vol.3',
  parentRatingKey: '1001',
  parentIndex: 2,
  index: 1,
  duration: 107997,
  parentThumb: '/library/metadata/1001/thumb/1791099326',
  Media: [
    {
      audioCodec: 'flac',
      container: 'flac',
      Part: [
        {
          key: `/library/parts/${id}/1/file.flac`,
          container: 'flac',
          Stream: [{ id: 500, streamType: 2, gain: '-14.10', albumGain: '-13.00', peak: '1.000000', albumPeak: '0.990000' }],
        },
      ],
    },
  ],
});

const seen: IncomingMessage[] = [];
let levelRequests = 0;
const rateCalls: Record<string, string>[] = [];
const timelineCalls: { params: Record<string, string>; client: string | undefined; product: string | undefined }[] = [];
let plexServer: Server;
let app: Server;
let base = '';

before(async () => {
  plexServer = createServer((req, res) => {
    seen.push(req);
    const url = new URL(req.url ?? '/', 'http://plex');
    if (req.headers['x-plex-token'] !== TOKEN) {
      res.statusCode = 401;
      return res.end();
    }
    const json = (body: unknown): void => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ MediaContainer: body }));
    };
    if (url.pathname === '/library/sections') {
      return json({ Directory: [{ key: '2', type: 'movie', title: 'Películas' }, { key: '9', type: 'artist', title: 'Música' }] });
    }
    if (url.pathname === '/library/sections/9/search') {
      return json({ Metadata: [trackMeta('2', 'Morning Light Band Arrange'), trackMeta('1', 'Morning Light')] });
    }
    if (url.pathname === '/playlists') {
      return json({
        Metadata: [
          { ratingKey: '77', type: 'playlist', title: 'Chill', playlistType: 'audio', leafCount: 3 },
          { ratingKey: '78', type: 'playlist', title: 'Pelis', playlistType: 'video', leafCount: 9 },
        ],
      });
    }
    if (url.pathname === '/playlists/77/items') {
      // Two pages (page size 2000): checks paging without a huge fixture.
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      return json({ totalSize: 2001, Metadata: start === 0 ? [trackMeta('2', 'Morning Light Band Arrange')] : [trackMeta('9', 'Other')] });
    }
    if (url.pathname === '/library/metadata/1') return json({ Metadata: [trackMeta('1', 'Morning Light')] });
    if (url.pathname === '/library/metadata/404') return json({ Metadata: [] });
    if (url.pathname === '/library/streams/500/levels') {
      levelRequests++;
      // 1 s silence, ~106 s at -8, 1 s silence (10 values per second).
      return json({ Level: [...Array(10).fill(-39.9), ...Array(1060).fill(-8), ...Array(10).fill(-39.9)].map((v: number) => ({ v })) });
    }
    if (url.pathname === '/library/parts/1/1/file.flac') {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'audio/flac');
      if (!m) return res.end(AUDIO);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : AUDIO.length - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${AUDIO.length}`);
      return res.end(AUDIO.subarray(start, end + 1));
    }
    if (url.pathname === '/:/rate' && req.method === 'PUT') {
      rateCalls.push(Object.fromEntries(url.searchParams));
      return res.end();
    }
    if (url.pathname === '/:/timeline') {
      timelineCalls.push({
        params: Object.fromEntries(url.searchParams),
        client: req.headers['x-plex-client-identifier'] as string | undefined,
        product: req.headers['x-plex-product'] as string | undefined,
      });
      return res.end();
    }
    if (url.pathname === '/photo/:/transcode') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(Buffer.from('jpeg'));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => plexServer.listen(0, '127.0.0.1', r));
  const plexUrl = `http://127.0.0.1:${(plexServer.address() as AddressInfo).port}`;
  const plex = new PlexClient(plexUrl, TOKEN);
  const library = new Library(plex, 'musica', new JsonStore(null));
  app = createApp({ plex, library, radio: new Radio(library, new JsonStore(null), () => []) });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(() => {
  app.close();
  plexServer.close();
});

/** Fetches through the app and asserts the token never reaches the client. */
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; res: Response }> {
  const res = await fetch(base + path, { headers });
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(!body.includes(TOKEN), `token leaked in body of ${path}`);
  for (const [k, v] of res.headers) assert.ok(!v.includes(TOKEN) && !k.includes(TOKEN), `token leaked in header ${k}`);
  return { status: res.status, body, res };
}

test('search resolves the library by accent-insensitive name and ranks exact titles first', async () => {
  const { status, body } = await get('/api/search?q=morning%20light');
  assert.equal(status, 200);
  const tracks = JSON.parse(body.toString()) as { id: string; title: string; artist: string }[];
  assert.deepEqual(tracks.map((t) => t.title), ['Morning Light', 'Morning Light Band Arrange']);
  assert.equal(tracks[0]?.artist, 'Test Artist');
  assert.ok(!body.toString().includes('/library/parts/'), 'part keys must stay server-side');
});

test('playlists: audio only, and search can be limited to one', async () => {
  const lists = (await (await fetch(`${base}/api/playlists`)).json()) as { id: string; title: string; count: number }[];
  assert.deepEqual(lists, [{ id: '77', title: 'Chill', count: 3 }]);
  const within = (await (await fetch(`${base}/api/search?q=morning&playlist=77`)).json()) as { id: string }[];
  assert.deepEqual(within.map((t) => t.id), ['2']);
  assert.equal((await fetch(`${base}/api/search?q=morning&playlist=x`)).status, 400);
});

test('track detail includes loudness', async () => {
  const { status, body } = await get('/api/tracks/1');
  assert.equal(status, 200);
  const t = JSON.parse(body.toString());
  assert.deepEqual(t.loudness, { gainDb: -14.1, albumGainDb: -13, peak: 1, albumPeak: 0.99 });
  assert.equal(t.art, '/api/art?u=%2Flibrary%2Fmetadata%2F1001%2Fthumb%2F1791099326');
});

test('track detail includes the transition profile, analyzed once', async () => {
  const before = levelRequests;
  const t = JSON.parse((await get('/api/tracks/1')).body.toString());
  JSON.parse((await get('/api/tracks/1')).body.toString());
  assert.ok(Math.abs(t.transition.leadIn - 1) < 0.2);
  assert.ok(Math.abs(t.transition.audioEnd - 107) < 0.3);
  assert.ok(levelRequests - before <= 1, 'levels must be cached');
});

test('unknown and malformed ids', async () => {
  assert.equal((await get('/api/tracks/404')).status, 404);
  assert.equal((await get('/api/tracks/abc')).status, 400);
  assert.equal((await get('/api/audio/..%2Fsecret')).status, 400);
});

test('audio proxies byte ranges', async () => {
  const { status, body, res } = await get('/api/audio/1', { Range: 'bytes=10-19' });
  assert.equal(status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-19/${AUDIO.length}`);
  assert.equal(res.headers.get('content-type'), 'audio/flac');
  assert.deepEqual(body, AUDIO.subarray(10, 20));
  const full = await get('/api/audio/1');
  assert.equal(full.status, 200);
  assert.equal(full.body.length, AUDIO.length);
});

test('rating is forwarded to Plex and validated', async () => {
  const put = (body: string): Promise<Response> => fetch(`${base}/api/tracks/1/rating`, { method: 'PUT', body });
  assert.equal((await put('{"rating":8}')).status, 200);
  assert.equal((await put('{"rating":null}')).status, 200);
  assert.equal((await put('{"rating":11}')).status, 400);
  assert.equal((await put('{"rating":2.5}')).status, 400);
  assert.equal((await put('nope')).status, 400);
  assert.deepEqual(
    rateCalls.map((c) => [c.key, c.rating, c.identifier]),
    [
      ['1', '8', 'com.plexapp.plugins.library'],
      ['1', '-1', 'com.plexapp.plugins.library'],
    ],
  );
});

test('timeline reports reach Plex as the Heterodina player, one session per browser', async () => {
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/tracks/1/timeline`, { method: 'POST', body: JSON.stringify(body) });
  const ok = await post({ state: 'playing', time: 12345.6, duration: 107997, client: 'abcd-1234-ef' });
  assert.equal(ok.status, 204);
  const call = timelineCalls.at(-1)!;
  assert.deepEqual(
    { state: call.params.state, time: call.params.time, ratingKey: call.params.ratingKey, key: call.params.key, client: call.client, product: call.product },
    { state: 'playing', time: '12346', ratingKey: '1', key: '/library/metadata/1', client: 'heterodina-abcd-1234-ef', product: 'Heterodina' },
  );
  for (const bad of [
    { state: 'rewinding', time: 0, duration: 1, client: 'abcd-1234-ef' },
    { state: 'paused', time: -1, duration: 1, client: 'abcd-1234-ef' },
    { state: 'paused', time: 0, duration: 1, client: 'x' },
    { state: 'paused', time: 0, duration: 1, client: 'Bad Client!' },
  ]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(timelineCalls.length, 1);
});

test('art only accepts Plex metadata image paths', async () => {
  assert.equal((await get('/api/art?u=%2Flibrary%2Fmetadata%2F1001%2Fthumb%2F1791099326')).status, 200);
  assert.equal((await get('/api/art?u=http%3A%2F%2Fevil%2Fx')).status, 400);
  assert.equal((await get('/api/art?u=%2Flibrary%2Fparts%2F1%2F1%2Ffile.flac')).status, 400);
});

test('the token goes to Plex only as a header, never in the URL', () => {
  assert.ok(seen.length > 0);
  for (const req of seen) {
    assert.equal(req.headers['x-plex-token'], TOKEN);
    assert.ok(!(req.url ?? '').includes(TOKEN));
  }
});

test('toTrack marks ALAC as unplayable', () => {
  const meta = trackMeta('5', 'x');
  meta.Media = [{ audioCodec: 'alac', container: 'mp4', Part: [{ key: '/library/parts/5/1/file.m4a' }] }];
  const t = toTrack(meta);
  assert.equal(t.playable, false);
  assert.equal(t.loudness, null);
});

test('toTrack describes the file: depth/kHz when lossless, kbps when lossy', () => {
  const meta = trackMeta('6', 'x');
  meta.Media = [{ audioCodec: 'flac', bitrate: 2800, Part: [{ key: '/p', Stream: [{ streamType: 2, bitDepth: 24, samplingRate: 96000 }] }] }];
  assert.equal(toTrack(meta).format, 'FLAC 24/96');
  meta.Media = [{ audioCodec: 'flac', bitrate: 900, Part: [{ key: '/p', Stream: [{ streamType: 2, bitDepth: 16, samplingRate: 44100 }] }] }];
  assert.equal(toTrack(meta).format, 'FLAC 16/44.1');
  meta.Media = [{ audioCodec: 'mp3', bitrate: 320, Part: [{ key: '/p' }] }];
  assert.equal(toTrack(meta).format, 'MP3 320 kbps');
});

test('rankSearch keeps Plex order within a rank', () => {
  const mk = (title: string) => ({ ...toTrack(trackMeta(title, title)) });
  const ranked = rankSearch([mk('Re:Morning'), mk('Morning Band'), mk('morning')], 'Morning');
  assert.deepEqual(ranked.map((t) => t.title), ['morning', 'Morning Band', 'Re:Morning']);
});

test('radio next is a POST, so no cache can replay a draw', async () => {
  const post = (body: unknown): Promise<Response> => fetch(`${base}/api/radio/next`, { method: 'POST', body: JSON.stringify(body) });
  const ok = await post({ seed: '1', from: '1', recent: ['1'], playlist: null });
  assert.ok([200, 404].includes(ok.status), String(ok.status));
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await post({ seed: '../x', from: '1' })).status, 400);
  assert.equal((await post({ seed: '1', from: '1', playlist: 'x' })).status, 400);
  assert.equal((await fetch(`${base}/api/radio/next`, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await get('/api/radio/next?seed=1&from=1')).status, 404);
});
