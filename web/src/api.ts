import type { Playlist, RadioContext, RadioPick, ServerStatus, Track } from '../../shared/types.ts';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** `&playlist=…` when a playlist is the source, else nothing. */
const within = (playlist: string | null): string => (playlist ? `&playlist=${playlist}` : '');

export const api = {
  status: () => getJson<ServerStatus>('/api/status'),
  playlists: () => getJson<Playlist[]>('/api/playlists'),
  /** Varied starting points from the current source. */
  suggestions: (playlist: string | null) => getJson<Track[]>(`/api/suggestions?${within(playlist).slice(1)}`),
  search: (q: string, playlist: string | null, signal?: AbortSignal) =>
    getJson<Track[]>(`/api/search?q=${encodeURIComponent(q)}${within(playlist)}`, signal),
  track: (id: string) => getJson<Track>(`/api/tracks/${id}`),
  rate: async (id: string, rating: number | null): Promise<void> => {
    const res = await fetch(`/api/tracks/${id}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating }),
    });
    if (!res.ok) throw new Error(`rating: HTTP ${res.status}`);
  },
  /** Next track of the station seeded with `seed`, after `from`, avoiding `recent`; null when nothing fits. */
  radioNext: async (seed: string, from: string, recent: string[], playlist: string | null): Promise<RadioPick | null> => {
    const res = await fetch(`/api/radio/next?seed=${seed}&from=${from}&recent=${recent.join(',')}${within(playlist)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`radio: HTTP ${res.status}`);
    return (await res.json()) as RadioPick;
  },
  /** The station's universe; null while the library index is still loading. */
  radioContext: async (seed: string): Promise<RadioContext | null> => {
    const res = await fetch(`/api/radio/context?seed=${seed}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`radio context: HTTP ${res.status}`);
    return (await res.json()) as RadioContext;
  },
  /** Removes an album from (or adds it back to) the universe of a station. */
  correctUniverse: async (seedAlbumId: string, albumId: string, excluded: boolean): Promise<void> => {
    const res = await fetch(`/api/radio/universe/${seedAlbumId}/albums/${albumId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded }),
    });
    if (!res.ok) throw new Error(`universe: HTTP ${res.status}`);
  },
  audioUrl: (id: string) => `/api/audio/${id}`,
  artUrl: (art: string, size: number) => `${art}&s=${size}`,
};
