# Architecture

[← Back to the README](../README.md) · [Getting started](getting-started.md) · [How transitions work](transitions.md)

```
browser ──/api──▶ server (Node) ──X-Plex-Token──▶ Plex
```

## Server (`server/`)

- **Endpoints**
  - `/api/search?q=`: search.
  - `/api/playlists`: Plex audio playlists.
  - `/api/suggestions`: varied starting points.
  - `/api/tracks/:id`: track detail with loudness and transition profile.
  - `PUT /api/tracks/:id/rating`: star rating.
  - `/api/radio/next?seed=&from=&recent=`: next radio track.
  - `/api/radio/context?seed=`: the radio's universe.
  - `PUT /api/radio/universe/:seedAlbum/albums/:album`: remove (`{"excluded":true}`) or add/restore an album.
  - `/api/audio/:id`: proxy for the original file, with `Range`.
  - `/api/art?u=&s=`: cover art, resized by Plex once and then served from `.cache/art`.
  - `/api/status`: whether the first index is still building, and how many tracks are analysed or waiting (the player's "processing your library" notice).
  - Search, suggestions and radio accept `playlist=<id>` to use only that playlist's tracks.
- **Token:** only sent as a header between server and Plex. Tests check that it never appears in a response.
- **Search** (`search-index.ts`, `romaji.ts`):
  - At startup (retrying until Plex answers), and every 30 minutes after that, it loads every track and keeps each field's original text plus its romaji reading. Kanji readings come from kuromoji's dictionary.
  - Matching folds romanization variants: long vowels (`toukyou` = `tokyo` = `tōkyō`), `tch`/`cch`, and `m`/`n` before b/p.
  - Every query word must appear in the title, artist or album.
- **Transition profile** (`analysis.ts`):
  - Derived from Plex's loudness curve (`/library/streams/{id}/levels`, 10 values per second). No audio decoding is needed, so it also works for long tracks.
  - It marks where the sound starts and ends, where the track reaches its body level, and where it leaves it.
  - It also measures the normalized loudness of the first and last 10 s.
  - Each track is analysed once and cached in `.cache/transitions.json`.
- **Universe** (`universe.ts`):
  - Inferred per seed album from Plex metadata, up to two hops from the seed. Evidence:
    - shared track titles, which link soundtracks with their arrangements;
    - performers;
    - album artist;
    - label;
    - rare words in album titles (Japanese nouns are segmented with kuromoji).
  - Below 80 tracks it widens to the label, then to the genre, with lower weight.
  - User corrections are stored per seed album in `.cache/universe-overrides.json`.
- **Radio** (`radio.ts`):
  - About 88% of picks come from the universe. The rest explore among Plex's sonic neighbours outside it, and more often when the universe runs short of fresh tracks.
  - Score: sonic closeness to what just played (`/nearest`, so the station drifts naturally) × universe weight × star preference.
  - Star preference: 3★ ×1.3, 4★ ×1.6, 5★ ×2. Unrated and 2★ tracks are neutral; 1★ tracks never play.
  - Variety:
    - never repeats a song from the last 120, even as another copy;
    - penalizes the same album or artist played recently;
    - penalizes another arrangement of the same composition within 60 tracks;
    - draws among the best 14 candidates instead of always taking the first.
  - Edge fit: the best ~20 candidates are re-ranked by how well their start follows the current track's end.
    - It compares the normalized loudness of the outgoing track's last 10 s with the candidate's first 10 s.
    - A loud ending into a quiet start is penalized hard; a lift is penalized less.
  - Tempo (`tempo.ts`): candidates whose start can beat-lock with the current ending (same, double or half tempo) are preferred.
    - Plex stores no BPM. For each track, Plex transcodes 20 s of the start and of the end to MP3; this works for any codec and from any offset.
    - The server decodes them with `mpg123-decoder` (WASM) and runs the same beat detector as the player.
    - The transcoder only serves clients it has made a decision for (`/music/:/transcode/universal/decision`).
    - Concurrent decisions under one client identity cut each other's streams, so each worker has its own identity.
    - Closing the connection does not end a transcode, so every window ends with `/stop`.
    - Results are cached in `.cache/tempo.json`.
    - A pick's shortlist is analysed at once, up to 3 tracks at a time, and the pick waits at most 4 s for it. Unanalysed tracks score between compatible and clashing.
    - A new station's universe is analysed in the background: one track at a time, a 6 s rest after each, and the process runs at lower priority (nice 10), so Plex and the rest of the machine go first.
  - Playlists as source: universe, exploration and fallback are limited to the playlist's tracks, and Plex evaluates smart playlists itself.
    - Items are read in pages of 2,000. One large request can take minutes; pages take seconds.
    - Items are cached for 10 minutes and refreshed in the background. The browser warms the cache as soon as a playlist is selected.
- **Suggestions:** a sample of the source, drawn one track at a time.
  - Each pick avoids the universes, album artists, labels and genres already chosen.
  - Starred tracks come up more often.
  - The next set is prepared in the background, and one is ready at startup.

## Browser (`web/src/`)

- **Engine** (`engine.ts`, `voice.ts`):
  - One tab plays at a time: a `BroadcastChannel` pauses the others.
  - As soon as a track starts, the engine loads the next one and plans the transition.
  - Start, fades, EQ and stop are scheduled on the `AudioContext` clock, so timing stays exact in a background tab.
  - Tracks up to 12 minutes are decoded whole, with sample-exact timing. Longer ones stream through an `<audio>` element to keep memory bounded.
- **Mix** (`shared/mix.ts`, `shared/features.ts`, `shared/stretch.ts`, `mixer.ts`): every transition that isn't gapless, with nothing to configure. See [How transitions work](transitions.md) for the full pipeline.
- **Fallback crossfade** (`shared/transition.ts`, `shared/beat.ts`): equal-power overlap with a bass swap, for tracks that stream or windows that don't fit. Also in [How transitions work](transitions.md#fallback-crossfade).
- **Normalization:** Plex track gain, or album gain between consecutive tracks, never letting peaks exceed 0 dBFS.
- **Theme:**
  - Colours come from the cover (k-means on 48×48 pixels). The background takes the main colour, darkened just enough for light text, and the accent takes a second colour.
  - Colours transition through registered CSS custom properties (`@property`).
- **i18n** (`i18n.ts`): English, Spanish and Japanese, chosen from `navigator.languages`. Static markup is filled through `data-i18n*` attributes.
- **Media Session:** a silent looping `<audio>` element anchors it, because Chromium only routes media keys to pages with a playing media element.

## Plex API notes

Verified against a real server (1.43):

| Endpoint | Behaviour |
|---|---|
| `/library/metadata/{id}/nearest` | Works and returns `distance`. At most ~900 results. |
| `/library/streams/{id}/levels` | Works. 404 when the track is not analysed. |
| `PUT /:/rate` | Scale 0–10; `-1` clears. |
| `track.sonicallySimilar` filter | Ignored. |
| `/library/metadata/{track}/similar` | 404. |
| `/playlists/{id}/items` | Must be paged for large playlists. |
| Universal music transcoder | Always outputs MP3, accepts `offset`, and needs a decision first. |

ALAC files cannot be decoded by browsers. They show as unavailable, and the radio skips them.
