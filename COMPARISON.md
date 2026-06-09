# Why agentic-semver?

There are several well-established tools for automated semantic versioning. Here is how `agentic-semver` differs — and where each tool shines.

---

## The core difference: AI vs. commit conventions

Every existing tool — `semantic-release`, `release-please`, `changesets` — shares the same fundamental assumption: **developers must encode the release impact in their commit messages or changeset files** using a formal convention (e.g. `feat:`, `fix:`, `BREAKING CHANGE:`).

`agentic-semver` removes that requirement entirely. It reads the **actual pull request diff** and lets Claude reason about the impact of the code change itself.

---

## Feature comparison

| Feature | agentic-semver | semantic-release | release-please | changesets |
| --- | --- | --- | --- | --- |
| **Version classification** | AI analyses PR diff | Conventional commit prefixes | Conventional commit prefixes | Developer declares in changeset file |
| **Commit convention required** | ❌ None | ✅ Required (Angular/CC) | ✅ Required (Conventional Commits) | ❌ None (manual declaration) |
| **Changelog generation** | ✅ AI-written, human-readable | ✅ Template-based | ✅ Template-based | ✅ Developer-written |
| **Works on PR** | ✅ Yes — version bumped before merge | ❌ Post-merge only | ❌ Creates a "release PR" after merge | ❌ Post-merge only |
| **PR label applied** | ✅ major / minor / patch | ❌ | ❌ | ❌ |
| **GitHub Release created** | ✅ Automatic on merge | ✅ | ✅ | ✅ (via action) |
| **npm publish** | ✅ Automatic on merge | ✅ | ❌ (separate step) | ✅ (via action) |
| **Monorepo support** | ❌ Single package | ✅ | ✅ | ✅ Best-in-class |
| **Multi-language support** | ✅ Diff analysis any language; ✅ version file write supports Node.js (`package.json`), Python (`pyproject.toml`), Java/Maven (`pom.xml`), Java/Gradle (`gradle.properties`), Rust (`Cargo.toml`), Helm (`Chart.yaml`), PHP (`composer.json`) | ✅ Plugin-based | ✅ 15+ languages | ❌ Node.js focused |
| **Setup complexity** | Low — 1 workflow file | High — many plugins | Medium — config files | Medium — CLI + bot |
| **Requires AI API key** | ✅ Anthropic key needed | ❌ | ❌ | ❌ |

---

## When to choose agentic-semver

**✅ Best fit when:**

- Your team does not follow (or want to enforce) conventional commit message formats
- You want meaningful, narrative changelog entries rather than template-generated ones
- You want the version bumped *on the PR* so reviewers see the intended version before merging
- You have a single Node.js, Python, Java, Rust, Helm, or PHP package and want zero manual release steps

**⚠️ Consider alternatives when:**

- You need monorepo support across many packages → use **changesets**
- You need to version projects in languages beyond those listed above (e.g. Go, .NET, Ruby) → use **release-please**
- You want no AI dependency and are happy with conventional commits → use **semantic-release**
- You want full control over when releases are cut (not every PR) → use **release-please** (batches changes into a Release PR)

---

## How the tools work side by side

### semantic-release

```yaml
developer writes: "feat: add pagination support"
                            ↓
             semantic-release reads "feat:" → minor bump
```

### release-please

```yaml
developer writes: "feat: add pagination support"
                            ↓
     release-please accumulates commits → opens a Release PR
     → merge the Release PR to publish
```

### changesets

```sh
developer runs: "changeset add" → selects bump type + writes description
                            ↓
        changeset bot opens a versioning PR
        → merge to publish
```

### agentic-semver

```ini
developer writes: any commit message, opens a PR with any description
                            ↓
     Claude reads the diff: new public API added → minor bump
     → CHANGELOG.md written, package.json bumped, PR labelled
     → merge → auto-published to npm + GitHub Release created
```

---

## Changelog quality

A representative example of the difference in changelog output:

**Template-based (semantic-release / release-please):**

```sh
* add pagination support (a1b2c3d)
```

**agentic-semver (AI-generated):**

```md
## 1.3.0 - 2026-06-08

- Summary: Adds cursor-based pagination to the search API, allowing clients
  to page through large result sets without offset drift.
- Add `cursor` and `pageSize` parameters to `GET /search`
- Return `nextCursor` in all paginated responses
- Maintain backwards compatibility — unpaginated calls continue to work
```

---

## Summary

`agentic-semver` trades an AI API cost (a few cents per PR) for **zero developer discipline requirements** and **higher quality, human-readable changelogs**. It is not trying to replace tools like `semantic-release` for large, multi-language monorepos — it is designed for the common case of a single package (Node.js, Python, Java, Rust, Helm, or PHP) where the overhead of commit conventions creates more friction than value.
