# agentic-semver

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-agentic--semver-purple?logo=github)](https://github.com/marketplace/actions/agentic-semver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI-powered semantic versioning for GitHub pull requests. `agentic-semver` uses Claude to read your PR diff, classify the change as `patch`, `minor`, or `major`, and automatically update your version file and `CHANGELOG.md` — no commit message conventions required.

A companion action, `create-release`, creates GitHub Releases idempotently from your version file and changelog.

---

## Actions in this suite

| Action | What it does |
| --- | --- |
| [`PramodKumarYadav/agentic-semver@v1`](#agentic-semver-action) | Runs on pull requests — classifies the bump, updates the version file and changelog, applies a PR label |
| [`PramodKumarYadav/agentic-semver/create-release@v1`](#create-release-action) | Runs on push to `main` — reads the version file, extracts changelog notes, creates a GitHub Release |

---

## How it works

```
PR opened / updated
        │
        ▼
agentic-semver action runs
  • Reads the PR diff (title, body, changed files)
  • Sends the diff to Claude for analysis
  • Claude recommends patch / minor / major
  • Updates version file (package.json, pyproject.toml, pom.xml, …)
  • Upserts a new section in CHANGELOG.md
  • Applies a patch / minor / major label to the PR
  • Commits the changes back to the PR branch
        │
        ▼
PR reviewed and merged to main
        │
        ▼
create-release action runs
  • Reads the version from the version file
  • Extracts the matching section from CHANGELOG.md
  • Creates a GitHub Release with the changelog as release notes
  • Skips if a release for this version already exists
```

---

## Prerequisites

- An **Anthropic API key** with access to Claude. Store it as a repository secret named `ANTHROPIC_API_KEY`.
- A repository with a supported version file at the root (or specify the path explicitly).

### Supported version files

Auto-detected in this order when `version-file-path` is not set:

| File | Ecosystem |
| --- | --- |
| `package.json` | Node.js |
| `pyproject.toml` | Python (PEP 621 `[project]` or Poetry `[tool.poetry]`) |
| `pom.xml` | Java / Maven |
| `gradle.properties` | Java / Gradle |

---

## Quick start

Add both workflow files to your repository.

### 1. PR versioning workflow

```yaml
# .github/workflows/agentic-semver.yml
name: Agentic SemVer

on:
  pull_request:
    branches:
      - main

permissions:
  contents: write       # push version file + changelog commits
  pull-requests: write  # post PR comments (when comment-summary: true)
  issues: write         # apply major / minor / patch label

jobs:
  version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: PramodKumarYadav/agentic-semver@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Release workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches:
      - main

permissions:
  contents: write  # create GitHub Releases and tags

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: PramodKumarYadav/agentic-semver/create-release@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

That's it. Every merged PR that bumps the version triggers an automatic GitHub Release.

---

## `agentic-semver` action

Runs on pull requests. Analyzes the diff with Claude, updates the version file and changelog, and (optionally) labels the PR.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | **yes** | — | Token used to fetch PR metadata and push generated commits |
| `anthropic-api-key` | **yes** | — | Anthropic API key used to call Claude |
| `model` | no | `claude-sonnet-4-5` | Claude model to use for analysis |
| `version-file-path` | no | auto-detected | Path to the version file to update. Auto-detects `package.json`, `pyproject.toml`, `pom.xml`, `gradle.properties` |
| `changelog-path` | no | `CHANGELOG.md` | Path to the changelog file to update |
| `target-base-branch` | no | `main` | Only process PRs targeting this branch |
| `max-files` | no | `40` | Maximum number of changed files to include in the Claude prompt |
| `commit-changes` | no | `true` | Commit the updated version file and changelog back to the PR branch |
| `comment-summary` | no | `false` | Post a PR comment with the bump recommendation and changelog entry |
| `apply-label` | no | `true` | Apply a `major`, `minor`, or `patch` label to the pull request |

### Outputs

| Output | Description |
| --- | --- |
| `skipped` | `'true'` if the action skipped processing (draft PR, wrong base branch, no relevant files) |
| `bump` | Recommended bump type: `patch`, `minor`, or `major` |
| `current-version` | Version found on the base branch before the bump |
| `next-version` | Version written to the version file |
| `summary` | Claude's one-line summary of the pull request changes |
| `changelog-entry` | Full markdown changelog entry generated for the release |

### Usage examples

#### Python project (`pyproject.toml`)

```yaml
- uses: PramodKumarYadav/agentic-semver@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    version-file-path: pyproject.toml
```

#### Java project (`pom.xml`)

```yaml
- uses: PramodKumarYadav/agentic-semver@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    version-file-path: pom.xml
```

#### Use outputs in a downstream step

```yaml
- uses: PramodKumarYadav/agentic-semver@v1
  id: semver
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

- if: steps.semver.outputs.skipped == 'false'
  run: echo "Bumping to ${{ steps.semver.outputs.next-version }} (${{ steps.semver.outputs.bump }})"
```

#### Post a PR comment with the changelog entry

```yaml
- uses: PramodKumarYadav/agentic-semver@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    comment-summary: true
```

#### Skip auto-commit (read-only mode)

```yaml
- uses: PramodKumarYadav/agentic-semver@v1
  id: semver
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    commit-changes: false

# The bump, next-version, summary, and changelog-entry outputs are still available
```

---

## `create-release` action

Runs after a merge to `main`. Reads the version from your version file, extracts the matching section from `CHANGELOG.md`, and creates a GitHub Release. Safe to run on every push — it skips gracefully when a release for the current version already exists.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | **yes** | — | Token with `contents: write` permission to create releases and tags |
| `version-file-path` | no | auto-detected | Path to the version file. Auto-detects `package.json`, `pyproject.toml`, `pom.xml`, `gradle.properties` |
| `changelog-path` | no | `CHANGELOG.md` | Path to the changelog file to extract release notes from |
| `tag-prefix` | no | `v` | Prefix applied to the version to form the git tag (e.g. `v` → `v1.2.3`) |
| `draft` | no | `false` | Create the release as a draft |
| `prerelease` | no | `false` | Mark the release as a pre-release |

### Outputs

| Output | Description |
| --- | --- |
| `version` | Version read from the version file (e.g. `1.2.3`) |
| `tag` | Full tag name created or found (e.g. `v1.2.3`) |
| `released` | `'true'` if a new release was created, `'false'` if it already existed |

### Usage examples

#### Gate a publish step on whether a new release was created

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: PramodKumarYadav/agentic-semver/create-release@v1
        id: release
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - if: steps.release.outputs.released == 'true'
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

#### Python project with explicit version file

```yaml
- uses: PramodKumarYadav/agentic-semver/create-release@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    version-file-path: pyproject.toml
```

#### Create a draft release for review before publishing

```yaml
- uses: PramodKumarYadav/agentic-semver/create-release@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    draft: true
```

---

## Comparison with alternatives

See [COMPARISON.md](./COMPARISON.md) for a detailed comparison with `semantic-release`, `release-please`, and `changesets`.
