import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitAndPushChanges } from '../src/action.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Builds an origin repo with `main` ahead of a `feature` branch, then checks out
 * the merge of the two the way actions/checkout does for pull_request events.
 * Returns the workspace path plus the SHAs the assertions need.
 */
function setupMergeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-semver-commit-'));
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

  // Branch off, add a code change, push.
  git(seed, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'feature.txt'), 'feature work\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'feature work');
  git(seed, 'push', 'origin', 'feature');
  const featureHead = git(seed, 'rev-parse', 'HEAD');

  // main moves on, so the merge commit is genuinely different from the head.
  git(seed, 'checkout', 'main');
  fs.writeFileSync(path.join(seed, 'other.txt'), 'unrelated main change\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'unrelated main change');
  git(seed, 'push', 'origin', 'main');

  // Mimic actions/checkout for pull_request: detached HEAD at main merged with feature.
  execFileSync('git', ['clone', origin, workspace]);
  git(workspace, 'config', 'user.name', 'Runner');
  git(workspace, 'config', 'user.email', 'runner@example.com');
  git(workspace, 'checkout', 'main');
  git(workspace, 'merge', '--no-ff', 'origin/feature', '-m', 'Merge feature into main');
  const mergeSha = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'checkout', '--detach', mergeSha);

  return { root, origin, workspace, featureHead, mergeSha };
}

test('commitAndPushChanges commits onto the PR head, not the merge commit', () => {
  const { root, origin, workspace, featureHead, mergeSha } = setupMergeCheckout();
  const cwd = process.cwd();

  try {
    // Stand in for applyVersionRecommendation having written the workspace files.
    fs.writeFileSync(path.join(workspace, 'package.json'), '{\n  "version": "1.1.0"\n}\n');
    fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## 1.1.0 - 2026-01-01\n\n- Summary: test\n');

    process.chdir(workspace);
    const pushed = commitAndPushChanges({
      pullRequest: { head: { ref: 'feature' } },
      versionFilePath: 'package.json',
      changelogPath: 'CHANGELOG.md',
      nextVersion: '1.1.0'
    });
    assert.equal(pushed, true);

    const tip = git(origin, 'rev-parse', 'feature');
    const parents = git(origin, 'log', '-1', '--format=%P', tip).split(' ');

    assert.deepEqual(parents, [featureHead], 'bump commit must sit directly on the PR head');
    assert.notEqual(tip, mergeSha);
    assert.equal(
      git(origin, 'log', '--format=%H', 'feature').includes(mergeSha),
      false,
      'the merge commit must not reach the contributor branch'
    );

    // Only version metadata should have moved; main's unrelated file must not ride along.
    const changed = git(origin, 'show', '--name-only', '--format=', tip).split('\n').filter(Boolean).sort();
    assert.deepEqual(changed, ['CHANGELOG.md', 'package.json']);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commitAndPushChanges writes a plain bump subject with no CI-skip token', () => {
  const { root, origin, workspace } = setupMergeCheckout();
  const cwd = process.cwd();

  try {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{\n  "version": "1.1.0"\n}\n');
    fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## 1.1.0 - 2026-01-01\n\n- Summary: test\n');

    process.chdir(workspace);
    commitAndPushChanges({
      pullRequest: { head: { ref: 'feature' } },
      versionFilePath: 'package.json',
      changelogPath: 'CHANGELOG.md',
      nextVersion: '1.1.0'
    });

    const subject = git(origin, 'log', '-1', '--format=%s', 'feature');
    assert.equal(subject, 'chore: bump version to 1.1.0');
    // A skip token here would suppress the run that reports required status checks.
    assert.equal(/\[(skip ci|ci skip|skip actions|actions skip|no ci)\]/i.test(subject), false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commitAndPushChanges reports no push when the files are already current', () => {
  const { root, origin, workspace } = setupMergeCheckout();
  const cwd = process.cwd();

  try {
    process.chdir(workspace);
    const before = git(origin, 'rev-parse', 'feature');
    const pushed = commitAndPushChanges({
      pullRequest: { head: { ref: 'feature' } },
      versionFilePath: 'package.json',
      changelogPath: 'CHANGELOG.md',
      nextVersion: '1.0.0'
    });

    assert.equal(pushed, false);
    assert.equal(git(origin, 'rev-parse', 'feature'), before);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
