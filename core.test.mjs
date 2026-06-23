import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_METADATA_KEY,
  buildInjectedSelection,
  clearSourceState,
  readSourceState,
  replaceArrayContents,
  setSourceState,
} from './core.mjs';

test('readSourceState normalizes missing and malformed metadata', () => {
  assert.deepEqual(readSourceState({}), {
    version: 1,
    sources: [],
    updatedAt: 0,
  });

  assert.deepEqual(readSourceState({
    [SOURCE_METADATA_KEY]: {
      version: 1,
      sources: [' Book A ', '', 'Book A', 42, 'Book B'],
      updatedAt: 123,
    },
  }), {
    version: 1,
    sources: ['Book A', '42', 'Book B'],
    updatedAt: 123,
  });
});

test('setSourceState updates only extension metadata and preserves native chat binding', () => {
  const metadata = {
    world_info: 'Native Chat Book',
    unrelated: true,
  };

  const written = setSourceState(metadata, ['Book A', 'Book B', 'Book A'], 456);

  assert.deepEqual(written, ['Book A', 'Book B']);
  assert.equal(metadata.world_info, 'Native Chat Book');
  assert.equal(metadata.unrelated, true);
  assert.deepEqual(metadata[SOURCE_METADATA_KEY], {
    version: 1,
    sources: ['Book A', 'Book B'],
    updatedAt: 456,
  });

  clearSourceState(metadata);

  assert.equal(metadata.world_info, 'Native Chat Book');
  assert.equal(metadata.unrelated, true);
  assert.equal(metadata[SOURCE_METADATA_KEY], undefined);
});

test('buildInjectedSelection appends valid sources without mutating the snapshot', () => {
  const snapshot = ['Global A', 'Book A'];
  const next = buildInjectedSelection(snapshot, ['Book B', 'Book A', '', 'Book C']);

  assert.deepEqual(snapshot, ['Global A', 'Book A']);
  assert.deepEqual(next, ['Global A', 'Book A', 'Book B', 'Book C']);
});

test('buildInjectedSelection excludes native chat books only from injected sources', () => {
  const snapshot = ['Global A', 'Native Chat Book'];
  const next = buildInjectedSelection(
    snapshot,
    ['Book B', 'Native Chat Book', 'Book C'],
    ['Native Chat Book'],
  );

  assert.deepEqual(next, ['Global A', 'Native Chat Book', 'Book B', 'Book C']);
});

test('replaceArrayContents mutates the original array reference', () => {
  const selected = ['Old A', 'Old B'];
  const sameReference = selected;

  replaceArrayContents(selected, ['New A']);

  assert.equal(selected, sameReference);
  assert.deepEqual(selected, ['New A']);
});
