import Module from 'module';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Module-level mocks for GitHub Actions runtime dependencies.
// We intercept CJS resolution and inject lightweight stubs so that action.ts
// (compiled to CJS) can be loaded without the real packages.
// ---------------------------------------------------------------------------

interface ModuleWithInternals {
  _resolveFilename: (request: string, parent: NodeModule | null, isMain: boolean, options?: unknown) => string;
  _cache: Record<string, NodeModule>;
}

const NodeModule = Module as unknown as ModuleWithInternals;
const originalResolveFilename = NodeModule._resolveFilename.bind(NodeModule);

const STUBS: Record<string, unknown> = {
  '@actions/core': {
    getInput: () => '',
    getBooleanInput: () => false,
    info: () => {},
    warning: () => {},
    debug: () => {},
    setFailed: () => {},
    setOutput: () => {},
    summary: {
      addHeading: function () { return this; },
      addRaw: function () { return this; },
      addBreak: function () { return this; },
      addCodeBlock: function () { return this; },
      write: async function () {}
    }
  },
  '@actions/github': {
    context: { payload: {}, repo: { owner: '', repo: '' } },
    getOctokit: () => ({})
  },
  '@anthropic-ai/sdk': function Anthropic() {}
};

// Stable synthetic paths used as cache keys.
const STUB_PATHS: Record<string, string> = Object.fromEntries(
  Object.keys(STUBS).map((name) => [name, path.join(__dirname, `__stub__${name.replace(/\//g, '_')}.js`)])
);

NodeModule._resolveFilename = function (request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(STUB_PATHS, request)) {
    return STUB_PATHS[request];
  }
  return originalResolveFilename(request, parent, isMain, options);
};

for (const [name, stubValue] of Object.entries(STUBS)) {
  const stubPath = STUB_PATHS[name];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cache = require.cache as Record<string, NodeModule>;
  cache[stubPath] = {
    id: stubPath,
    filename: stubPath,
    loaded: true,
    exports: stubValue,
    parent: null,
    children: [],
    paths: [],
    require: require
  } as unknown as NodeModule;
}

// Now it is safe to load action.ts (tsx/cjs transpiles on the fly).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { filterRelevantFiles, loadBaseVersion } = require('../src/action') as typeof import('../src/action');

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
