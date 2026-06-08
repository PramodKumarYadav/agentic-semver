# Changelog

## 1.0.0 - 2026-06-08

- Summary: First stable release with breaking changes to input names and multi-language version file support. The action now auto-detects version files across Node.js, Python, Java, and Gradle projects, and renames package-json-path to version-file-path.
- Breaking: Renamed input `package-json-path` to `version-file-path` for multi-language support
- Added auto-detection and support for pyproject.toml, pom.xml, and gradle.properties version files
- Refactored version file handling into dedicated `version-files.ts` and changelog logic into `changelog.ts` modules
- Updated version from 0.3.0 to 1.0.0 marking first stable release
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
