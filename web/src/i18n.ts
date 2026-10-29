// UI strings in the browser's language. Pure apart from `applyTo`, so the
// language choice and formatting are testable without a DOM.

const en = {
  sourceTitle: 'Where search and radio draw from',
  allLibrary: 'Whole library',
  search: 'Search',
  rating: 'Rating',
  stationTitle: "Show and correct this radio's universe (U)",
  startHere: 'Start here?',
  more: 'Others',
  moreTitle: 'Other suggestions',
  orSearch: 'Or press <kbd>/</kbd> and search for a song.',
  playPause: 'Play / pause (space)',
  next: 'Next (N)',
  volume: 'Volume (↑ ↓)',
  close: 'Close (Esc)',
  addAlbum: 'Add an album',
  universeCount: '{albums} albums · {tracks} songs',
  addToUniverse: 'Add to the universe',
  removeFromUniverse: 'Remove from the universe',
  restoreToUniverse: 'Put back in the universe',
  star: '{n} star',
  stars: '{n} stars',
  cantPlay: 'Could not play “{title}”',
  unsupported: 'Format not supported by the browser ({codec})',
  ratingFailed: 'Could not save the rating',
  radioFailed: 'The radio could not pick the next song',
  universeFailed: 'Could not correct the universe',
  searchFailed: 'Search failed',
};

export type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const es: Messages = {
  sourceTitle: 'De dónde salen la búsqueda y la radio',
  allLibrary: 'Toda la biblioteca',
  search: 'Buscar',
  rating: 'Valoración',
  stationTitle: 'Ver y corregir el universo de esta radio (U)',
  startHere: '¿Empezar por aquí?',
  more: 'Otras',
  moreTitle: 'Otras sugerencias',
  orSearch: 'O pulsa <kbd>/</kbd> y busca una canción.',
  playPause: 'Reproducir / pausa (espacio)',
  next: 'Siguiente (N)',
  volume: 'Volumen (↑ ↓)',
  close: 'Cerrar (Esc)',
  addAlbum: 'Añadir un álbum',
  universeCount: '{albums} álbumes · {tracks} canciones',
  addToUniverse: 'Añadir al universo',
  removeFromUniverse: 'Quitar del universo',
  restoreToUniverse: 'Devolver al universo',
  star: '{n} estrella',
  stars: '{n} estrellas',
  cantPlay: 'No se pudo reproducir «{title}»',
  unsupported: 'Formato no compatible con el navegador ({codec})',
  ratingFailed: 'No se pudo guardar la valoración',
  radioFailed: 'La radio no pudo elegir la siguiente canción',
  universeFailed: 'No se pudo corregir el universo',
  searchFailed: 'La búsqueda falló',
};

const ja: Messages = {
  sourceTitle: '検索とラジオの対象',
  allLibrary: 'ライブラリ全体',
  search: '検索',
  rating: '評価',
  stationTitle: 'このラジオの世界観を表示・修正 (U)',
  startHere: 'ここから始めますか？',
  more: 'ほかの候補',
  moreTitle: 'ほかのおすすめ',
  orSearch: '<kbd>/</kbd> を押して曲を検索することもできます。',
  playPause: '再生 / 一時停止 (スペース)',
  next: '次へ (N)',
  volume: '音量 (↑ ↓)',
  close: '閉じる (Esc)',
  addAlbum: 'アルバムを追加',
  universeCount: '{albums} アルバム · {tracks} 曲',
  addToUniverse: '世界観に追加',
  removeFromUniverse: '世界観から外す',
  restoreToUniverse: '世界観に戻す',
  star: '星 {n}',
  stars: '星 {n}',
  cantPlay: '「{title}」を再生できませんでした',
  unsupported: 'ブラウザが対応していない形式です ({codec})',
  ratingFailed: '評価を保存できませんでした',
  radioFailed: '次の曲を選べませんでした',
  universeFailed: '世界観を修正できませんでした',
  searchFailed: '検索に失敗しました',
};

const MESSAGES = { en, es, ja } satisfies Record<string, Messages>;
export type Language = keyof typeof MESSAGES;

/** First supported language among the browser's preferences (`navigator.languages`); English otherwise. */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0] ?? '';
    if (base in MESSAGES) return base as Language;
  }
  return 'en';
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(language: Language): Translate {
  const messages: Messages = MESSAGES[language];
  return (key, params = {}) => messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/**
 * Fills static markup: `data-i18n` sets the text, `data-i18n-html` the
 * markup (our own strings only), and `data-i18n-title` /
 * `data-i18n-placeholder` / `data-i18n-aria-label` those attributes.
 */
export function applyTo(root: ParentNode, t: Translate): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as MessageKey);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml as MessageKey);
  for (const attr of ['title', 'placeholder', 'aria-label'] as const) {
    const data = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}`;
    for (const el of root.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.dataset[data] as MessageKey));
    }
  }
}
