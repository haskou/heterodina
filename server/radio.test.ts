import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Track } from '../shared/types.ts';
import { draw, edgeFit, score, songKey, starBoost, suggest, tempoFit, type Candidate } from './radio.ts';

const t = (id: string, title: string, albumId = `al${id}`, albumArtist = `ar${id}`): Track =>
  ({ id, title, artist: albumArtist, albumArtist, albumId, playable: true, rating: null }) as Track;
const c = (track: Track, distance: number | undefined = 0.1, weight = 1): Candidate => ({ track, weight, distance });

test('never repeats a recent song, even as another copy', () => {
  const recent = [t('1', 'Main Theme', 'a', 'Composer')];
  const copy = t('2', 'Main Theme', 'b', 'Composer');
  const other = t('3', 'Battle Theme');
  for (let i = 0; i < 20; i++) assert.equal(draw([c(copy, 0), c(other, 0.3)], recent)?.track.id, '3');
});

test('returns null when nothing is left', () => {
  const a = t('1', 'A');
  assert.equal(draw([c(a)], [a]), null);
  assert.equal(draw([c({ ...t('2', 'B'), playable: false })], []), null);
});

test('one-star tracks never come up', () => {
  const disliked = { ...t('1', 'A'), rating: 2 };
  const liked = { ...t('2', 'B'), rating: 4 };
  assert.equal(draw([c(disliked)], []), null);
  assert.equal(draw([c(liked)], [])?.track.id, '2');
});

test('does not always pick the best', () => {
  const cands = Array.from({ length: 10 }, (_, i) => c(t(String(i), `S${i}`), i / 100));
  const picks = new Set(Array.from({ length: 200 }, () => draw(cands, [])?.track.id));
  assert.ok(picks.size >= 4, `only ${picks.size} distinct picks`);
});

test('closer mood and stronger membership score higher', () => {
  const x = t('1', 'X');
  assert.ok(score(c(x, 0.05), [], 0.5) > score(c(x, 0.3), [], 0.5));
  assert.ok(score(c(x, 0.1, 1), [], 0.5) > score(c(x, 0.1, 0.3), [], 0.5));
  assert.ok(score(c(x, 0.1, 0.3), [], 0.5) > score(c(x, 0.1, 0), [], 0.5));
  // Unknown distance ranks behind every listed neighbour.
  assert.ok(score({ track: x, weight: 1, distance: undefined }, [], 0.5) < score(c(x, 0.5), [], 0.5));
});

test('avoids the album and artist that just played', () => {
  const last = t('0', 'Prev', 'album-x', 'artist-x');
  const sameAlbum = t('1', 'Same album', 'album-x', 'artist-x');
  const sameArtist = t('2', 'Same artist', 'album-y', 'artist-x');
  const other = t('3', 'Other');
  const s = (x: Track) => score(c(x), [last], 0.5);
  assert.ok(s(other) > s(sameArtist) && s(sameArtist) > s(sameAlbum));
});

test('another arrangement of the same composition is held back', () => {
  const last = t('0', 'Battle Theme (Jazz Arrange)', 'a');
  const arrange = t('1', 'Battle Theme ~Rock ver.~', 'b');
  const other = t('2', 'Main Theme', 'c');
  assert.ok(score(c(arrange), [last], 0.5) < score(c(other), [last], 0.5) * 0.1);
});

test('songKey folds copies together', () => {
  assert.equal(songKey(t('1', 'Summer Song')), songKey({ ...t('2', 'summer  song!'), artist: 'ar1' }));
});

test('a loud ending into a quiet start fits worse than a matching one', () => {
  assert.equal(edgeFit(-12, -13), 1);
  assert.ok(edgeFit(-10, -22) < 0.2, 'a 12 dB drop jars');
  assert.ok(edgeFit(-22, -10) > edgeFit(-10, -22), 'a lift is tolerated more than a drop');
});

test('tempos that can lock beat ones that clash; unknown sits between', () => {
  assert.equal(tempoFit(0.5, 0.5), 1);
  assert.equal(tempoFit(0.5, 1.0), 1, 'half tempo locks every other beat');
  assert.equal(tempoFit(0.5, 0.6), 0.6);
  assert.ok(tempoFit(0.5, undefined) > tempoFit(0.5, 0.6) && tempoFit(0.5, undefined) < 1);
  assert.equal(tempoFit(null, 0.6), 1, 'a beatless edge never clashes');
});

test('3 stars and up are favoured; 1-2 stars and unrated are not', () => {
  assert.equal(starBoost(null), 1);
  assert.equal(starBoost(4), 1);
  assert.ok(starBoost(6) > 1 && starBoost(8) > starBoost(6) && starBoost(10) > starBoost(8));
  const x = t('1', 'X');
  assert.ok(score(c({ ...x, rating: 8 }), [], 0.5) > score(c(x), [], 0.5));
});

test('suggestions span different artists, labels and genres', async () => {
  const albums = new Map(
    ['rock', 'rock', 'jazz', 'pop', 'ambient', 'metal', 'folk'].map((genre, i) => [
      `al${i}`,
      { id: `al${i}`, title: '', artist: `ar${i}`, label: i < 2 ? 'Same Label' : `label${i}`, genres: [genre], year: null, tracks: [] },
    ]),
  );
  const tracks = Array.from({ length: 70 }, (_, i) => t(String(i), `Song ${i}`, `al${i % 7}`, `ar${i % 7}`));
  for (let run = 0; run < 20; run++) {
    const picks = await suggest(tracks, albums, undefined, 6);
    assert.equal(picks.length, 6);
    assert.equal(new Set(picks.map((p) => p.albumArtist)).size, 6, 'one per artist');
    const genres = picks.map((p) => albums.get(p.albumId)?.genres[0]);
    assert.equal(new Set(genres).size, 6, `genres repeat: ${genres.join(',')}`);
  }
});

test('suggestions never share a universe when they can avoid it', async () => {
  const albums = new Map(
    Array.from({ length: 12 }, (_, i) => [`al${i}`, { id: `al${i}`, title: '', artist: `ar${i}`, label: null, genres: [], year: null, tracks: [] }]),
  );
  // al0..al5 form one universe; the rest stand alone.
  const group = new Set(Array.from({ length: 6 }, (_, i) => `al${i}`));
  const related = (id: string): ReadonlySet<string> => (group.has(id) ? group : new Set([id]));
  const tracks = Array.from({ length: 120 }, (_, i) => t(String(i), `Song ${i}`, `al${i % 12}`, `ar${i % 12}`));
  for (let run = 0; run < 20; run++) {
    const picks = await suggest(tracks, albums, related, 6);
    assert.ok(picks.filter((p) => group.has(p.albumId)).length <= 1);
  }
});
