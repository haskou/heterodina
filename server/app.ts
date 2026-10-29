import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ArtCache } from './art-cache.ts';
import { isArtPath, type Library } from './library.ts';
import type { PlexClient } from './plex.ts';
import type { Radio } from './radio.ts';
import type { ServerStatus } from '../shared/types.ts';
import type { TempoAnalyzer } from './tempo.ts';

const ID = /^\d+$/;
/** A browser's player id, sent with timeline reports. */
const CLIENT = /^[a-z0-9-]{8,64}$/;
/** A resize that takes longer than this is stuck; it is retried. */
const ART_TIMEOUT_MS = 20_000;

/** Upstream headers worth forwarding for audio; everything else is dropped. */
const AUDIO_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface AppDeps {
  plex: PlexClient;
  library: Library;
  radio: Radio;
  /** Background tempo analysis, reported by /api/status. */
  tempo?: TempoAnalyzer;
  /** Resized covers on disk; none when absent. */
  artCache?: ArtCache;
  /** Built front-end to serve in production; skipped when absent. */
  staticDir?: string;
}

export function createApp({ plex, library, radio, tempo, artCache = new ArtCache(null), staticDir }: AppDeps): Server {
  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // Log the message only: Plex errors never contain the token, but
      // a full error object could carry request internals.
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${(err.cause as NodeJS.ErrnoException).code ?? err.cause.message})` : '';
      console.error(`[api] ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}${cause}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream error' });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;

    const ratingMatch = /^\/api\/tracks\/([^/]+)\/rating$/.exec(path);
    if (ratingMatch && req.method === 'PUT') return setRating(req, res, ratingMatch[1] ?? '');
    const timelineMatch = /^\/api\/tracks\/([^/]+)\/timeline$/.exec(path);
    if (timelineMatch && req.method === 'POST') return reportTimeline(req, res, timelineMatch[1] ?? '');
    const universeMatch = /^\/api\/radio\/universe\/([^/]+)\/albums\/([^/]+)$/.exec(path);
    if (universeMatch && req.method === 'PUT') return correctUniverse(req, res, universeMatch[1] ?? '', universeMatch[2] ?? '');

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    if (path === '/api/health') return sendJson(res, 200, { ok: true });
    if (path === '/api/status') {
      const status: ServerStatus = { indexing: !library.indexed, ...(tempo?.progress() ?? { analysed: 0, waiting: 0 }) };
      return sendJson(res, 200, status);
    }

    if (path === '/api/playlists') return sendJson(res, 200, await library.playlists());

    // Optional `playlist`: search and radio only use that playlist's tracks.
    const playlist = url.searchParams.get('playlist');
    if (playlist !== null && !ID.test(playlist)) return sendJson(res, 400, { error: 'bad playlist' });
    const pool = playlist ? await library.playlistTracks(playlist) : undefined;

    if (path === '/api/search') {
      return sendJson(res, 200, await library.search(url.searchParams.get('q') ?? '', 40, pool));
    }

    if (path === '/api/radio/next') {
      const seed = url.searchParams.get('seed') ?? '';
      const from = url.searchParams.get('from') ?? '';
      if (!ID.test(seed) || !ID.test(from)) return sendJson(res, 400, { error: 'bad id' });
      const recent = (url.searchParams.get('recent') ?? '').split(',').filter((id) => ID.test(id)).slice(-200);
      const pick = await radio.next(seed, from, recent, pool);
      if (!pick) return sendJson(res, 404, { error: 'nothing to play' });
      // Full track (loudness, transition profile) so the player can plan the fade.
      const track = await library.track(pick.track.id);
      return track ? sendJson(res, 200, { ...pick, track }) : sendJson(res, 404, { error: 'nothing to play' });
    }

    if (path === '/api/suggestions') return sendJson(res, 200, await radio.suggestions(pool, playlist ?? ''));

    if (path === '/api/radio/context') {
      const seed = url.searchParams.get('seed') ?? '';
      if (!ID.test(seed)) return sendJson(res, 400, { error: 'bad id' });
      const context = radio.context(seed);
      return context ? sendJson(res, 200, context) : sendJson(res, 404, { error: 'not ready' });
    }

    const trackMatch = /^\/api\/tracks\/([^/]+)$/.exec(path);
    if (trackMatch) {
      const id = trackMatch[1] ?? '';
      if (!ID.test(id)) return sendJson(res, 400, { error: 'bad id' });
      const track = await library.track(id);
      return track ? sendJson(res, 200, track) : sendJson(res, 404, { error: 'not found' });
    }

    const audioMatch = /^\/api\/audio\/([^/]+)$/.exec(path);
    if (audioMatch) return proxyAudio(req, res, audioMatch[1] ?? '');

    if (path === '/api/art') return proxyArt(req, res, url);

    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return serveStatic(res, path);
  }

  async function setRating(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!ID.test(id)) return sendJson(res, 400, { error: 'bad id' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, 1024));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const rating = (body as { rating?: unknown } | null)?.rating;
    if (rating !== null && !(Number.isInteger(rating) && (rating as number) >= 0 && (rating as number) <= 10)) {
      return sendJson(res, 400, { error: 'rating must be an integer 0-10 or null' });
    }
    await library.rate(id, rating as number | null);
    return sendJson(res, 200, { rating });
  }

  async function reportTimeline(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!ID.test(id)) return sendJson(res, 400, { error: 'bad id' });
    let body: { state?: unknown; time?: unknown; duration?: unknown; client?: unknown } | null;
    try {
      body = JSON.parse(await readBody(req, 1024)) as typeof body;
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const { state, time, duration, client } = body ?? {};
    const ms = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9;
    if ((state !== 'playing' && state !== 'paused' && state !== 'stopped') || !ms(time) || !ms(duration) || typeof client !== 'string' || !CLIENT.test(client)) {
      return sendJson(res, 400, { error: 'bad timeline' });
    }
    await library.timeline(id, client, state, time, duration);
    res.statusCode = 204;
    res.end();
  }

  async function correctUniverse(req: IncomingMessage, res: ServerResponse, seedAlbumId: string, albumId: string): Promise<void> {
    if (!ID.test(seedAlbumId) || !ID.test(albumId)) return sendJson(res, 400, { error: 'bad id' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, 1024));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const excluded = (body as { excluded?: unknown } | null)?.excluded;
    if (typeof excluded !== 'boolean') return sendJson(res, 400, { error: 'excluded must be a boolean' });
    radio.correct(seedAlbumId, albumId, excluded);
    return sendJson(res, 200, { excluded });
  }

  async function proxyAudio(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!ID.test(id)) return sendJson(res, 400, { error: 'bad id' });
    const source = await library.audioSource(id);
    if (!source) return sendJson(res, 404, { error: 'not found' });

    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (typeof req.headers['if-range'] === 'string') headers['If-Range'] = req.headers['if-range'];

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await plex.fetch(source.partKey, {}, headers, abort.signal);
    if (upstream.status !== 200 && upstream.status !== 206) {
      await upstream.body?.cancel();
      return sendJson(res, upstream.status === 416 ? 416 : 502, { error: 'audio unavailable' });
    }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', source.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    for (const name of AUDIO_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    await pipe(req, res, upstream);
  }

  async function proxyArt(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const artPath = url.searchParams.get('u') ?? '';
    if (!isArtPath(artPath)) return sendJson(res, 400, { error: 'bad art path' });
    const size = Math.min(Math.max(Number(url.searchParams.get('s')) || 300, 32), 1200);
    const art = await artCache.get(artPath, size, async () => {
      const upstream = await plex.fetch('/photo/:/transcode', {
        width: size,
        height: size,
        minSize: 1,
        upscale: 1,
        url: artPath,
      }, {}, AbortSignal.timeout(ART_TIMEOUT_MS));
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return null;
      }
      return { type: upstream.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await upstream.arrayBuffer()) };
    });
    if (!art) return sendJson(res, 404, { error: 'no art' });
    res.statusCode = 200;
    res.setHeader('Content-Type', art.type);
    res.setHeader('Content-Length', art.body.length);
    // The path changes whenever the image does.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(req.method === 'HEAD' ? undefined : art.body);
  }

  function serveStatic(res: ServerResponse, path: string): void {
    if (!staticDir) return sendJson(res, 404, { error: 'not found' });
    const root = resolve(staticDir);
    let file = resolve(join(root, normalize(decodeURIComponent(path))));
    if (!file.startsWith(root)) return sendJson(res, 400, { error: 'bad path' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    res.statusCode = 200;
    res.setHeader('Content-Type', STATIC_TYPES[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  }
}

async function pipe(req: IncomingMessage, res: ServerResponse, upstream: Response): Promise<void> {
  if (req.method === 'HEAD' || !upstream.body) {
    await upstream.body?.cancel();
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
  await new Promise<void>((done) => {
    body.on('error', () => res.destroy());
    res.on('close', done);
    body.pipe(res);
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}
