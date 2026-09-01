import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';
import {
  analyzePullRequest,
  previewVersionRecommendation,
  type AnalysisRecommendation,
  type ApplyVersionResult,
  type ChangedFile
} from './index.js';
import { serializeMetadata } from './metadata.js';
import { buildIgnoredPaths, filterRelevantFiles } from './diff-filter.js';

// Re-exported so the pull request action stays the single import site for its tests.
export { buildIgnoredPaths, filterRelevantFiles };
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

interface PostSummaryCommentParams {
  owner: string;
  repo: string;
  issueNumber: number;
  result: ApplyVersionResult;
  recommendation: AnalysisRecommendation;
  verbose?: boolean;
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

export function buildSummaryCommentBody(
  { result, recommendation, verbose }: { result: ApplyVersionResult; recommendation: AnalysisRecommendation; verbose: boolean }
): string {
  const metadata = serializeMetadata(recommendation);

  if (!verbose) {
    // `comment-summary: false` suppresses the write-up, not the handoff. The
    // release run reads the recommendation back out of this comment, so a
    // comment always gets posted — this is the smallest one that still carries it.
    return [`Agentic semver: recommending a **${recommendation.bump}** bump.`, '', metadata].join('\n');
  }

  return [
    '## Agentic semver update',
    '',
    `- Recommended bump: **${recommendation.bump}**`,
    `- Current version: **${result.currentVersion}**`,
    `- Next version: **${result.nextVersion}** (provisional — settled when this merges)`,
    '',
    result.changelogEntry.trim(),
    '',
    '<sub>Nothing is committed to this branch. The version file and changelog are written to '
      + '`main` after merge, from the bump recorded here. Change the recommendation by swapping '
      + 'the `major` / `minor` / `patch` label on this pull request — the label wins.</sub>',
    '',
    metadata
  ].join('\n');
}

export async function postSummaryComment(
  octokit: OctokitWithIssues,
  { owner, repo, issueNumber, result, recommendation, verbose = true }: PostSummaryCommentParams
): Promise<void> {
  const body = buildSummaryCommentBody({ result, recommendation, verbose });
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

    const resolvedChangelogPath = path.resolve(workdir, changelogPath);
    const filesToIgnore = buildIgnoredPaths(workdir, resolvedVersionFile, resolvedChangelogPath);
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

    // Preview only. Writing the version file here would race every other open
    // pull request: they all read the same baseline off main and would all
    // predict the same next version. The write happens once, after the merge.
    const result = previewVersionRecommendation({ baseVersion, recommendation });

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
      .addRaw(`Next version (provisional): ${result.nextVersion}`)
      .addBreak()
      .addCodeBlock(result.changelogEntry.trim(), 'markdown')
      .write();

    const isFork = (pullRequest.head.repo as { full_name: string }).full_name !== `${owner}/${repo}`;

    // A fork pull request runs with a read-only token, so neither the comment nor
    // the label lands. That is survivable: the release run finds no recommendation
    // recorded and re-analyses the merged diff itself.
    if (isFork) {
      core.warning(
        'Pull request comes from a fork, so the recommendation cannot be recorded on it. '
          + 'The release workflow will re-analyse the diff after merge.'
      );
    } else {
      await postSummaryComment(octokit as unknown as OctokitWithIssues, {
        owner,
        repo,
        issueNumber: pullRequest.number as number,
        result,
        recommendation,
        verbose: commentSummary
      });
    }

    if (applyLabel && !isFork) {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(message);
  }
}
