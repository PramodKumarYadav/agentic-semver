import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutBranchTip, commitAndPush, resolveBump } from '../src/apply-version.js';
import { readVersionFromFile } from '../src/version-files.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Builds an origin with `main` at 1.0.0, then clones a workspace detached at the
 * merge ref the way actions/checkout does for a closed pull_request event.
 *
 * `advanceMain` pushes a second bump to origin/main after the workspace is
 * cloned. That is the concurrent-merge case: the workspace is now stale, and the
 * baseline has to come from the branch rather than from what was checked out.
 */
function setupWorkspace({ advanceMain = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-semver-apply-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const workspace = path.join(root, 'workspace');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, seed]);
  git(seed, 'config', 'user.name', 'Seed');
  git(seed, 'config', 'user.email', 'seed@example.com');

  fs.writeFileSync(path.join(seed, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), '# Changelog\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', 'origin', 'main');

  git(seed, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'feature.txt'), 'feature work\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'feature work');
  git(seed, 'push', 'origin', 'feature');

  execFileSync('git', ['clone', origin, workspace]);
  git(workspace, 'config', 'user.name', 'Runner');
  git(workspace, 'config', 'user.email', 'runner@example.com');
  git(workspace, 'merge', '--no-ff', 'origin/feature', '-m', 'Merge feature into main');
  const mergeSha = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'checkout', '--detach', mergeSha);
  git(workspace, 'push', 'origin', `${mergeSha}:main`);

  if (advanceMain) {
    git(seed, 'checkout', 'main');
    git(seed, 'pull', '--ff-only');
    fs.writeFileSync(path.join(seed, 'package.json'), '{\n  "version": "1.1.0"\n}\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'chore: bump version to 1.1.0 (#1)');
    git(seed, 'push', 'origin', 'main');
  }

  return { root, origin, workspace, mergeSha };
}

function inWorkspace<T>(workspace: string, fn: () => T): T {
  const cwd = process.cwd();
  process.chdir(workspace);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

test('commitAndPush lands the bump on the base branch', () => {
  const { root, origin, workspace } = setupWorkspace();

  try {
    inWorkspace(workspace, () => {
      checkoutBranchTip({ branch: 'main' });
      fs.writeFileSync('package.json', '{\n  "version": "1.1.0"\n}\n');
      fs.writeFileSync('CHANGELOG.md', '# Changelog\n\n## 1.1.0 - 2026-01-01\n\n- Summary: test\n');

      const sha = commitAndPush({
        branch: 'main',
        versionFilePath: 'package.json',
        changelogPath: 'CHANGELOG.md',
        message: 'chore: bump version to 1.1.0 (#1)'
      });

      assert.equal(sha, git(origin, 'rev-parse', 'main'));
    });

    const tip = git(origin, 'rev-parse', 'main');
    assert.equal(git(origin, 'log', '-1', '--format=%s', tip), 'chore: bump version to 1.1.0 (#1)');

    // Only version metadata moves. That is what makes it reasonable to let this
    // commit bypass the checks that guard the code it describes.
    const changed = git(origin, 'show', '--name-only', '--format=', tip).split('\n').filter(Boolean).sort();
    assert.deepEqual(changed, ['CHANGELOG.md', 'package.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The bug the post-merge design exists to remove: two pull requests open at once
// both read 1.0.0 off main and both predict 1.1.0. Reading the baseline after
// checking out the branch tip is what makes the second one compute 1.2.0.
test('checkoutBranchTip picks up a version another merge already pushed', () => {
  const { root, workspace } = setupWorkspace({ advanceMain: true });

  try {
    inWorkspace(workspace, () => {
      assert.equal(readVersionFromFile(path.join(workspace, 'package.json')), '1.0.0', 'checkout starts stale');
      checkoutBranchTip({ branch: 'main' });
      assert.equal(readVersionFromFile(path.join(workspace, 'package.json')), '1.1.0', 'baseline follows the branch');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkoutBranchTip leaves the workspace on the branch, not a merge ref', () => {
  const { root, workspace } = setupWorkspace();

  try {
    inWorkspace(workspace, () => {
      checkoutBranchTip({ branch: 'main' });
      assert.equal(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commitAndPush reports nothing to do when the files are already current', () => {
  const { root, origin, workspace } = setupWorkspace();

  try {
    const before = git(origin, 'rev-parse', 'main');

    inWorkspace(workspace, () => {
      checkoutBranchTip({ branch: 'main' });
      const sha = commitAndPush({
        branch: 'main',
        versionFilePath: 'package.json',
        changelogPath: 'CHANGELOG.md',
        message: 'chore: bump version to 1.0.0 (#1)'
      });
      assert.equal(sha, null);
    });

    assert.equal(git(origin, 'rev-parse', 'main'), before, 'origin must be untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commitAndPush keeps package-lock.json in step with package.json', () => {
  const { root, origin, workspace } = setupWorkspace();

  try {
    inWorkspace(workspace, () => {
      checkoutBranchTip({ branch: 'main' });
      fs.writeFileSync('package.json', '{\n  "version": "1.1.0"\n}\n');
      fs.writeFileSync('package-lock.json', '{\n  "version": "1.1.0"\n}\n');
      fs.writeFileSync('CHANGELOG.md', '# Changelog\n\n## 1.1.0 - 2026-01-01\n\n- Summary: test\n');

      commitAndPush({
        branch: 'main',
        versionFilePath: 'package.json',
        changelogPath: 'CHANGELOG.md',
        message: 'chore: bump version to 1.1.0 (#1)'
      });
    });

    const changed = git(origin, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean).sort();
    assert.deepEqual(changed, ['CHANGELOG.md', 'package-lock.json', 'package.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBump keeps the recorded bump when the label agrees', () => {
  assert.deepEqual(resolveBump('minor', [{ name: 'minor' }]), { bump: 'minor', overridden: false });
});

test('resolveBump lets a reviewer override the recommendation by relabelling', () => {
  assert.deepEqual(resolveBump('minor', [{ name: 'major' }]), { bump: 'major', overridden: true });
});

test('resolveBump ignores labels that are not semver bumps', () => {
  assert.deepEqual(
    resolveBump('patch', [{ name: 'documentation' }, { name: 'needs-review' }]),
    { bump: 'patch', overridden: false }
  );
});

test('resolveBump falls back to the recording when no label is present', () => {
  assert.deepEqual(resolveBump('major', []), { bump: 'major', overridden: false });
});

// Two semver labels express no decision, so the recorded recommendation stands
// rather than one of them being picked arbitrarily.
test('resolveBump ignores an ambiguous pair of semver labels', () => {
  assert.deepEqual(
    resolveBump('patch', [{ name: 'major' }, { name: 'minor' }]),
    { bump: 'patch', overridden: false }
  );
});

// A build step earlier in the same job can leave tracked files dirty, which would
// otherwise abort the checkout and fail the release.
test('checkoutBranchTip succeeds when an earlier step dirtied a tracked file', () => {
  const { root, workspace } = setupWorkspace({ advanceMain: true });

  try {
    inWorkspace(workspace, () => {
      fs.writeFileSync(path.join(workspace, 'package.json'), '{\n  "version": "9.9.9"\n}\n');
      checkoutBranchTip({ branch: 'main' });
      assert.equal(readVersionFromFile(path.join(workspace, 'package.json')), '1.1.0');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
