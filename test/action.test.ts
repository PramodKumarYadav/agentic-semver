import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevantFiles, loadBaseVersion } from '../src/action.js';

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
    packageJsonPath: 'package.json',
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
    packageJsonPath: 'package.json',
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
    () => loadBaseVersion(octokit, { owner: 'owner', repo: 'repo', baseRef: 'main', packageJsonPath: 'package.json', fallbackVersion: '0.0.0' }),
    /Server error/
  );
});

test('loadBaseVersion returns fallbackVersion when response has no content field', async () => {
  const octokit = makeOctokit(async () => ({ data: {} }));

  const version = await loadBaseVersion(octokit, {
    owner: 'owner',
    repo: 'repo',
    baseRef: 'main',
    packageJsonPath: 'package.json',
    fallbackVersion: '3.0.0'
  });
  assert.equal(version, '3.0.0');
});
