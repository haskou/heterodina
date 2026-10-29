import { setPriority } from 'node:os';
import { createApp } from './app.ts';
import { ArtCache } from './art-cache.ts';
import { loadConfig } from './config.ts';
import { Library, type StoredTransition } from './library.ts';
import { PlexClient } from './plex.ts';
import { Radio, type Overrides } from './radio.ts';
import { Romanizer } from './romaji.ts';
import { SearchIndex } from './search-index.ts';
import { JsonStore } from './store.ts';
import { TempoAnalyzer, type TrackTempo } from './tempo.ts';

const config = loadConfig();
// Background analysis is never urgent: let Plex and the rest of the box go first.
try {
  setPriority(10);
} catch {
  // Not allowed here; run at normal priority.
}
const plex = new PlexClient(config.plexUrl, config.plexToken);
const transitions = new JsonStore<StoredTransition>('.cache/transitions.json');
const library = new Library(plex, config.plexLibrary, transitions);
const overrides = new JsonStore<Overrides>('.cache/universe-overrides.json');
const tempos = new JsonStore<TrackTempo>('.cache/tempo.json');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    transitions.flush();
    overrides.flush();
    tempos.flush();
    process.exit(0);
  });
}

/** "fetch failed" alone says nothing: add the network cause (ECONNREFUSED, ENOTFOUND…). */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${(err.cause as NodeJS.ErrnoException).code ?? err.cause.message}` : '';
  return `${err.message}${cause}`;
}

library.sectionId().then(
  (id) => console.log(`[plex] library "${config.plexLibrary}" -> section ${id}`),
  (err: unknown) => console.error(`[plex] ${config.plexUrl}: ${describe(err)}`),
);

// Local, romaji-aware search index over the whole library; refreshed
// periodically so new music shows up. Plex search is used until it is ready.
const INDEX_REFRESH_MS = 30 * 60 * 1000;
const romanizer = Romanizer.create();
async function refreshIndex(): Promise<boolean> {
  const started = Date.now();
  try {
    const count = await library.buildIndex(new SearchIndex(await romanizer));
    console.log(`[index] ${count} tracks in ${Date.now() - started} ms`);
    return true;
  } catch (err) {
    console.error(`[index] ${describe(err)}`);
    return false;
  }
}
/** Plex may still be starting (e.g. in the same compose stack): keep trying, backing off to a minute. */
async function firstRefresh(): Promise<void> {
  for (let wait = 5000; !(await refreshIndex()); wait = Math.min(wait * 2, 60_000)) {
    console.log(`[index] retrying in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
const firstIndex = firstRefresh();
const tempo = new TempoAnalyzer(plex, library, tempos);
const radio = new Radio(
  library,
  overrides,
  await romanizer.then((r) => (text: string) => r.words(text)),
  tempo,
);
// Have starting points ready before the first page asks.
void firstIndex.then(() => radio.suggestions()).catch(() => {});
setInterval(() => void refreshIndex(), INDEX_REFRESH_MS).unref();

createApp({ plex, library, radio, tempo, artCache: new ArtCache('.cache/art'), staticDir: 'dist' }).listen(config.port, config.host, () => {
  console.log(`[api] http://${config.host}:${config.port}`);
});
