# agentic-semver

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-agentic--semver-purple?logo=github)](https://github.com/marketplace/actions/agentic-semver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI-powered semantic versioning for GitHub pull requests. `agentic-semver` uses Claude to read your PR diff, classify the change as `patch`, `minor`, or `major`, and write your version file and `CHANGELOG.md` — no commit message conventions required.

The decision is made on the pull request, where you can see it and change it. The write happens on `main` after the merge, where the next version number is finally knowable. Two companion actions do that half: `apply-version` applies the bump, and `create-release` turns it into a GitHub Release.

---

## Actions in this suite

| Action | What it does |
| --- | --- |
| [`PramodKumarYadav/agentic-semver@v2`](#agentic-semver-action) | Runs on pull requests — classifies the bump, writes a changelog entry, comments and labels. Commits nothing |
| [`PramodKumarYadav/agentic-semver/apply-version@v2`](#apply-version-action) | Runs after merge — applies the recorded bump to the version file and changelog, pushes to `main` |
| [`PramodKumarYadav/agentic-semver/create-release@v2`](#create-release-action) | Runs after the bump — extracts changelog notes and creates a GitHub Release |

> **Upgrading from v1?** v1 committed the bump to the pull request branch. v2 moves that
> write to after the merge, which is what makes concurrent pull requests safe. The workflow
> files change; see [Migrating from v1](#migrating-from-v1). v1 still works and is unchanged.

---

## How it works

```ini
PR opened / updated
        │
        ▼
agentic-semver action runs          ← decides, does not write
  • Reads the PR diff (title, body, changed files)
  • Sends the diff to Claude for analysis
  • Claude recommends patch / minor / major
  • Comments with the bump and the changelog entry it would write
  • Applies a patch / minor / major label to the PR
  • Records the recommendation in the comment for later
        │
        ▼
PR reviewed and merged to main
  • Disagree with the bump? Swap the label before merging — the label wins
        │
        ▼
apply-version action runs           ← writes, once, serially
  • Reads the version off main as it stands *now*
  • Recovers the recommendation recorded on the PR (no second model call)
  • Updates the version file and upserts the CHANGELOG.md section
  • Pushes one chore: bump commit to main
        │
        ▼
create-release action runs
  • Extracts the matching section from CHANGELOG.md
  • Creates a GitHub Release pointing at the bump commit
  • Skips if a release for this version already exists
```

### Why the version is written after the merge, not on the branch

The next version cannot be computed from a pull request. Every open pull request reads
the same baseline off `main`, so two open at once both compute the same next version.
Whichever merges second then either overwrites a released version or — if your release
step is idempotent — is silently skipped and never published at all.

Computing it after the merge makes that impossible: the bump is applied serially, against
`main` as it actually stands. It also means no bot commit lands on your pull request
branch, so the version file and `CHANGELOG.md` stop being a merge-conflict magnet between
concurrent pull requests.

What you give up is editing the changelog prose during review. That trade is deliberate:
the version number is irreversible once published, the prose is a text file you can fix in
a follow-up. So the reviewable half is the number, and the automated half is the words.

---

## Prerequisites

- An __Anthropic API key__ with access to Claude. Store it as a repository secret named `ANTHROPIC_API_KEY`.
- A repository with a supported version file at the root (or specify the path explicitly).
- A __credential that can bypass your branch rules__, if `main` requires a pull request
  before merging. The release workflow pushes the bump commit straight to `main`, and
  `GITHUB_TOKEN` cannot be granted an exception to that — a GitHub App, a deploy key, or a
  PAT is needed instead. See
  [Pushing the bump to a protected main](#pushing-the-bump-to-a-protected-main) for the
  five-minute setup. Skip it if `main` accepts direct pushes.

### Supported version files

Auto-detected in this order when `version-file-path` is not set:

| File | Ecosystem |
| --- | --- |
| `package.json` | Node.js |
| `pyproject.toml` | Python (PEP 621 `[project]` or Poetry `[tool.poetry]`) |
| `pom.xml` | Java / Maven |
| `gradle.properties` | Java / Gradle |
| `Cargo.toml` | Rust |
| `Chart.yaml` | Helm / Kubernetes |
| `composer.json` | PHP |

---

## Quick start

Add both workflow files to your repository.

### 1. PR versioning workflow

This one only reads, comments, and labels — hence `contents: read` and no App token.

```yaml
# .github/workflows/agentic-semver.yml
name: Agentic SemVer

on:
  pull_request:
    branches:
      - main

permissions:
  contents: read        # nothing is written to your branch
  pull-requests: write  # post the PR comment that records the recommendation
  issues: write         # apply major / minor / patch label

jobs:
  version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: PramodKumarYadav/agentic-semver@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Release workflow

This one writes. Note the `concurrency` group — it is what makes the bump serial, and
it is not optional if more than one pull request is ever merged at a time.

```yaml
# .github/workflows/release.yml
name: Release

on:
  pull_request:
    branches:
      - main
    types:
      - closed

# Two of these at once would both read the same version. Queue them instead.
concurrency:
  group: release-main
  cancel-in-progress: false

permissions:
  contents: write     # push the bump commit, create releases and tags
  pull-requests: read # read the recommendation recorded on the PR

jobs:
  release:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      # Needed only if main requires a pull request before merging — see below.
      - uses: actions/create-github-app-token@v2
        id: app-token
        with:
          app-id: ${{ secrets.SEMVER_APP_ID }}
          private-key: ${{ secrets.SEMVER_APP_PRIVATE_KEY }}

      - uses: actions/checkout@v4
        with:
          ref: main        # a closed PR event otherwise checks out the merge ref
          fetch-depth: 0
          token: ${{ steps.app-token.outputs.token }}   # this decides the push identity

      - uses: PramodKumarYadav/agentic-semver/apply-version@v2
        id: bump
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          # Only used when a merged PR carries no recommendation — see the fallback note.
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

      - uses: PramodKumarYadav/agentic-semver/create-release@v2
        if: steps.bump.outputs.skipped == 'false'
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # The merge commit still carries the old version, so tag the bump commit.
          target-commitish: ${{ steps.bump.outputs.commit-sha }}
```

If `main` accepts direct pushes, drop the `create-github-app-token` step and use
`${{ secrets.GITHUB_TOKEN }}` for the checkout `token:` and the action's `github-token:`.

That's it. Every merged PR bumps the version on `main` and gets a GitHub Release.

---

## `agentic-semver` action

Runs on pull requests. Analyzes the diff with Claude, reports the bump and the changelog entry it recommends, and labels the PR. Writes nothing to your branch — `apply-version` does that after the merge.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | **yes** | — | Token used to read PR metadata, comment, and label. Needs no write access to contents. `secrets.GITHUB_TOKEN` is sufficient |
| `anthropic-api-key` | **yes** | — | Anthropic API key used to call Claude |
| `model` | no | `claude-sonnet-4-5` | Claude model to use for analysis |
| `version-file-path` | no | auto-detected | Path to the version file to update. Auto-detects `package.json`, `pyproject.toml`, `pom.xml`, `gradle.properties`, `Cargo.toml`, `Chart.yaml`, `composer.json` |
| `changelog-path` | no | `CHANGELOG.md` | Path to the changelog file to update |
| `target-base-branch` | no | `main` | Only process PRs targeting this branch |
| `max-files` | no | `40` | Maximum number of changed files to include in the Claude prompt |
| `comment-summary` | no | `true` | Include the human-readable write-up in the PR comment. A comment is posted either way — it carries the recommendation `apply-version` reads back after the merge |
| `apply-label` | no | `true` | Apply a `major`, `minor`, or `patch` label to the pull request |

### Outputs

| Output | Description |
| --- | --- |
| `skipped` | `'true'` if the action skipped processing (draft PR, wrong base branch, no relevant files) |
| `bump` | Recommended bump type: `patch`, `minor`, or `major` |
| `current-version` | Version found on the base branch before the bump |
| `next-version` | Version this bump would produce. Provisional — settled by `apply-version` after the merge |
| `summary` | Claude's one-line summary of the pull request changes |
| `changelog-entry` | Full markdown changelog entry generated for the release |

### Pushing the bump to a protected main

The release workflow pushes one commit to `main`. If `main` requires a pull request before
merging, `GITHUB_TOKEN` cannot do that and the push fails.

**`GITHUB_TOKEN` cannot be granted an exception.** Do not go looking for one — GitHub
deliberately refuses to let `github-actions[bot]` sit in a bypass list, because any
workflow file in the repository can mint that token, which would make branch protection
circumventable by anyone who can open a pull request. Bypass is eligible only for repo
admins and owners, the maintain/write roles, teams, **GitHub Apps**, **deploy keys**, and
Dependabot.

So the push needs a credential of its own. What this commit contains is worth knowing
before you grant one: only your version file, its lockfile, and `CHANGELOG.md` — text
describing code that already passed review, nothing executable. Gating it behind the
checks that guard the code itself buys nothing.

Pick whichever of these fits your setup.

#### GitHub App — best for organisations

Scoped permissions, and the commits are attributed to an app rather than a person.

1. Create a GitHub App under your account or organisation with repository permissions
   `contents: write` and `pull requests: read`, then install it on the repository.
2. Add the App to the bypass list. Under **Settings → Rules → Rulesets**, open the ruleset
   protecting `main`, then **Bypass list → Add bypass → GitHub Apps**, and set the mode to
   **Always** — not "For pull requests only", since this is a direct push. (On classic
   branch protection the equivalent is **Allow specified actors to bypass required pull
   requests**.)
3. Store the App ID and the private key as repository secrets — the example expects
   `SEMVER_APP_ID` and `SEMVER_APP_PRIVATE_KEY`. Pipe the key file in rather than pasting
   it, so the `BEGIN`/`END` lines and newlines survive:
   `gh secret set SEMVER_APP_PRIVATE_KEY < your-app.private-key.pem`.
4. Mint a token in the workflow and hand it to **both** `actions/checkout` and
   `apply-version`.

**Across many repositories, do this once at the org level.** Install the App org-wide, then
add it to the bypass list of an **organisation ruleset** rather than each repository's own.
Every repo using this action is then covered with no per-repo setup. Under
**Organisation settings → Repository → Rulesets**.

#### Deploy key — simplest for a single repository

A deploy key is eligible for ruleset bypass, needs no App and no organisation, and is
scoped to one repository. The trade-offs: the checkout has to use SSH, you rotate the key
yourself, and the commit carries whatever git identity you configure rather than a bot's.

1. Generate a key pair and add the public half under **Settings → Deploy keys** with
   **Allow write access** ticked.
2. Add it to the ruleset **Bypass list** the same way as above.
3. Store the private half as a secret and pass it to `actions/checkout` via
   `ssh-key:` instead of `token:`.

#### Personal access token — works, but

A fine-grained PAT with `contents: write` on the repository does the job, and its owner can
be added to the bypass list. But it belongs to one person, it expires, and every bump commit
is attributed to them. The App and the deploy key both avoid that.

---

Whichever you choose, passing the credential to the action alone is not enough — the push
uses whatever `actions/checkout` persisted, so the `token:` (or `ssh-key:`) on the
**checkout** step is what actually changes the behaviour.

If `main` accepts direct pushes, you need none of this: `GITHUB_TOKEN` is enough.

### Usage examples

#### Python project (`pyproject.toml`)

```yaml
- uses: PramodKumarYadav/agentic-semver@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    version-file-path: pyproject.toml
```

#### Java project (`pom.xml`)

```yaml
- uses: PramodKumarYadav/agentic-semver@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    version-file-path: pom.xml
```

#### Use outputs in a downstream step

```yaml
- uses: PramodKumarYadav/agentic-semver@v2
  id: semver
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

- if: steps.semver.outputs.skipped == 'false'
  run: echo "Bumping to ${{ steps.semver.outputs.next-version }} (${{ steps.semver.outputs.bump }})"
```

#### Post a PR comment with the changelog entry

```yaml
- uses: PramodKumarYadav/agentic-semver@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    comment-summary: true
```

---

## `apply-version` action

Runs after a pull request is merged. Recovers the recommendation `agentic-semver` recorded
on the pull request, applies it to the version file and `CHANGELOG.md`, and pushes one
commit to the base branch.

On the happy path it makes no model call at all — the prose a reviewer read on the pull
request is the prose that ships, unchanged. Claude is only consulted on the fallback path
below.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | **yes** | — | Token used to read the pull request and push the bump commit. Must be able to push to the base branch — see [Pushing the bump to a protected main](#pushing-the-bump-to-a-protected-main) |
| `anthropic-api-key` | no | — | Used only on the fallback path. Without it, a merged PR carrying no recommendation fails instead of being versioned |
| `model` | no | `claude-sonnet-4-5` | Claude model used for a fallback analysis |
| `version-file-path` | no | auto-detected | Path to the version file to update |
| `changelog-path` | no | `CHANGELOG.md` | Path to the changelog file to update |
| `target-base-branch` | no | `main` | Only process PRs merged into this branch, and push the bump there |
| `max-files` | no | `40` | Maximum changed files to include in a fallback analysis prompt |

### Outputs

| Output | Description |
| --- | --- |
| `skipped` | `'true'` when the PR was not merged, targeted another branch, or contained no versionable changes |
| `bump` | Semantic version bump that was applied |
| `current-version` | Version read off the base branch before the bump |
| `next-version` | Version written to the version file |
| `changelog-entry` | Markdown changelog entry that was written |
| `commit-sha` | SHA of the pushed bump commit. Pass this to `create-release` as `target-commitish` |

### Overriding the bump

Swap the `major` / `minor` / `patch` label on the pull request before merging. When the
label and the recorded recommendation disagree, the label wins — it is a deliberate,
visible, one-click decision made before anything is written. Two semver labels at once
express no decision, so the recommendation stands.

### The fallback path

Some merged pull requests carry no recommendation: one from a fork (where the pull request
workflow runs with a read-only token and cannot comment), one merged before you installed
these workflows, or one whose analysis run failed. When that happens, `apply-version`
re-analyzes the merged diff itself.

It reads that diff from the GitHub API rather than from git history, so it works under all
three merge strategies — a squash merge collapses the pull request into one commit and a
rebase merge scatters it, but the API still serves the pull request's own diff.

This is the only path that spends an API call after the merge, and it is why
`anthropic-api-key` is worth passing even though it is optional.

---

## `create-release` action

Reads the version from your version file, extracts the matching section from `CHANGELOG.md`, and creates a GitHub Release. Safe to run repeatedly — it skips gracefully when a release for the current version already exists.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | **yes** | — | Token with `contents: write` permission to create releases and tags |
| `version-file-path` | no | auto-detected | Path to the version file. Auto-detects `package.json`, `pyproject.toml`, `pom.xml`, `gradle.properties`, `Cargo.toml`, `Chart.yaml`, `composer.json` |
| `changelog-path` | no | `CHANGELOG.md` | Path to the changelog file to extract release notes from |
| `tag-prefix` | no | `v` | Prefix applied to the version to form the git tag (e.g. `v` → `v1.2.3`) |
| `draft` | no | `false` | Create the release as a draft |
| `prerelease` | no | `false` | Mark the release as a pre-release |
| `target-commitish` | no | triggering commit | Commit the tag should point at. Pass `apply-version`'s `commit-sha` when a bump was pushed earlier in the same job — the triggering commit still carries the previous version |

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

      - uses: PramodKumarYadav/agentic-semver/create-release@v2
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
- uses: PramodKumarYadav/agentic-semver/create-release@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    version-file-path: pyproject.toml
```

#### Create a draft release for review before publishing

```yaml
- uses: PramodKumarYadav/agentic-semver/create-release@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    draft: true
```

---

## Migrating from v1

v1 committed the version bump to your pull request branch. v2 moves that write to after the
merge. Nothing about your version file, changelog format, or tags changes — only which
workflow does the writing.

**What gets better.** Concurrent pull requests can no longer collide on the same version
number, and they stop conflicting with each other in `CHANGELOG.md`. Your PR workflow drops
to `contents: read` and needs no App token. One model call per pull request instead of one
per push.

**What costs more.** The release workflow now pushes to `main`, so if `main` requires a
pull request you need a credential in its bypass list — an App, a deploy key, or a PAT.
If you already created an App for v1, you are reusing it: move it to the release workflow
and add it to the bypass list. Note that `GITHUB_TOKEN` cannot be given that exception, so
this step has no zero-setup shortcut.

**Steps.**

1. Replace both workflow files with the [Quick start](#quick-start) versions. The trigger
   on the release workflow changes from `push: main` to `pull_request: closed`, and the
   `concurrency` block is required, not optional.
2. Move the App token from the PR workflow to the release workflow, and add the App to the
   bypass list for `main` — see
   [Pushing the bump to a protected main](#pushing-the-bump-to-a-protected-main).
3. Drop `commit-changes` from your inputs — it no longer exists. The PR action never
   commits.
4. Bump your `uses:` pins from `@v1` to `@v2`.

v1 is unchanged and keeps working. `@v1` stays pinned to the last 1.x release, so nothing
breaks until you move the pin yourself.

---

## Comparison with alternatives

See [COMPARISON.md](./COMPARISON.md) for a detailed comparison with `semantic-release`, `release-please`, and `changesets`.

---

## Development

```bash
npm ci
npm run build   # tsc -> dist/ (npm package), ncc -> bundle/ (action bundles)
npm test
```

`bundle/` is committed on purpose. GitHub Actions runs `bundle/action/index.js`,
`bundle/apply-version/index.js`, and `bundle/release/index.js` directly from the
checked-out repository — it never runs a build step and never installs dependencies — so
the bundles must be in git for `uses: PramodKumarYadav/agentic-semver@v2` to work at all. `dist/` stays gitignored
because it only serves npm consumers, who install dependencies normally.

**Any change under `src/` requires running `npm run build` and committing the
resulting `bundle/` diff.** CI fails the pull request otherwise.
