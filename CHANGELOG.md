# Changelog

## 1.1.3 - 2026-08-19

- Summary: Fixed bug where package-lock.json changes were incorrectly included in semantic version analysis, causing the action to score its own automated lockfile updates as if they were contributor changes.
- Fixed package-lock.json being analyzed for semantic versioning when it should be ignored as action-generated content
- Extracted file filtering logic into testable `buildIgnoredPaths` function with 4 new test cases
- Ensured lockfile exclusion applies correctly for both root-level and nested package.json files
- Prevented false version bump recommendations from automated lockfile synchronization changes

## 1.1.2 - 2026-08-19

- Summary: Removes the [skip ci] token from bump commits and adds a loop guard to prevent infinite re-runs. This fixes a critical issue where the CI-skip token suppressed all workflows on the bump commit, preventing required status checks from running and potentially blocking PR merges.
- Fixed infinite loop caused by changelog regeneration on re-runs by adding `isOwnBumpCommit` guard that recognizes the action's own commits
- Removed `[skip ci]` token from bump commits to allow required status checks to run on pull requests
- Added early exit in workflow when pull request head is the action's own bump commit, preventing unnecessary Claude API calls
- Updated workflow path-ignore documentation to clarify it only filters whole-PR-diff matches, not individual commits

## 1.1.1 - 2026-08-19

- Summary: Fixed critical packaging issue preventing the action from running when referenced via `uses: PramodKumarYadav/agentic-semver@v1`. The action manifests pointed to `dist/` which was gitignored and missing from all releases, causing 'File not found' errors for all external users. This patch bundles both entrypoints with @vercel/ncc into a committed `bundle/` directory, adds CI verification to prevent stale bundles, and implements automatic floating major version tag management.
- Fixed action packaging: bundle JavaScript with all dependencies into committed `bundle/` directory so GitHub Actions can run the action without a build step
- Added CI workflow to verify committed bundles stay in sync with source code and run tests on pull requests
- Added automatic floating major version tag (`v1`) management in publish workflow to keep README examples working
- Fixed commit strategy to place version bumps directly on PR head branch instead of merge commit, preventing unrelated changes from reaching contributor branches
- Changed default for `comment-summary` input from `false` to `true` to improve user visibility of version recommendations
## 1.1.0 - 2026-06-09

- Summary: Added multi-language version file support for Rust (Cargo.toml), Helm (Chart.yaml), and PHP (composer.json), expanding compatibility beyond existing Node.js, Python, and Java support.
- Added support for Rust projects via Cargo.toml version file detection and updates
- Added support for Helm/Kubernetes charts via Chart.yaml version file detection and updates
- Added support for PHP projects via composer.json version file detection and updates
- Enhanced version file parsers to correctly handle nested version fields in dependencies sections
- Updated documentation to reflect expanded multi-language capabilities
## 1.0.2 - 2026-06-08

- Summary: Renamed GitHub workflow from 'Publish npm package' to 'Create GitHub Release and Publish package to npm' for better clarity
- Updated workflow name to better describe its dual purpose of creating GitHub releases and publishing to npm
- Internal workflow naming improvement with no functional changes

## 1.0.1 - 2026-06-08

- Summary: Updated README.md with improved documentation structure, badges, and clearer explanations of the agentic-semver workflow and features. No code changes or functionality modifications.
- Added GitHub Marketplace and license badges to README
- Reorganized documentation with clearer action comparison table and workflow diagrams
- Enhanced getting started instructions and prerequisites section
- Improved formatting and readability throughout documentation

## 1.0.0 - 2026-06-08

- Summary: Breaking changes to input parameter names and multi-language version file support. Renamed `package-json-path` to `version-file-path` and `version-file` to `version-file-path` for consistency. Added automatic detection and support for Python (pyproject.toml), Java (pom.xml), and Gradle (gradle.properties) version files alongside Node.js (package.json). Refactored codebase with new modules for version file handling and changelog management.
- Breaking: renamed action input `package-json-path` to `version-file-path` for consistency
- Breaking: renamed create-release action input `version-file` to `version-file-path`
- Added automatic version file detection supporting package.json, pyproject.toml, pom.xml, and gradle.properties
- Extracted version file handling into dedicated `version-files.ts` module with extensible handler registry
- Extracted changelog operations into dedicated `changelog.ts` module for improved maintainability
## 0.3.0 - 2026-06-08

- Summary: Added a new standalone create-release GitHub Action that automatically creates GitHub Releases from version files and changelog, supporting multiple ecosystems (Node.js, Python, Java). This is a new backwards-compatible capability alongside the existing semver analysis action.
- Added `create-release` action for automated GitHub Release creation from version files and CHANGELOG.md
- Implemented multi-language version file detection supporting package.json, pyproject.toml, pom.xml, and gradle.properties
- Added idempotent release creation that safely skips when releases already exist
- Updated publish workflow to use the new create-release action instead of manual shell scripting
- Added comprehensive test coverage for version file detection and changelog extraction
## 0.2.1 - 2026-06-08

- Summary: Fixed release workflow to automatically publish on version bumps and added comprehensive documentation comparing agentic-semver with alternative tools
- Fixed publish workflow to run on every push to main and automatically create GitHub releases with changelog entries
- Added check to prevent duplicate releases when version already exists
- Added COMPARISON.md documenting differences between agentic-semver and semantic-release, release-please, and changesets
- Added documentation for action outputs and multi-language usage examples
- Enhanced publish workflow with build step, npm provenance, and improved error handling
## 0.2.0 - 2026-06-08

- Summary: Added automatic version label application to pull requests, allowing the action to label PRs with 'major', 'minor', or 'patch' based on the recommended semantic version bump.
- Added `apply-label` input (default: true) to automatically apply version labels to pull requests
- Added `issues: write` permission requirement for label management
- Implemented label creation, updating, and cleanup logic to ensure only one semver label is applied per PR
- Added comprehensive test coverage for label application functionality
## 0.1.1 - 2026-06-08

- Summary: Fix CI/CD pipeline configuration and migrate codebase to TypeScript
- Fix GitHub Actions workflow configuration by removing incorrect secret checks and adding build step
- Migrate JavaScript codebase to TypeScript for improved type safety
- Update action entry point to use compiled dist/action.js instead of src/action.js
- Add dist/ directory to .gitignore and update package name to @pramodyadav027/agentic-semver

## 0.1.0 - 2026-06-08

- Summary: Initial release of the agentic semver library and GitHub Action.
- Added Claude-powered pull request analysis to recommend patch, minor, or major version bumps.
- Added automated package.json and CHANGELOG.md updates for pull requests targeting main.
- Added a release workflow that can publish the npm package when a GitHub release is published.
