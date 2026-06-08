import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';
import {
  analyzePullRequest,
  applyVersionRecommendation,
  type AnalysisRecommendation,
  type ApplyVersionResult,
  type ChangedFile
} from './index.js';
import { detectVersionFile, readVersionFromFile } from './version-files.js';

interface LoadBaseVersionParams {
  owner: string;
  repo: string;
  baseRef: string;
  versionFilePath: string;
  fallbackVersion: string;
}

interface OctokitLike {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => Promise<{ data: unknown }>;
    };
  };
}

export async function loadBaseVersion(
  octokit: OctokitLike,
  { owner, repo, baseRef, versionFilePath, fallbackVersion }: LoadBaseVersionParams
): Promise<string> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path: versionFilePath, ref: baseRef });
    const data = response.data as Record<string, unknown>;

    if (!('content' in data)) {
      return fallbackVersion;
    }

    const decoded = Buffer.from(data.content as string, 'base64').toString('utf8');
    const basename = path.basename(versionFilePath);

    if (basename === 'package.json') {
      const parsed = JSON.parse(decoded) as { version?: string };
      return parsed.version ?? fallbackVersion;
    }

    // For other version files, write to a unique temp file and use readVersionFromFile.
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-semver-'));
    const tmpFile = path.join(tmpDir, basename);
    fs.writeFileSync(tmpFile, decoded);
    try {
      return readVersionFromFile(tmpFile);
    } catch {
      return fallbackVersion;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    const err = error as { status?: number; message?: string };
    if (err.status === 404) {
      core.info(`No ${versionFilePath} found on ${baseRef}; using the workspace version as the baseline.`);
      return fallbackVersion;
    }

    throw error;
  }
}

export function filterRelevantFiles(files: ChangedFile[], ignoredPaths: string[]): ChangedFile[] {
  const ignored = new Set(ignoredPaths.map((filePath) => filePath.replace(/^\.\//, '')));
  return files.filter((file) => !ignored.has(file.filename));
}

function hasStagedChanges(files: string[]): boolean {
  const changedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();
  if (!changedFiles) {
    return false;
  }

  const staged = new Set(changedFiles.split('\n'));
  return files.some((file) => staged.has(file.replace(/^\.\//, '')));
}

interface CommitAndPushParams {
  pullRequest: { head: { ref: string } };
  versionFilePath: string;
  changelogPath: string;
  nextVersion: string;
}

export function commitAndPushChanges({
  pullRequest,
  versionFilePath,
  changelogPath,
  nextVersion
}: CommitAndPushParams): boolean {
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
  execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  execFileSync('git', ['checkout', '-B', pullRequest.head.ref]);

  const filesToStage = [versionFilePath, changelogPath];
  // Keep package-lock.json in sync for Node.js projects.
  if (path.basename(versionFilePath) === 'package.json') {
    const lockPath = path.join(path.dirname(path.resolve(versionFilePath)), 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      filesToStage.push(lockPath);
    }
  }
  execFileSync('git', ['add', ...filesToStage]);

  if (!hasStagedChanges([versionFilePath, changelogPath])) {
    core.info(`${path.basename(versionFilePath)} and ${path.basename(changelogPath)} are already up to date.`);
    return false;
  }

  execFileSync('git', ['commit', '-m', `chore: bump version to ${nextVersion}`], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', `HEAD:${pullRequest.head.ref}`], { stdio: 'inherit' });
  return true;
}

interface PostSummaryCommentParams {
  owner: string;
  repo: string;
  issueNumber: number;
  result: ApplyVersionResult;
  recommendation: AnalysisRecommendation;
}

interface OctokitWithIssues extends OctokitLike {
  rest: OctokitLike['rest'] & {
    issues: {
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<void>;
    };
  };
}

const LABEL_COLORS: Record<string, string> = {
  major: 'e11d48',
  minor: '3b82f6',
  patch: '22c55e'
};

const SEMVER_LABELS = new Set(Object.keys(LABEL_COLORS));

interface OctokitWithLabels extends OctokitLike {
  rest: OctokitLike['rest'] & {
    issues: {
      addLabels: (params: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<void>;
      removeLabel: (params: { owner: string; repo: string; issue_number: number; name: string }) => Promise<void>;
      listLabelsOnIssue: (params: { owner: string; repo: string; issue_number: number }) => Promise<{ data: { name: string }[] }>;
      createLabel: (params: { owner: string; repo: string; name: string; color: string; description: string }) => Promise<void>;
      updateLabel: (params: { owner: string; repo: string; name: string; color: string; description: string }) => Promise<void>;
    };
  };
}

export async function applyVersionLabel(
  octokit: OctokitWithLabels,
  { owner, repo, issueNumber, bump }: { owner: string; repo: string; issueNumber: number; bump: string }
): Promise<void> {
  if (!SEMVER_LABELS.has(bump)) {
    throw new Error(`Cannot apply label: "${bump}" is not a recognised semver bump type.`);
  }

  const color = LABEL_COLORS[bump];

  // Ensure the label exists with the right colour — fall back to create only on 404.
  try {
    await octokit.rest.issues.updateLabel({ owner, repo, name: bump, color, description: `Semver ${bump} change` });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
    await octokit.rest.issues.createLabel({ owner, repo, name: bump, color, description: `Semver ${bump} change` });
  }

  // Remove any other semver labels already on the PR.
  const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number: issueNumber });
  for (const label of currentLabels) {
    if (SEMVER_LABELS.has(label.name) && label.name !== bump) {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label.name });
    }
  }

  // Apply the new label.
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [bump] });
  core.info(`Applied label "${bump}" to PR #${issueNumber}.`);
}

export async function postSummaryComment(
  octokit: OctokitWithIssues,
  { owner, repo, issueNumber, result, recommendation }: PostSummaryCommentParams
): Promise<void> {
  const body = [
    '## Agentic semver update',
    '',
    `- Recommended bump: **${recommendation.bump}**`,
    `- Current version: **${result.currentVersion}**`,
    `- Next version: **${result.nextVersion}**`,
    '',
    result.changelogEntry.trim()
  ].join('\n');

  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

export async function run(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', { required: true });
    const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
    const model = core.getInput('model') || 'claude-sonnet-4-5';
    const changelogPath = (core.getInput('changelog-path') || 'CHANGELOG.md').replace(/^\.\//, '');
    const targetBaseBranch = core.getInput('target-base-branch') || 'main';
    const maxFiles = Number.parseInt(core.getInput('max-files') || '40', 10);
    const commitChanges = core.getBooleanInput('commit-changes');
    const commentSummary = core.getBooleanInput('comment-summary');
    const applyLabel = core.getBooleanInput('apply-label');
    const versionFileInput = core.getInput('version-file-path').replace(/^\.\//, '');

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('This action only supports pull_request events.');
    }

    if (pullRequest.base.ref !== targetBaseBranch) {
      core.info(`Skipping analysis because the pull request targets ${String(pullRequest.base.ref)}, not ${targetBaseBranch}.`);
      core.setOutput('skipped', 'true');
      return;
    }

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);

    // Resolve which version file to use. Explicit input beats auto-detect.
    const workdir = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const resolvedVersionFile = versionFileInput
      ? path.resolve(workdir, versionFileInput)
      : detectVersionFile(workdir);

    core.info(`Using version file: ${resolvedVersionFile}`);
    const workspaceVersion = readVersionFromFile(resolvedVersionFile);

    const baseVersion = await loadBaseVersion(octokit, {
      owner,
      repo,
      baseRef: String(pullRequest.base.ref),
      versionFilePath: path.relative(workdir, resolvedVersionFile),
      fallbackVersion: workspaceVersion
    });

    // Ignore the version file and changelog from the diff — they're not user code.
    // Both paths must be relative to workdir to match GitHub's file.filename values.
    const resolvedChangelogPath = path.resolve(workdir, changelogPath);
    const filesToIgnore = [resolvedVersionFile, resolvedChangelogPath]
      .map((f) => path.relative(workdir, f));
    const allFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullRequest.number as number,
      per_page: 100
    });
    const relevantFiles = filterRelevantFiles(allFiles, filesToIgnore);

    if (relevantFiles.length === 0) {
      core.info('No code changes remain after ignoring version and changelog files; skipping version recommendation.');
      core.setOutput('skipped', 'true');
      return;
    }

    const anthropic = new Anthropic({ apiKey: anthropicApiKey });
    const recommendation = await analyzePullRequest({
      anthropic,
      model,
      repositoryFullName: `${owner}/${repo}`,
      baseRef: String(pullRequest.base.ref),
      headRef: String(pullRequest.head.ref),
      currentVersion: baseVersion,
      pullRequest: {
        number: pullRequest.number as number,
        title: String(pullRequest.title),
        body: pullRequest.body as string | null | undefined
      },
      files: relevantFiles,
      maxFiles
    });

    const result = applyVersionRecommendation({
      versionFilePath: resolvedVersionFile,
      changelogPath: resolvedChangelogPath,
      baseVersion,
      recommendation
    });

    core.setOutput('skipped', 'false');
    core.setOutput('bump', recommendation.bump);
    core.setOutput('current-version', result.currentVersion);
    core.setOutput('next-version', result.nextVersion);
    core.setOutput('summary', recommendation.summary);
    core.setOutput('changelog-entry', result.changelogEntry);

    await core.summary
      .addHeading('Agentic semver result')
      .addRaw(`Recommended bump: ${recommendation.bump}`)
      .addBreak()
      .addRaw(`Current version: ${result.currentVersion}`)
      .addBreak()
      .addRaw(`Next version: ${result.nextVersion}`)
      .addBreak()
      .addCodeBlock(result.changelogEntry.trim(), 'markdown')
      .write();

    const isFork = (pullRequest.head.repo as { full_name: string }).full_name !== `${owner}/${repo}`;
    if (commitChanges && !isFork) {
      commitAndPushChanges({
        pullRequest: { head: { ref: String(pullRequest.head.ref) } },
        versionFilePath: path.relative(workdir, resolvedVersionFile),
        changelogPath,
        nextVersion: result.nextVersion
      });
    } else if (commitChanges && isFork) {
      core.warning('Skipping commit because the pull request comes from a fork.');
    }

    if (commentSummary) {
      await postSummaryComment(octokit as unknown as OctokitWithIssues, {
        owner,
        repo,
        issueNumber: pullRequest.number as number,
        result,
        recommendation
      });
    }

    if (applyLabel) {
      if (isFork) {
        core.warning('Skipping label application because the pull request comes from a fork.');
      } else {
        try {
          await applyVersionLabel(octokit as unknown as OctokitWithLabels, {
            owner,
            repo,
            issueNumber: pullRequest.number as number,
            bump: recommendation.bump
          });
        } catch (labelErr) {
          core.warning(`Failed to apply version label: ${labelErr instanceof Error ? labelErr.message : String(labelErr)}`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void run();
}
