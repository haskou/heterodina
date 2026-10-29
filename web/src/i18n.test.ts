import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickLanguage, translator } from './i18n.ts';

test('picks the first supported browser language, English otherwise', () => {
  assert.equal(pickLanguage(['es-ES', 'en']), 'es');
  assert.equal(pickLanguage(['fr-FR', 'ja-JP']), 'ja');
  assert.equal(pickLanguage(['fr-FR', 'de']), 'en');
  assert.equal(pickLanguage([]), 'en');
});

test('fills parameters', () => {
  assert.equal(translator('en')('universeCount', { albums: 3, tracks: 40 }), '3 albums · 40 songs');
  assert.equal(translator('es')('cantPlay', { title: 'X' }), 'No se pudo reproducir «X»');
});
