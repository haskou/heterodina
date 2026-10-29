# Heterodina

**Your Plex music library as an endless DJ set, in the original quality.**

Pick one song, or one of a few suggested starting points, and Heterodina keeps the music going. Every next track is chosen to fit what is playing, and it is mixed in as a DJ would. There are no settings, no queue to manage and no playlists to build.

[![Now playing: big cover, colours taken from the artwork, the radio's universe under the stars](docs/screenshots/playing.jpg)](docs/screenshots/playing.jpg)

| Varied starting points | Search in romaji | The radio's universe: click the line under the stars (or press `U`) to see which albums it draws from, and remove or add some |
|---|---|---|
| [![Six suggested songs from different corners of the library](docs/screenshots/start.jpg)](docs/screenshots/start.jpg) | [![Typing "tokyo" finds 東京 and トーキョー](docs/screenshots/search.jpg)](docs/screenshots/search.jpg) | [![Albums the radio draws from, with add and remove controls](docs/screenshots/universe.jpg)](docs/screenshots/universe.jpg) |

## Why Heterodina

- **It knows what your music belongs to.** Start from a game soundtrack and you get that soundtrack, its composers, the jazz and rock arrangements of it, and the albums around it, not "other music that sounds vaguely similar". It works this out from your own Plex metadata. You can see it (under the stars, next to the file format) and correct it in two clicks.
- **Transitions that sound DJ-mixed, not faded, and fully automatic.**
  - When tempos are close, both songs are time-stretched (pitch kept) onto one tempo that glides from one to the other, so beats and bars stay locked for up to 16 bars.
  - It picks where to mix: bar lines near the end of one song and the start of the next where timbre and harmony match, landing on a drop or a new section when it can.
  - Every hand-over gets its own style, chosen from tempo, key and energy: long blends with a bass swap, three-band filter waves, noise risers and loop rolls into louder songs, reverb washes when keys clash, echo or turntable-brake exits when tempos are far apart, and the beat mix, sound bomb, beat storm and signature styles of Spotify's mixing patent.
  - Consecutive album tracks stay gapless, and every track is loudness-normalized.
- **Original quality, no transcoding.** Your files reach the browser as they are, so FLAC stays lossless at its own bit depth: no re-encoding to a streaming bitrate and no Plex transcoder in the playback path. The player shows what each file is, such as `FLAC 24/96` or `MP3 320 kbps`. The only processing is the loudness gain and, during a hand-over, the few bars being mixed.
- **The next song fits the last one.**
  - The radio follows the mood of what just played, so a station drifts naturally instead of jumping around.
  - It avoids slamming a loud ending into a quiet intro.
  - It prefers hand-overs whose tempos can lock.
- **It plays what you love.** Your 3–5★ songs come up more often, and 1★ songs never play. Ratings sync with Plex.
- **Variety without effort.** It doesn't repeat songs (or other copies of them), doesn't stack the same album or artist, and doesn't play five arrangements of the same theme in a row.
- **Use your Plex playlists as a filter.** Choose a playlist, smart ones included, and search and radio stay inside it. Let Plex do "unplayed", "no skips" or "4★ and up", and Heterodina does the rest.
- **Search the way you type.** Romaji finds kana and kanji (`tokyo` finds 東京).
- **A calm, focused player.** It shows a big cover, and the colours follow the artwork with smooth transitions. Media keys work, and the UI speaks English, Spanish or Japanese, following your browser.
- **Private by design.** It runs on your machine next to Plex, and the Plex token never reaches the browser.

## How it works, in one minute

1. **Universe.** From the seed album, Heterodina finds related albums. Its evidence is:
   - shared track titles, which link soundtracks to their arrangements;
   - performers, album artists and labels;
   - rare words in album titles (Japanese segmented with kuromoji).

   Small universes widen to the label and then to the genre.
2. **Pick.**
   - Candidates are scored by sonic closeness to the current track (Plex's sonic analysis), universe membership and your stars, with a pinch of exploration.
   - The best few are re-ranked by how well their start follows the current ending, in loudness and in tempo.
   - One is drawn at random among the best, so it is never the obvious choice every time.
3. **Mix.**
   - The browser decodes both tracks and analyses them beat by beat: tempo, bars, key, timbre, harmony, sections and drops.
   - It chooses the transition points, length and style, renders the transition offline (time-stretch, EQ, filters, effects) and splices it sample-exactly between the two songs.

## Getting started

Requires Node 24 or later. Node runs the TypeScript natively, so the server has no build step.

```bash
cp .env.example .env   # fill in PLEX_URL and PLEX_TOKEN
npm install
npm run dev            # API on :5174 + Vite on :5173
```

Open http://localhost:5173.

For production, `npm run build && npm start` serves the compiled front end from `dist/` on the API port.

### Docker

CI publishes a multi-arch image (amd64 and arm64) to `ghcr.io/haskou/heterodina` on every push to `main`.

```bash
cp .env.example .env   # fill in PLEX_URL and PLEX_TOKEN
docker compose up -d   # http://localhost:5174
```

`PLEX_URL` must be reachable from inside the container. Use the Plex server's LAN address, or `http://host.docker.internal:32400` when Plex runs on the same machine. Analysis caches persist in the `heterodina-cache` volume.

| Variable | Purpose |
|---|---|
| `PLEX_URL` | Plex server URL, e.g. `http://127.0.0.1:32400` |
| `PLEX_TOKEN` | Read by the server only; never sent to the browser |
| `PLEX_LIBRARY` | Name of the music library (case- and accent-insensitive) |
| `API_PORT` | API port (default 5174) |
| `HOST` | Interface to listen on (default `127.0.0.1`; the Docker image uses `0.0.0.0`) |

## Usage

Before anything plays, the page suggests six starting points that are as different from each other as the source allows: different universes, artists, labels and genres, with starred songs favoured. Ask for others as often as you like.

The interface follows the browser's language: English, Spanish or Japanese, with English as the fallback.

| Key | Action |
|---|---|
| — | The selector next to the search box picks the source: the whole library or one Plex playlist |
| `/` | Search (original script or romaji) |
| `↵` | Start a radio from the selected track |
| `Space` | Play / pause |
| `N` | Next (short fade) |
| `←` `→` | ±10 s |
| `↑` `↓` | Volume |
| `1`–`5`, `0` | Star rating in Plex (`0` clears it) |
| `U` | Show and correct the radio's universe (or click the line under the stars) |

System media keys work too.

## Commands

- `npm test`: server tests (against a fake Plex), transition planner, beat detector and the front end's pure logic.
- `npm run typecheck`: strict TypeScript for server and front end.
- `node scripts/radio-sim.ts <trackId> [n] [--no-fit]`: plays a station without audio against your Plex and reports universe adherence, variety and how well the hand-overs fit. `--no-fit` is the baseline without the edge and tempo preferences.
- `node scripts/universe-probe.ts <albumId> […]`: prints the inferred universe of some albums.

## Architecture

```
browser ──/api──▶ server (Node) ──X-Plex-Token──▶ Plex
```

### Server (`server/`)

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
  - `/api/art`: cover art.
  - Search, suggestions and radio accept `playlist=<id>` to use only that playlist's tracks.
- **Token:** only sent as a header between server and Plex. Tests check that it never appears in a response.
- **Search** (`search-index.ts`, `romaji.ts`):
  - At startup, and every 30 minutes after that, it loads every track and keeps each field's original text plus its romaji reading. Kanji readings come from kuromoji's dictionary.
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
    - A new station's universe is analysed in the background, 3 tracks at a time. Each pick waits at most 4 s for its shortlist, and unanalysed tracks score between compatible and clashing.
  - Playlists as source: universe, exploration and fallback are limited to the playlist's tracks, and Plex evaluates smart playlists itself.
    - Items are read in pages of 2,000. One large request can take minutes; pages take seconds.
    - Items are cached for 10 minutes and refreshed in the background. The browser warms the cache as soon as a playlist is selected.
- **Suggestions:** a sample of the source, drawn one track at a time.
  - Each pick avoids the universes, album artists, labels and genres already chosen.
  - Starred tracks come up more often.
  - The next set is prepared in the background, and one is ready at startup.

### Browser (`web/src/`)

- **Engine** (`engine.ts`, `voice.ts`):
  - As soon as a track starts, the engine loads the next one and plans the transition.
  - Start, fades, EQ and stop are scheduled on the `AudioContext` clock, so timing stays exact in a background tab.
  - Tracks up to 12 minutes are decoded whole, with sample-exact timing. Longer ones stream through an `<audio>` element to keep memory bounded.
- **Mix** (`shared/mix.ts`, `shared/features.ts`, `shared/stretch.ts`, `mixer.ts`): every transition that isn't gapless, with nothing to configure.
  - **Analysis:** on the outgoing track's last quarter and the incoming one's first fifth: beat grid, then per beat a 12-band timbre, a chroma (pitch-class) profile and loudness; the downbeat; the key (Krumhansl–Kessler profiles); section boundaries (novelty across 8 beats) and drops (the bass comes in much harder).
  - **Compatibility** (after Spotify's mashup patent, US 11475867): tempo score `max(0.01, 1 − 3.5·|log2 ratio|)` × key score (semitones between relative-major roots, Camelot neighbours count as close). The better the fit, the longer the preferred window: 2, 4, 8 or 16 bars.
  - **Transition points** (after Bittner et al., "Automatic Playlist Sequencing and Transitions", ISMIR 2017): every pair of downbeats and every length is scored on timbre and harmony distance, loudness, harmonic change balance and whether both regions end on a section boundary or a drop. The lowest cost wins.
  - **Tempo:** when both beats are steady and within 8% (or double/half), both tracks are stretched with WSOLA onto a tempo gliding from one BPM to the other across the window. Otherwise each keeps its speed and the style keeps the overlap short.
  - **Styles**, chosen per hand-over: blend (centre bass swap), wave (three-band hand-over through low-pass filters), rise (high-pass and noise riser, bass on the last beat), roll (loop halving into the drop), melt (low-pass into reverb), echo (tempo-synced echo exit), brake (turntable stop), and the mixing patent's beat mix, sound bomb (mid-third bass fade), beat storm (bass echo) and signature (bass and mid fade with a flanger). Into a drop or new section, the incoming bass waits for it.
  - **Render:** an `OfflineAudioContext` with a Linkwitz-Riley three-band EQ (250 Hz / 2.5 kHz), sweeping filters, echo and convolution reverb buses and a peak limiter. The result plays as part of the incoming voice, spliced in and out with 10 ms overlaps.
- **Fallback crossfade** (`shared/transition.ts`), for tracks that stream (over 12 minutes) or windows that don't fit:
  - **Overlap:** for the last N seconds of sound, the outgoing track fades out while the incoming one fades in.
    - The curves are equal-power (sine/cosine, measured within ±0.13 dB).
    - N is 6 s, or the length of the track's own fade-out, up to 12 s.
    - Leading and trailing silence are trimmed.
  - **Bass swap:** a low-shelf EQ at 200 Hz, −18 dB. The incoming track enters without bass and takes it over mid-blend, so two kicks and basslines never stack.
  - **Beat alignment** (`shared/beat.ts`):
    - With both tracks decoded, it detects tempo and phase on each side of the blend, using low- and high-band onsets and autocorrelation (1–4 ms per analysis).
    - If the tempos are compatible (same, double or half, under 50 ms of drift across the blend), the blend moves by less than half a beat so the beats coincide.
    - The bass swap then lasts one beat, centred on a beat.
  - **Manual skip or new track:** 0.6 s fades. Anything still fading out goes with it, so three tracks never sound at once.
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
