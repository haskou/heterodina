// Dev tool: prints the inferred universe for a few seed albums.
// Usage: node scripts/universe-probe.ts <albumId> [...]
import { loadConfig } from '../server/config.ts';
import { Library } from '../server/library.ts';
import { PlexClient } from '../server/plex.ts';
import { Romanizer } from '../server/romaji.ts';
import { SearchIndex } from '../server/search-index.ts';
import { JsonStore } from '../server/store.ts';
import { UniverseBuilder } from '../server/universe.ts';

const config = loadConfig();
const plex = new PlexClient(config.plexUrl, config.plexToken);
const library = new Library(plex, config.plexLibrary, new JsonStore(null));
const romanizer = await Romanizer.create();
await library.buildIndex(new SearchIndex(romanizer));
const builder = new UniverseBuilder(library.albums(), (t) => romanizer.words(t));
for (const id of process.argv.slice(2)) {
  const u = builder.build(id);
  const tracks = u.albums.reduce((n, a) => n + a.album.tracks.length, 0);
  console.log(`\n== ${builder.album(id)?.artist} — ${builder.album(id)?.title}`);
  console.log(`   labels: ${u.labels.join(' · ')} | ${u.albums.length} albums, ${tracks} tracks`);
  for (const a of u.albums.slice(0, 25)) {
    console.log(`   ${a.weight.toFixed(2)} ${a.reasons.join(',').padEnd(22)} ${a.album.artist.slice(0, 18).padEnd(18)} ${a.album.title.slice(0, 60)}`);
  }
  if (u.albums.length > 25) console.log(`   … +${u.albums.length - 25}`);
}
