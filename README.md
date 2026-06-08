# agentic-semver

`agentic-semver` is a GitHub Action that uses Claude to inspect pull request changes, choose the right semantic version bump, update `package.json` and `CHANGELOG.md`, and automatically publish a release — with zero commit convention requirements.

## What it does

- Reads the pull request diff targeting `main`
- Sends the PR title, body, and changed file patches to Claude
- Classifies the change as a `patch`, `minor`, or `major` release
- Updates `package.json` with the next version derived from the base branch version
- Upserts a new entry in `CHANGELOG.md`
- Optionally commits the generated version files back to the pull request branch

See [COMPARISON.md](./COMPARISON.md) for a detailed comparison with `semantic-release`, `release-please`, and `changesets`.

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
  • Applies major / minor / patch label to the PR
  • Commits changes back to the PR branch
        │
        ▼
PR reviewed and merged to main
        │
        ▼
publish.yml runs on every push to main
  • Reads version from package.json
  • Checks if a GitHub Release for that version already exists
  • If not: builds, runs tests, creates GitHub Release with
    changelog entry as release notes, publishes to npm
  • If yes: skips (nothing to do — already released)
```

### Pull request automation

The repository includes `.github/workflows/agentic-semver.yml`, which runs on pull requests to `main` when `ANTHROPIC_API_KEY` is configured.

Required secret:

- `ANTHROPIC_API_KEY`: Claude API key used to analyze the pull request

The workflow checks out the repository, installs dependencies with `npm ci`, and runs the local action in `action.yml`.

### npm publishing

The repository also includes `.github/workflows/publish.yml`, which runs on every push to `main`. It reads the version from `package.json`, checks whether a GitHub Release for that version already exists, and if not: builds the project, runs tests, creates a GitHub Release (using the matching `CHANGELOG.md` entry as release notes), and publishes to npm. This means every merged PR that bumps the version is automatically released — no manual steps needed.

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

## Action outputs

| Output | Description |
| --- | --- |
| `skipped` | `'true'` if the action skipped processing (draft PR, wrong base branch, no relevant files) |
| `bump` | Recommended bump type: `patch`, `minor`, or `major` |
| `current-version` | Version found on the base branch |
| `next-version` | Version written to `package.json` |
| `summary` | Claude's one-line summary of the pull request changes |
| `changelog-entry` | Full markdown changelog entry generated for the release |

## Using with other languages

The AI diff analysis works on **any language** — Claude can classify Python, Go, Rust, Java, or any other code change equally well. Only the automatic version file write is Node.js-specific (`package.json`).

For other ecosystems, set `commit-changes: false` and use the action outputs to update your own version file:

```yaml
- uses: PramodKumarYadav/agentic-semver@main
  id: semver
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    commit-changes: false  # don't touch package.json

# Example: update pyproject.toml for a Python project
- if: steps.semver.outputs.skipped == 'false'
  run: |
    pip install tomli-w
    python - <<'EOF'
    import tomllib, tomli_w, pathlib
    p = pathlib.Path('pyproject.toml')
    data = tomllib.loads(p.read_text())
    data['project']['version'] = '${{ steps.semver.outputs.next-version }}'
    p.write_bytes(tomli_w.dumps(data))
    EOF
    git add pyproject.toml
    git commit -m "chore: bump version to ${{ steps.semver.outputs.next-version }}"
    git push
```

The `bump`, `next-version`, `summary`, and `changelog-entry` outputs are always available for you to wire into any toolchain.

## Release action

`agentic-semver` ships a second, standalone action at `PramodKumarYadav/agentic-semver/release` that creates GitHub Releases automatically — no shell scripting required.

It reads the version directly from your version file, extracts the matching section from `CHANGELOG.md`, and creates an idempotent GitHub Release. Running it twice for the same version is safe — it detects the existing release and skips.

Supports **Node.js** (`package.json`), **Python** (`pyproject.toml`), and **Java** (`pom.xml`, `gradle.properties`) out of the box. The version file is auto-detected; no configuration needed for most projects.

```yaml
name: Release

on:
  push:
    branches:
      - main

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: PramodKumarYadav/agentic-semver/release@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # version-file: pyproject.toml   # optional — auto-detected by default
          # changelog-path: CHANGELOG.md   # optional — default: CHANGELOG.md
          # tag-prefix: v                  # optional — default: v
```

### Release action inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | none | Token with `contents: write` permission to create releases |
| `version-file` | auto-detected | Path to version file. Auto-detects `package.json`, `pyproject.toml`, `pom.xml`, `gradle.properties` |
| `changelog-path` | `CHANGELOG.md` | Changelog file to extract release notes from |
| `tag-prefix` | `v` | Prefix for the git tag (e.g. `v` → `v1.2.3`) |
| `draft` | `false` | Create the release as a draft |
| `prerelease` | `false` | Mark the release as a pre-release |

### Release action outputs

| Output | Description |
| --- | --- |
| `version` | Version read from the version file (e.g. `1.2.3`) |
| `tag` | Full tag name created or found (e.g. `v1.2.3`) |
| `released` | `'true'` if a new release was created, `'false'` if it already existed |
