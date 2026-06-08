# agentic-semver

`agentic-semver` is both an npm library and a GitHub Action that uses Claude to inspect pull request changes, choose the right semantic version bump, and write a changelog entry for the resulting release.

## What it does

- Reads the pull request diff targeting `main`
- Sends the PR title, body, and changed file patches to Claude
- Classifies the change as a `patch`, `minor`, or `major` release
- Updates `package.json` with the next version derived from the base branch version
- Upserts a new entry in `CHANGELOG.md`
- Optionally commits the generated version files back to the pull request branch

## Repository workflows

### End-to-end release workflow

```ini
PR opened / updated
        │
        ▼
agentic-semver.yml runs
  • Sends PR diff to Claude
  • Claude classifies bump (patch / minor / major)
  • Updates package.json and CHANGELOG.md
  • Commits changes back to the PR branch
        │
        ▼
PR reviewed and merged to main
        │
        ▼
GitHub release published
        │
        ▼
publish.yml runs
  • Installs dependencies
  • Runs tests
  • Publishes package to npm
```

### Pull request automation

The repository includes `.github/workflows/agentic-semver.yml`, which runs on pull requests to `main` when `ANTHROPIC_API_KEY` is configured.

Required secret:

- `ANTHROPIC_API_KEY`: Claude API key used to analyze the pull request

The workflow checks out the repository, installs dependencies with `npm ci`, and runs the local action in `action.yml`.

### npm publishing

The repository also includes `.github/workflows/publish.yml`, which publishes the package to npm whenever a GitHub release is published and `NPM_TOKEN` is configured.

Required secret:

- `NPM_TOKEN`: npm automation token with permission to publish `@pramodyadav027/agentic-semver`

## Using the action

```yaml
name: Agentic SemVer

on:
  pull_request:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write
  issues: write  # required for apply-label

jobs:
  version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - run: npm ci

      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Action inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | none | Token used to fetch pull request metadata and push generated commits |
| `anthropic-api-key` | none | API key used to call Claude |
| `model` | `claude-sonnet-4-5` | Claude model used for analysis |
| `package-json-path` | `package.json` | Manifest whose version will be updated |
| `changelog-path` | `CHANGELOG.md` | Changelog file to update |
| `target-base-branch` | `main` | Only PRs against this branch are processed |
| `max-files` | `40` | Max changed files included in the Claude prompt |
| `commit-changes` | `true` | Commit `package.json` and `CHANGELOG.md` back to the PR branch |
| `comment-summary` | `false` | Post a PR comment with the bump recommendation and changelog entry |
| `apply-label` | `true` | Apply a `major`, `minor`, or `patch` label to the pull request |

## Library usage

```js
const Anthropic = require('@anthropic-ai/sdk');
const {
  analyzePullRequest,
  applyVersionRecommendation
} = require('@pramodyadav027/agentic-semver');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const recommendation = await analyzePullRequest({
  anthropic,
  model: 'claude-sonnet-4-5',
  repositoryFullName: 'owner/repo',
  baseRef: 'main',
  headRef: 'feature-branch',
  currentVersion: '1.2.3',
  pullRequest: {
    number: 42,
    title: 'Add API pagination',
    body: 'Introduces pagination support for search endpoints.'
  },
  files: [
    {
      filename: 'src/api.js',
      status: 'modified',
      additions: 12,
      deletions: 3,
      changes: 15,
      patch: '@@ ...'
    }
  ],
  maxFiles: 40
});

const result = applyVersionRecommendation({
  packageJsonPath: 'package.json',
  changelogPath: 'CHANGELOG.md',
  baseVersion: '1.2.3',
  recommendation
});

console.log(result.nextVersion);
```
