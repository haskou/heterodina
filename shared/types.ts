// Shapes exchanged between the API server and the browser.
// Nothing here may carry Plex keys, file paths or the token.

export interface Track {
  id: string;
  title: string;
  /** Track artist (falls back to the album artist). */
  artist: string;
  albumArtist: string;
  album: string;
  albumId: string;
  disc: number;
  index: number;
  durationMs: number;
  year: number | null;
  /** Same-origin URL of the cover, or null. */
  art: string | null;
  codec: string;
  /** Plex user rating, 0-10 (2 per star); null when unrated. */
  rating: number | null;
  /** False when the browser cannot decode the file (e.g. ALAC). */
  playable: boolean;
  /** Plex loudness analysis; null when unknown (e.g. search results). */
  loudness: Loudness | null;
  /** Shape of the start and end of the track; null when unknown (e.g. search results). */
  transition: TransitionProfile | null;
}

export interface Loudness {
  /** Track gain in dB to reach Plex's reference loudness. */
  gainDb: number;
  albumGainDb: number;
  /** Linear sample peak (1.0 = full scale). */
  peak: number;
  albumPeak: number;
}

/**
 * Where a track really starts and ends, derived once per track from
 * Plex's loudness curve. All values in seconds from the start of the file.
 */
export interface TransitionProfile {
  duration: number;
  /** First audible moment (leading silence ends). */
  leadIn: number;
  /** Last audible moment (trailing silence starts). */
  audioEnd: number;
  /** Where the track first reaches its body level: leadIn..introEnd is a fade-in or quiet intro. */
  introEnd: number;
  /** Where the track last holds its body level: outroStart..audioEnd is a fade-out or quiet tail. */
  outroStart: number;
}

/** An album as shown in a station's universe. */
export interface RadioAlbum {
  id: string;
  title: string;
  artist: string;
  art: string | null;
}

/** What a station is about: the seed's inferred (and user-corrected) universe. */
export interface RadioContext {
  seedAlbumId: string;
  /** Short names for the universe, most telling first (e.g. a game series, then its composer). */
  labels: string[];
  trackCount: number;
  albums: (RadioAlbum & { weight: number; reasons: string[] })[];
  /** Albums the user removed from this universe. */
  excluded: RadioAlbum[];
}

export interface RadioPick {
  track: Track;
  /** True when the pick deliberately steps outside the universe. */
  explored: boolean;
}

/** A Plex audio playlist, usable as the source of search and radio. */
export interface Playlist {
  id: string;
  title: string;
  count: number;
}
