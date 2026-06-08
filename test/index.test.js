const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyVersionRecommendation,
  parseAnalysisResponse,
  upsertChangelogEntry
} = require('../src/index');

test('parseAnalysisResponse accepts fenced JSON', () => {
  const result = parseAnalysisResponse([
    '```json',
    '{"bump":"minor","summary":"Adds a new public capability","changelog":["Adds a new CLI command","Keeps existing calls compatible"]}',
    '```'
  ].join('\n'));

  assert.deepEqual(result, {
    bump: 'minor',
    summary: 'Adds a new public capability',
    changelog: ['Adds a new CLI command', 'Keeps existing calls compatible']
  });
});

test('applyVersionRecommendation updates package.json and changelog idempotently', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-semver-'));
  const packageJsonPath = path.join(tempDir, 'package.json');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2));
  fs.writeFileSync(changelogPath, '# Changelog\n\n## 1.2.3 - 2026-06-01\n\n- Summary: Previous release\n');

  const recommendation = {
    bump: 'minor',
    summary: 'Adds a backwards-compatible feature',
    changelog: ['Introduces generated changelog output', 'Keeps existing API behaviour intact']
  };

  const firstRun = applyVersionRecommendation({
    packageJsonPath,
    changelogPath,
    baseVersion: '1.2.3',
    recommendation,
    date: '2026-06-08'
  });

  const secondRun = applyVersionRecommendation({
    packageJsonPath,
    changelogPath,
    baseVersion: '1.2.3',
    recommendation,
    date: '2026-06-08'
  });

  assert.equal(firstRun.nextVersion, '1.3.0');
  assert.equal(secondRun.nextVersion, '1.3.0');

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(packageJson.version, '1.3.0');

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  assert.equal((changelog.match(/## 1\.3\.0 - 2026-06-08/g) || []).length, 1);
  assert.match(changelog, /Summary: Adds a backwards-compatible feature/);
});

test('upsertChangelogEntry replaces an existing version section', () => {
  const existing = [
    '# Changelog',
    '',
    '## 1.3.0 - 2026-06-08',
    '',
    '- Summary: Old text',
    '',
    '## 1.2.0 - 2026-05-01',
    '',
    '- Summary: Older release',
    ''
  ].join('\n');

  const updated = upsertChangelogEntry(existing, '## 1.3.0 - 2026-06-08\n\n- Summary: New text\n', '1.3.0');

  assert.match(updated, /Summary: New text/);
  assert.equal((updated.match(/## 1\.3\.0 - 2026-06-08/g) || []).length, 1);
});
