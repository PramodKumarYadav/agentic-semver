const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('@actions/core');
const github = require('@actions/github');
const Anthropic = require('@anthropic-ai/sdk');
const {
  analyzePullRequest,
  applyVersionRecommendation,
  readPackageVersion,
  resolveRepositoryFile
} = require('./index');

async function loadBaseVersion(octokit, { owner, repo, baseRef, packageJsonPath, fallbackVersion }) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: packageJsonPath,
      ref: baseRef
    });

    if (!('content' in response.data)) {
      return fallbackVersion;
    }

    const decoded = Buffer.from(response.data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed.version || fallbackVersion;
  } catch (error) {
    if (error.status === 404) {
      core.info(`No ${packageJsonPath} found on ${baseRef}; using the workspace version as the baseline.`);
      return fallbackVersion;
    }

    throw error;
  }
}

function filterRelevantFiles(files, ignoredPaths) {
  const ignored = new Set(ignoredPaths.map((filePath) => filePath.replace(/^\.\//, '')));
  return files.filter((file) => !ignored.has(file.filename));
}

function hasStagedChanges(files) {
  const changedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();
  if (!changedFiles) {
    return false;
  }

  const staged = new Set(changedFiles.split('\n'));
  return files.some((file) => staged.has(file.replace(/^\.\//, '')));
}

function commitAndPushChanges({ pullRequest, packageJsonPath, changelogPath, nextVersion }) {
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
  execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  execFileSync('git', ['checkout', '-B', pullRequest.head.ref]);

  const filesToStage = [packageJsonPath, changelogPath];
  const lockPath = path.join(path.dirname(path.resolve(packageJsonPath)), 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    filesToStage.push(lockPath);
  }
  execFileSync('git', ['add', ...filesToStage]);

  if (!hasStagedChanges([packageJsonPath, changelogPath])) {
    core.info('package.json and CHANGELOG.md are already up to date.');
    return false;
  }

  execFileSync('git', ['commit', '-m', `chore: bump version to ${nextVersion}`], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', `HEAD:${pullRequest.head.ref}`], { stdio: 'inherit' });
  return true;
}

async function postSummaryComment(octokit, { owner, repo, issueNumber, result, recommendation }) {
  const body = [
    '## Agentic semver update',
    '',
    `- Recommended bump: **${recommendation.bump}**`,
    `- Current version: **${result.currentVersion}**`,
    `- Next version: **${result.nextVersion}**`,
    '',
    result.changelogEntry.trim()
  ].join('\n');

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
}

async function run() {
  try {
    const githubToken = core.getInput('github-token', { required: true });
    const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
    const model = core.getInput('model') || 'claude-3-5-sonnet-latest';
    const packageJsonPath = (core.getInput('package-json-path') || 'package.json').replace(/^\.\//, '');
    const changelogPath = (core.getInput('changelog-path') || 'CHANGELOG.md').replace(/^\.\//, '');
    const targetBaseBranch = core.getInput('target-base-branch') || 'main';
    const maxFiles = Number.parseInt(core.getInput('max-files') || '40', 10);
    const commitChanges = core.getBooleanInput('commit-changes');
    const commentSummary = core.getBooleanInput('comment-summary');

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('This action only supports pull_request events.');
    }

    if (pullRequest.base.ref !== targetBaseBranch) {
      core.info(`Skipping analysis because the pull request targets ${pullRequest.base.ref}, not ${targetBaseBranch}.`);
      core.setOutput('skipped', 'true');
      return;
    }

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);
    const workspaceVersion = readPackageVersion(resolveRepositoryFile(packageJsonPath));
    const baseVersion = await loadBaseVersion(octokit, {
      owner,
      repo,
      baseRef: pullRequest.base.ref,
      packageJsonPath,
      fallbackVersion: workspaceVersion
    });

    const allFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullRequest.number,
      per_page: 100
    });
    const relevantFiles = filterRelevantFiles(allFiles, [packageJsonPath, changelogPath]);

    if (relevantFiles.length === 0) {
      core.info('No code changes remain after ignoring package.json and CHANGELOG.md; skipping version recommendation.');
      core.setOutput('skipped', 'true');
      return;
    }

    const anthropic = new Anthropic({ apiKey: anthropicApiKey });
    const recommendation = await analyzePullRequest({
      anthropic,
      model,
      repositoryFullName: `${owner}/${repo}`,
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
      currentVersion: baseVersion,
      pullRequest,
      files: relevantFiles,
      maxFiles
    });

    const result = applyVersionRecommendation({
      packageJsonPath: resolveRepositoryFile(packageJsonPath),
      changelogPath: resolveRepositoryFile(changelogPath),
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

    const isFork = pullRequest.head.repo.full_name !== `${owner}/${repo}`;
    if (commitChanges && !isFork) {
      commitAndPushChanges({
        pullRequest,
        packageJsonPath,
        changelogPath,
        nextVersion: result.nextVersion
      });
    } else if (commitChanges && isFork) {
      core.warning('Skipping commit because the pull request comes from a fork.');
    }

    if (commentSummary) {
      await postSummaryComment(octokit, {
        owner,
        repo,
        issueNumber: pullRequest.number,
        result,
        recommendation
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(message);
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  commitAndPushChanges,
  filterRelevantFiles,
  loadBaseVersion,
  postSummaryComment,
  run
};
