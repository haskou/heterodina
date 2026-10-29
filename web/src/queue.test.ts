import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Track } from '../../shared/types.ts';
import { Queue } from './queue.ts';

const t = (id: string): Track => ({ id }) as Track;

test('peek, advance and change notifications', () => {
  const q = new Queue();
  let changes = 0;
  q.onChange(() => changes++);
  q.add(t('a'));
  q.add(t('b'));
  assert.equal(q.peek()?.id, 'a');
  assert.equal(q.peek(1)?.id, 'b');
  assert.equal(q.peek(2), null);
  q.advance(t('a'));
  assert.equal(q.peek()?.id, 'b');
  assert.equal(changes, 3);
});

test('advance ignores a track that is not at the head', () => {
  const q = new Queue();
  q.add(t('a'));
  q.advance(t('z'));
  assert.equal(q.peek()?.id, 'a');
});

test('remove by key keeps other copies of the same track', () => {
  const q = new Queue();
  q.add(t('a'));
  q.add(t('a'));
  const first = q.entries[0]?.key ?? -1;
  q.remove(first);
  assert.equal(q.entries.length, 1);
  assert.notEqual(q.entries[0]?.key, first);
});

test('discard drops the first matching entry', () => {
  const q = new Queue();
  q.add(t('a'));
  q.add(t('b'));
  q.discard(t('b'));
  assert.deepEqual(q.entries.map((e) => e.track.id), ['a']);
});
