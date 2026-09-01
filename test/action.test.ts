import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRelevantFiles,
  loadBaseVersion,
  applyVersionLabel,
  buildIgnoredPaths,
  buildSummaryCommentBody
} from '../src/action.js';
import { parseMetadata } from '../src/metadata.js';

// ---------------------------------------------------------------------------
// filterRelevantFiles
// ---------------------------------------------------------------------------

test('filterRelevantFiles removes exact path matches', () => {
  const files = [{ filename: 'src/index.ts' }, { filename: 'package.json' }, { filename: 'CHANGELOG.md' }];
  const result = filterRelevantFiles(files, ['package.json', 'CHANGELOG.md']);
  assert.deepEqual(result, [{ filename: 'src/index.ts' }]);
});

test('filterRelevantFiles ignores leading ./ in ignored paths', () => {
  const files = [{ filename: 'src/index.ts' }, { filename: 'package.json' }, { filename: 'CHANGELOG.md' }];
  const result = filterRelevantFiles(files, ['./package.json', './CHANGELOG.md']);
  assert.deepEqual(result, [{ filename: 'src/index.ts' }]);
});

test('filterRelevantFiles returns all files when no ignored paths match', () => {
  const files = [{ filename: 'src/index.ts' }, { filename: 'src/action.ts' }];
  const result = filterRelevantFiles(files, ['package.json']);
  assert.equal(result.length, 2);
});

test('filterRelevantFiles returns empty array when all files are ignored', () => {
  const files = [{ filename: 'package.json' }];
  const result = filterRelevantFiles(files, ['package.json']);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// loadBaseVersion
// ---------------------------------------------------------------------------

function makeOctokit(override?: () => Promise<{ data: unknown }>) {
  return {
    rest: {
      repos: {
        getContent: override ?? (async () => ({
          data: { content: Buffer.from(JSON.stringify({ version: '2.0.0' })).toString('base64') }
        }))
      }
    }
  };
}

test('loadBaseVersion returns version from GitHub API', async () => {
  const octokit = makeOctokit();
  const version = await loadBaseVersion(octokit, {
    owner: 'owner',
    repo: 'repo',
    baseRef: 'main',
    versionFilePath: 'package.json',
    fallbackVersion: '0.0.0'
  });
  assert.equal(version, '2.0.0');
});

test('loadBaseVersion returns fallbackVersion when API returns 404', async () => {
  const octokit = makeOctokit(async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    throw err;
  });

  const version = await loadBaseVersion(octokit, {
    owner: 'owner',
    repo: 'repo',
    baseRef: 'main',
    versionFilePath: 'package.json',
    fallbackVersion: '1.2.3'
  });
  assert.equal(version, '1.2.3');
});

test('loadBaseVersion re-throws non-404 errors', async () => {
  const octokit = makeOctokit(async () => {
    const err = Object.assign(new Error('Server error'), { status: 500 });
    throw err;
  });

  await assert.rejects(
    () => loadBaseVersion(octokit, { owner: 'owner', repo: 'repo', baseRef: 'main', versionFilePath: 'package.json', fallbackVersion: '0.0.0' }),
    /Server error/
  );
});

test('loadBaseVersion returns fallbackVersion when response has no content field', async () => {
  const octokit = makeOctokit(async () => ({ data: {} }));

  const version = await loadBaseVersion(octokit, {
    owner: 'owner',
    repo: 'repo',
    baseRef: 'main',
    versionFilePath: 'package.json',
    fallbackVersion: '3.0.0'
  });
  assert.equal(version, '3.0.0');
});

// ---------------------------------------------------------------------------
// applyVersionLabel
// ---------------------------------------------------------------------------

function makeLabelsOctokit({
  existingLabels = [] as string[],
  updateLabelThrows = false,
  updateLabelStatus = 404
} = {}) {
  const created: string[] = [];
  const updated: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  const octokit = {
    rest: {
      repos: {
        getContent: async () => ({ data: {} })
      },
      issues: {
        listLabelsOnIssue: async () => ({ data: existingLabels.map((name) => ({ name })) }),
        createLabel: async ({ name }: { name: string }) => { created.push(name); },
        updateLabel: async ({ name }: { name: string }) => {
          if (updateLabelThrows) throw Object.assign(new Error('Label error'), { status: updateLabelStatus });
          updated.push(name);
        },
        addLabels: async ({ labels }: { labels: string[] }) => { added.push(...labels); },
        removeLabel: async ({ name }: { name: string }) => { removed.push(name); }
      }
    }
  };

  return { octokit, created, updated, added, removed };
}

test('applyVersionLabel creates and applies label when it does not exist', async () => {
  const { octokit, created, added } = makeLabelsOctokit({ updateLabelThrows: true });
  await applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'minor' });
  assert.deepEqual(created, ['minor']);
  assert.deepEqual(added, ['minor']);
});

test('applyVersionLabel updates existing label colour and applies it', async () => {
  const { octokit, updated, added } = makeLabelsOctokit();
  await applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'patch' });
  assert.deepEqual(updated, ['patch']);
  assert.deepEqual(added, ['patch']);
});

test('applyVersionLabel removes other semver labels before applying new one', async () => {
  const { octokit, removed, added } = makeLabelsOctokit({ existingLabels: ['major', 'minor'] });
  await applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'patch' });
  assert.ok(removed.includes('major'));
  assert.ok(removed.includes('minor'));
  assert.deepEqual(added, ['patch']);
});

test('applyVersionLabel does not remove the label being applied', async () => {
  const { octokit, removed, added } = makeLabelsOctokit({ existingLabels: ['minor'] });
  await applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'minor' });
  assert.deepEqual(removed, []);
  assert.deepEqual(added, ['minor']);
});

test('applyVersionLabel rethrows non-404 errors from updateLabel', async () => {
  const { octokit } = makeLabelsOctokit({ updateLabelThrows: true, updateLabelStatus: 403 });
  await assert.rejects(
    () => applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'minor' }),
    /Label error/
  );
});

test('applyVersionLabel throws when bump is not a recognised semver type', async () => {
  const { octokit } = makeLabelsOctokit();
  await assert.rejects(
    () => applyVersionLabel(octokit, { owner: 'o', repo: 'r', issueNumber: 1, bump: 'invalid' }),
    /not a recognised semver bump type/
  );
});

test('buildIgnoredPaths excludes the lockfile alongside package.json', () => {
  assert.deepEqual(
    buildIgnoredPaths('/w', '/w/package.json', '/w/CHANGELOG.md'),
    ['package.json', 'CHANGELOG.md', 'package-lock.json']
  );
});

test('buildIgnoredPaths keeps the lockfile next to a nested version file', () => {
  assert.deepEqual(
    buildIgnoredPaths('/w', '/w/pkg/app/package.json', '/w/CHANGELOG.md'),
    ['pkg/app/package.json', 'CHANGELOG.md', 'pkg/app/package-lock.json']
  );
});

test('buildIgnoredPaths adds no lockfile for non-Node version files', () => {
  assert.deepEqual(
    buildIgnoredPaths('/w', '/w/pyproject.toml', '/w/CHANGELOG.md'),
    ['pyproject.toml', 'CHANGELOG.md']
  );
});

test('buildIgnoredPaths output is consumable by filterRelevantFiles', () => {
  const ignored = buildIgnoredPaths('/w', '/w/package.json', '/w/CHANGELOG.md');
  const files = [
    { filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    { filename: 'package.json', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    { filename: 'package-lock.json', status: 'modified', additions: 2, deletions: 2, changes: 4 },
    { filename: 'CHANGELOG.md', status: 'modified', additions: 8, deletions: 0, changes: 8 }
  ];
  assert.deepEqual(filterRelevantFiles(files, ignored).map((f) => f.filename), ['src/index.ts']);
});

const previewResult = { currentVersion: '1.2.2', nextVersion: '1.3.0', changelogEntry: '## 1.3.0 - 2026-01-01\n\n- Summary: Adds a thing\n- Added a thing\n' };
const previewRecommendation = { bump: 'minor' as const, summary: 'Adds a thing', changelog: ['Added a thing'] };

// The comment is the handoff to the post-merge run, so what it embeds has to
// survive being read back off the API verbatim.
test('buildSummaryCommentBody embeds a recommendation the post-merge run can recover', () => {
  const body = buildSummaryCommentBody({ result: previewResult, recommendation: previewRecommendation, verbose: true });
  assert.deepEqual(parseMetadata(body), previewRecommendation);
});

test('buildSummaryCommentBody still carries the recommendation when the write-up is off', () => {
  const body = buildSummaryCommentBody({ result: previewResult, recommendation: previewRecommendation, verbose: false });

  assert.deepEqual(parseMetadata(body), previewRecommendation, 'comment-summary: false must not break the handoff');
  assert.equal(body.includes('## Agentic semver update'), false);
  assert.equal(body.includes(previewResult.changelogEntry.trim()), false);
});

test('buildSummaryCommentBody shows the entry and flags the version as provisional', () => {
  const body = buildSummaryCommentBody({ result: previewResult, recommendation: previewRecommendation, verbose: true });

  assert.match(body, /Recommended bump: \*\*minor\*\*/);
  assert.match(body, /provisional/);
  assert.ok(body.includes(previewResult.changelogEntry.trim()));
});
