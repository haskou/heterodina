// Dev tool: plays a station for N tracks without audio and prints the picks.
// Usage: node scripts/radio-sim.ts <seedTrackId> [count=50] [--no-fit]
// --no-fit picks without looking at track edges (baseline for comparison).
import { loadConfig } from '../server/config.ts';
import { Library } from '../server/library.ts';
import { PlexClient } from '../server/plex.ts';
import { Radio, tempoFit } from '../server/radio.ts';
import { Romanizer } from '../server/romaji.ts';
import { SearchIndex } from '../server/search-index.ts';
import { JsonStore } from '../server/store.ts';
import { TempoAnalyzer, type TrackTempo } from '../server/tempo.ts';

const [seed = '', count = '50', flag] = process.argv.slice(2);
const config = loadConfig();
const plex = new PlexClient(config.plexUrl, config.plexToken);
const library = new Library(plex, config.plexLibrary, new JsonStore(null));
const romanizer = await Romanizer.create();
await library.buildIndex(new SearchIndex(romanizer));
// Shares the server's tempo cache, so repeated runs don't re-analyse.
const tempos = new JsonStore<TrackTempo>('.cache/tempo.json');
const tempo = new TempoAnalyzer(plex, library, tempos, 'heterodina-sim');
const radio = new Radio(library, new JsonStore(null), (t) => romanizer.words(t), flag === '--no-fit' ? null : tempo);
const realEdges = library.edges.bind(library);
if (flag === '--no-fit') library.edges = async () => null;

const context = radio.context(seed);
const inUniverse = new Set(context?.albums.map((a) => a.id));
console.log(`labels: ${context?.labels.join(' · ')} | ${context?.albums.length} albums, ${context?.trackCount} tracks\n`);

const played = [seed];
const albums = new Map<string, number>();
for (let i = 1; i <= Number(count); i++) {
  const pick = await radio.next(seed, played.at(-1)!, played);
  if (!pick) break;
  const t = pick.track;
  played.push(t.id);
  albums.set(t.album, (albums.get(t.album) ?? 0) + 1);
  const mark = pick.explored ? 'EXP' : inUniverse.has(t.albumId) ? '   ' : '?? ';
  console.log(`${String(i).padStart(2)} ${mark} ${t.title.slice(0, 40).padEnd(40)} ${t.artist.slice(0, 16).padEnd(16)} ${t.album.slice(0, 40)}`);
}
// How each hand-over flows: next start minus previous end, in dB (negative = drop).
const edges = await Promise.all(played.map((id) => realEdges(id)));
const steps = edges.slice(1).flatMap((e, i) => {
  const prev = edges[i];
  return e && prev ? [e.start - prev.end] : [];
});
const drops = steps.filter((d) => d < -6).length;
const meanAbs = steps.reduce((a, d) => a + Math.abs(d), 0) / steps.length;
console.log(`\nhand-overs: mean |Δ| ${meanAbs.toFixed(1)} dB, drops >6 dB: ${drops}/${steps.length}`);
await tempo.ensure(played, 120_000);
const locks = played.slice(1).map((id, i) => tempoFit(tempos.get(played[i]!)?.end, tempos.get(id)?.start));
console.log(`tempo: ${locks.filter((f) => f === 1).length} lockable, ${locks.filter((f) => f < 0.7).length} clashing of ${locks.length}`);
tempos.flush();
console.log(`${albums.size} albums, ${new Set(played.map((id) => library.cached(id)?.artist)).size} artists`);
