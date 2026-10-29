import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { Track } from '../shared/types.ts';
import { Romanizer, searchKey } from './romaji.ts';
import { SearchIndex } from './search-index.ts';

const track = (id: string, title: string, artist: string, album: string): Track =>
  ({ id, title, artist, albumArtist: artist, album }) as Track;

const LIBRARY = [
  track('1', '青春の夢', '夜空バンド', '青春の夢'),
  track('2', 'ひとりぼっち東京', '夜空バンド', '青春の夢'),
  track('3', '月光の道場', 'Studio Moon', '東方の夢'),
  track('4', 'Morning Light', 'Nova', 'Example Game Original Soundtrack Vol.3'),
  track('5', 'MORNING LIGHT SHOW', 'SKYLINE', 'HIGHWAY'),
  track('6', 'Night School', 'さくら', 'Example Game Original Soundtrack Vol.4'),
];

let index: SearchIndex;
before(async () => {
  index = new SearchIndex(await Romanizer.create());
  index.build(LIBRARY);
});

const ids = (q: string): string[] => index.search(q).map((t) => t.id);

test('searchKey folds romanization variants', () => {
  assert.equal(searchKey('Tōhō'), searchKey('touhou'));
  assert.equal(searchKey('toohoo'), searchKey('touhou'));
  assert.equal(searchKey('Hitoribotchi'), searchKey('hitoribocchi'));
  assert.equal(searchKey('shimbun'), searchKey('shinbun'));
  assert.equal(searchKey('Hello World!'), 'helloworld');
});

test('romaji finds kanji and katakana titles', () => {
  assert.deepEqual(ids('seishun'), ['1', '2']);
  assert.deepEqual(ids('seishun no yume')[0], '1');
});

test('romaji finds mixed kana/kanji with common spellings', () => {
  assert.deepEqual(ids('hitoribocchi'), ['2']);
  assert.deepEqual(ids('hitori bocchi tokyo'), ['2']);
});

test('romaji matches artists and albums too', () => {
  assert.deepEqual(ids('yozora').sort(), ['1', '2']);
  assert.deepEqual(ids('touhou'), ['3']);
  assert.deepEqual(ids('sakura'), ['6']);
});

test('every word must match somewhere; title matches rank first', () => {
  assert.deepEqual(ids('morning nova'), ['4']);
  assert.deepEqual(ids('morning'), ['4', '5']);
});

test('original script still works', () => {
  assert.deepEqual(ids('東京'), ['2']);
  assert.deepEqual(ids('ぼっち'), ['2']);
});

test('empty query returns nothing', () => {
  assert.deepEqual(ids('   '), []);
});
