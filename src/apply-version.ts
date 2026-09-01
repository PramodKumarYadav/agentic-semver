import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';
import {
  analyzePullRequest,
  applyVersionRecommendation,
  type AnalysisRecommendation,
  type BumpType
} from './index.js';
import { recoverRecommendation } from './metadata.js';
import { buildIgnoredPaths, filterRelevantFiles } from './diff-filter.js';
import { detectVersionFile, readVersionFromFile } from './version-files.js';

const SEMVER_LABELS = new Set<string>(['patch', 'minor', 'major']);

/**
 * The bump a reviewer chose, when they overrode the recommendation.
 *
 * Swapping the label is the intended way to disagree with Claude: it is one
 * click on the pull request, it happens before the merge, and it is visible in
 * the pull request timeline. So when the label and the recorded recommendation
 * disagree, the label is taken as deliberate and wins.
 */
export function resolveBump(
  recorded: BumpType,
  labels: { name: string }[]
): { bump: BumpType; overridden: boolean } {
  const labelled = labels.map((label) => label.name).filter((name) => SEMVER_LABELS.has(name));

  // More than one semver label is ambiguous, so nothing is inferred from it.
  if (labelled.length !== 1) {
    return { bump: recorded, overridden: false };
  }

  const bump = labelled[0] as BumpType;
  return { bump, overridden: bump !== recorded };
}

/** Subject this action gives its own bump commits. */
export function bumpCommitSubject(version: string, pullNumber: number): string {
  return `chore: bump version to ${version} (#${pullNumber})`;
}

/**
 * The version this action already applied for `pullNumber`, or null.
 *
 * The push happens before the tag, the release, and the publish, so a failure in
 * any of those leaves a pushed bump and a red job. Re-running that job has to
 * finish the release rather than bump a second time — without this check a retry
 * reads the version it just wrote as the new baseline and increments past it.
 */
export function findAppliedBump(headSubject: string, pullNumber: number): string | null {
  const match = /^chore: bump version to (\S+) \(#(\d+)\)$/.exec(headSubject.trim());
  if (!match || Number(match[2]) !== pullNumber) {
    return null;
  }

  return match[1];
}

interface CheckoutParams {
  branch: string;
}

/**
 * Puts the workspace on the current tip of `branch` before anything is read.
 *
 * The event that triggered this run is the merge, and `actions/checkout` may
 * have materialised the pull request's merge ref rather than the branch itself.
 * More importantly, the baseline version has to be read from the branch as it
 * stands now — the whole point of doing this after the merge is that the
 * previous release may have landed while this pull request was open.
 */
export function checkoutBranchTip({ branch }: CheckoutParams): void {
  execFileSync('git', ['fetch', '--no-tags', 'origin', branch], { stdio: 'inherit' });
  // --force because an earlier build step in the same job may have left tracked
  // files dirty, which would otherwise abort the checkout. Only the version file
  // and the changelog are ever staged from here, so there is nothing to preserve.
  execFileSync('git', ['checkout', '--force', '-B', branch, 'FETCH_HEAD'], { stdio: 'inherit' });
}

interface CommitParams {
  branch: string;
  versionFilePath: string;
  changelogPath: string;
  message: string;
}

/** Commits the version and changelog changes and pushes them. Returns the new sha, or null when nothing changed. */
export function commitAndPush({ branch, versionFilePath, changelogPath, message }: CommitParams): string | null {
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
  execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

  const filesToStage = [versionFilePath, changelogPath];
  if (path.basename(versionFilePath) === 'package.json') {
    const lockPath = path.join(path.dirname(path.resolve(versionFilePath)), 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      filesToStage.push(lockPath);
    }
  }
  execFileSync('git', ['add', ...filesToStage]);

  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();
  if (!staged) {
    core.info('Version file and changelog are already up to date; nothing to commit.');
    return null;
  }

  execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });

  try {
    execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `Failed to push the version bump to ${branch}. Two causes are worth checking: the token needs to `
        + `bypass any rule requiring a pull request on ${branch}, and a second release run may have pushed `
        + 'first — set a `concurrency` group on this workflow so releases queue instead of racing. '
        + `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export async function runApplyVersion(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', { required: true });
    const anthropicApiKey = core.getInput('anthropic-api-key');
    const model = core.getInput('model') || 'claude-sonnet-4-5';
    const changelogPath = (core.getInput('changelog-path') || 'CHANGELOG.md').replace(/^\.\//, '');
    const targetBaseBranch = core.getInput('target-base-branch') || 'main';
    const maxFiles = Number.parseInt(core.getInput('max-files') || '40', 10);
    const versionFileInput = core.getInput('version-file-path').replace(/^\.\//, '');

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error(
        'This action reads the merged pull request from the event payload, so it only supports '
          + 'pull_request events. Trigger it with `on: pull_request: types: [closed]`.'
      );
    }

    if (!pullRequest.merged) {
      core.info('Skipping because the pull request was closed without merging.');
      core.setOutput('skipped', 'true');
      return;
    }

    if (pullRequest.base.ref !== targetBaseBranch) {
      core.info(`Skipping because the pull request merged into ${String(pullRequest.base.ref)}, not ${targetBaseBranch}.`);
      core.setOutput('skipped', 'true');
      return;
    }

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);
    const issueNumber = pullRequest.number as number;

    checkoutBranchTip({ branch: targetBaseBranch });

    const workdir = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const resolvedVersionFile = versionFileInput
      ? path.resolve(workdir, versionFileInput)
      : detectVersionFile(workdir);
    const resolvedChangelogPath = path.resolve(workdir, changelogPath);

    // Read the baseline off the branch as it stands now, not off the pull
    // request's base. Those differ whenever another pull request merged while
    // this one was open, and that difference is the bug this design removes.
    const baseVersion = readVersionFromFile(resolvedVersionFile);
    core.info(`Baseline version on ${targetBaseBranch}: ${baseVersion}`);

    // Already applied for this pull request — a previous run pushed the bump and
    // then something after it failed. Report what is on the branch so the release
    // steps can finish, and touch nothing.
    const headSubject = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' });
    const alreadyApplied = findAppliedBump(headSubject, issueNumber);
    if (alreadyApplied) {
      core.info(`Version ${alreadyApplied} was already applied for #${issueNumber}; not bumping again.`);
      core.setOutput('skipped', 'false');
      core.setOutput('current-version', alreadyApplied);
      core.setOutput('next-version', alreadyApplied);
      core.setOutput('commit-sha', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      return;
    }

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100
    });

    let recommendation: AnalysisRecommendation | null = recoverRecommendation(comments);

    if (recommendation) {
      core.info('Recovered the recommendation recorded on the pull request; no analysis needed.');
    } else {
      // Nothing recorded — a fork pull request, a failed analysis run, or a
      // pull request merged before the workflow was installed. Re-analyse the
      // merged diff, which GitHub still serves in full whatever the merge
      // strategy collapsed it into on the branch.
      core.info('No recommendation recorded on the pull request; re-analysing the merged diff.');

      if (!anthropicApiKey) {
        throw new Error(
          `No recommendation was recorded on pull request #${issueNumber} and no anthropic-api-key was `
            + 'supplied to fall back on. Pass anthropic-api-key so merges that skipped the pull request '
            + 'analysis can still be versioned.'
        );
      }

      const filesToIgnore = buildIgnoredPaths(workdir, resolvedVersionFile, resolvedChangelogPath);
      const allFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: issueNumber,
        per_page: 100
      });
      const relevantFiles = filterRelevantFiles(allFiles, filesToIgnore);

      if (relevantFiles.length === 0) {
        core.info('No code changes remain after ignoring version and changelog files; skipping the bump.');
        core.setOutput('skipped', 'true');
        return;
      }

      recommendation = await analyzePullRequest({
        anthropic: new Anthropic({ apiKey: anthropicApiKey }),
        model,
        repositoryFullName: `${owner}/${repo}`,
        baseRef: String(pullRequest.base.ref),
        headRef: String(pullRequest.head.ref),
        currentVersion: baseVersion,
        pullRequest: {
          number: issueNumber,
          title: String(pullRequest.title),
          body: pullRequest.body as string | null | undefined
        },
        files: relevantFiles,
        maxFiles
      });
    }

    const { bump, overridden } = resolveBump(
      recommendation.bump,
      (pullRequest.labels ?? []) as { name: string }[]
    );

    if (overridden) {
      core.info(`Label "${bump}" overrides the recommended "${recommendation.bump}" bump.`);
    }

    const result = applyVersionRecommendation({
      versionFilePath: resolvedVersionFile,
      changelogPath: resolvedChangelogPath,
      baseVersion,
      recommendation: { ...recommendation, bump }
    });

    const sha = commitAndPush({
      branch: targetBaseBranch,
      versionFilePath: path.relative(workdir, resolvedVersionFile),
      changelogPath,
      message: bumpCommitSubject(result.nextVersion, issueNumber)
    });

    core.setOutput('skipped', 'false');
    core.setOutput('bump', bump);
    core.setOutput('current-version', result.currentVersion);
    core.setOutput('next-version', result.nextVersion);
    core.setOutput('changelog-entry', result.changelogEntry);
    core.setOutput('commit-sha', sha ?? github.context.sha);

    await core.summary
      .addHeading(`Bumped to ${result.nextVersion}`)
      .addRaw(`${result.currentVersion} → ${result.nextVersion} (${bump}${overridden ? ', set by label' : ''})`)
      .addBreak()
      .addCodeBlock(result.changelogEntry.trim(), 'markdown')
      .write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(message);
  }
}
