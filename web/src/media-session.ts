// System media integration (media keys, OS now-playing). Chromium only
// routes media keys to pages with a playing media element, and our audio
// comes from Web Audio, so a silent looping <audio> stands in as the
// "player" the OS sees. It is never connected to the audio graph.

import type { Track } from '../../shared/types.ts';
import { api } from './api.ts';

export interface MediaHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(seconds: number): void;
  seekBy(seconds: number): void;
}

export class MediaSession {
  readonly #anchor = new Audio(silentWav());
  readonly #session: globalThis.MediaSession | null = 'mediaSession' in navigator ? navigator.mediaSession : null;

  constructor(handlers: MediaHandlers) {
    this.#anchor.loop = true;
    const s = this.#session;
    if (!s) return;
    const on = (action: MediaSessionAction, fn: MediaSessionActionHandler): void => {
      try {
        s.setActionHandler(action, fn);
      } catch {
        // Action not supported by this browser.
      }
    };
    on('play', () => handlers.play());
    on('pause', () => handlers.pause());
    on('nexttrack', () => handlers.next());
    on('previoustrack', () => handlers.previous());
    on('seekto', (d) => d.seekTime !== undefined && handlers.seekTo(d.seekTime));
    on('seekforward', (d) => handlers.seekBy(d.seekOffset ?? 10));
    on('seekbackward', (d) => handlers.seekBy(-(d.seekOffset ?? 10)));
  }

  track(track: Track | null): void {
    if (!this.#session) return;
    this.#session.metadata = track
      ? new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album,
          artwork: track.art ? [{ src: api.artUrl(track.art, 512), sizes: '512x512', type: 'image/jpeg' }] : [],
        })
      : null;
  }

  playing(isPlaying: boolean): void {
    if (isPlaying) void this.#anchor.play().catch(() => {});
    else this.#anchor.pause();
    if (this.#session) this.#session.playbackState = isPlaying ? 'playing' : 'paused';
  }

  position(position: number, duration: number): void {
    if (!this.#session || !(duration > 0)) return;
    try {
      this.#session.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 });
    } catch {
      // Ignore transient invalid states during transitions.
    }
  }
}

/** One second of silent 8 kHz mono PCM. */
function silentWav(): string {
  const samples = 8000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
