# Changelog

## 0.2.1 - 2026-06-08

- Summary: Fixed release workflow to trigger on push to main instead of release publication, with automatic version detection and GitHub release creation
- Changed publish workflow trigger from release publication to push on main branch for automated releases
- Added version existence check to prevent duplicate releases when same version is pushed multiple times
- Added automatic GitHub release creation with changelog notes extracted from CHANGELOG.md
- Added build step and npm provenance support to publish workflow
- Added comprehensive comparison documentation explaining differences from semantic-release, release-please, and changesets

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
