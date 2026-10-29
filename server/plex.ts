// Thin Plex HTTP client. The token travels only in a request header from
// this process to the Plex server; it never appears in URLs we build.

export interface PlexTag {
  tag: string;
}

export interface PlexStream {
  id?: number | string;
  streamType?: number;
  gain?: string;
  albumGain?: string;
  peak?: string;
  albumPeak?: string;
  bitDepth?: number;
  samplingRate?: number;
}

export interface PlexPart {
  key: string;
  container?: string;
  Stream?: PlexStream[];
}

export interface PlexMedia {
  audioCodec?: string;
  container?: string;
  /** kbps. */
  bitrate?: number;
  Part?: PlexPart[];
}

export interface PlexMetadata {
  ratingKey: string;
  type: string;
  title: string;
  originalTitle?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  parentTitle?: string;
  parentRatingKey?: string;
  parentIndex?: number;
  parentYear?: number;
  index?: number;
  duration?: number;
  /** Sonic distance, only in /nearest results. */
  distance?: number;
  /** 0-10 (half stars), absent when unrated. */
  userRating?: number;
  thumb?: string;
  parentThumb?: string;
  /** Album label. */
  studio?: string;
  year?: number;
  Genre?: PlexTag[];
  Media?: PlexMedia[];
  /** Playlists: number of items and kind. */
  leafCount?: number;
  playlistType?: string;
}

export interface PlexDirectory {
  key: string;
  type: string;
  title: string;
}

export interface MediaContainer {
  size?: number;
  totalSize?: number;
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[];
  /** Loudness curve from /library/streams/{id}/levels. */
  Level?: { v: number }[];
}

export class PlexError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class PlexClient {
  readonly #base: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#base = baseUrl;
    this.#token = token;
  }

  url(path: string, params: Record<string, string | number> = {}): URL {
    const url = new URL(path, this.#base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url;
  }

  async json(path: string, params: Record<string, string | number> = {}): Promise<MediaContainer> {
    const res = await this.fetch(path, params, { Accept: 'application/json' });
    if (!res.ok) throw new PlexError(res.status, `Plex ${res.status} for ${path}`);
    // text() decodes with replacement, which matters: some tags in the
    // library hold invalid UTF-8 that a strict JSON parse would reject.
    const body = JSON.parse(await res.text()) as { MediaContainer?: MediaContainer };
    return body.MediaContainer ?? {};
  }

  async put(path: string, params: Record<string, string | number> = {}): Promise<void> {
    const res = await this.fetch(path, params, {}, undefined, 'PUT');
    await res.body?.cancel();
    if (!res.ok) throw new PlexError(res.status, `Plex ${res.status} for PUT ${path}`);
  }

  fetch(
    path: string,
    params: Record<string, string | number> = {},
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    method = 'GET',
  ): Promise<Response> {
    const init: RequestInit = { method, headers: { ...headers, 'X-Plex-Token': this.#token } };
    if (signal) init.signal = signal;
    return fetch(this.url(path, params), init);
  }
}
