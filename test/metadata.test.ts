import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeMetadata, parseMetadata, recoverRecommendation } from '../src/metadata.js';
import type { AnalysisRecommendation } from '../src/index.js';

const recommendation: AnalysisRecommendation = {
  bump: 'minor',
  summary: 'Adds a fallback analysis path.',
  changelog: ['Added a fallback', 'Fixed a typo']
};

test('serializeMetadata round-trips through parseMetadata', () => {
  assert.deepEqual(parseMetadata(serializeMetadata(recommendation)), recommendation);
});

test('parseMetadata finds the block inside a full comment body', () => {
  const body = ['## Agentic semver update', '', '- Recommended bump: **minor**', '', serializeMetadata(recommendation)].join('\n');
  assert.deepEqual(parseMetadata(body), recommendation);
});

// A summary containing `-->` would close the HTML comment early, truncating the
// JSON and swallowing whatever followed it in the comment body.
test('serializeMetadata survives a summary that contains a comment terminator', () => {
  const hostile: AnalysisRecommendation = {
    bump: 'major',
    summary: 'Renames a --> b, which is breaking.',
    changelog: ['Renamed a --> b']
  };
  const block = serializeMetadata(hostile);

  assert.equal(block.match(/-->/g)?.length, 1, 'only the real terminator should appear');
  assert.deepEqual(parseMetadata(block), hostile);
});

test('parseMetadata returns null when there is no block', () => {
  assert.equal(parseMetadata('Just an ordinary review comment.'), null);
});

test('parseMetadata returns null for a block that is not valid JSON', () => {
  assert.equal(parseMetadata('<!-- agentic-semver:v1\n{not json\n-->'), null);
});

test('parseMetadata rejects an unsupported bump type', () => {
  assert.equal(parseMetadata('<!-- agentic-semver:v1\n{"bump":"huge","summary":"s","changelog":["a"]}\n-->'), null);
});

test('parseMetadata rejects a block with an empty changelog', () => {
  assert.equal(parseMetadata('<!-- agentic-semver:v1\n{"bump":"patch","summary":"s","changelog":[]}\n-->'), null);
});

test('parseMetadata rejects a block with a blank summary', () => {
  assert.equal(parseMetadata('<!-- agentic-semver:v1\n{"bump":"patch","summary":"   ","changelog":["a"]}\n-->'), null);
});

// Every push posts a new comment, so the newest block describes the diff that
// actually merged.
test('parseMetadata takes the last block when a body carries several', () => {
  const older = serializeMetadata({ bump: 'patch', summary: 'Old.', changelog: ['old'] });
  const newer = serializeMetadata(recommendation);
  assert.deepEqual(parseMetadata(`${older}\n\n${newer}`), recommendation);
});

test('recoverRecommendation takes the newest block across comments', () => {
  const comments = [
    { body: serializeMetadata({ bump: 'patch', summary: 'First pass.', changelog: ['first'] }) },
    { body: 'A human replying in between.' },
    { body: serializeMetadata(recommendation) }
  ];
  assert.deepEqual(recoverRecommendation(comments), recommendation);
});

test('recoverRecommendation ignores comments with no block and tolerates empty bodies', () => {
  assert.equal(recoverRecommendation([{ body: 'nothing here' }, { body: null }, {}]), null);
});

test('recoverRecommendation keeps the last valid block when a later one is malformed', () => {
  const comments = [
    { body: serializeMetadata(recommendation) },
    { body: '<!-- agentic-semver:v1\n{broken\n-->' }
  ];
  assert.deepEqual(recoverRecommendation(comments), recommendation);
});
