# Changelog

## 0.2.0 - 2026-06-08

- Summary: Added new opt-in capability to automatically apply semver labels (major, minor, or patch) to pull requests based on the recommended version bump.
- Added `apply-label` input parameter (defaults to `true`) to control automatic PR labeling
- Implemented `applyVersionLabel` function to create/update and apply color-coded semver labels to PRs
- Added automatic cleanup of conflicting semver labels when applying a new version label
- Added comprehensive test coverage for the new label application functionality

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
