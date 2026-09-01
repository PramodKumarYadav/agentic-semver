/**
 * diff-filter.ts
 *
 * Selecting the files worth showing Claude. Shared by the pull request action
 * and the post-merge fallback analysis.
 *
 * These live apart from either action on purpose. Both actions are bundled
 * separately, and anything one imports from the other is dragged wholesale into
 * its bundle — so a helper shared through an action module pulls that action's
 * entire entry path along with it.
 */

import path from 'node:path';
import type { ChangedFile } from './index.js';

/**
 * Paths to drop from the diff before asking Claude to classify it.
 *
 * These are all files this action writes itself, so feeding them back in would
 * be scoring our own output as if it were user code. Returned relative to
 * `workdir` to match the `filename` values GitHub reports for a pull request.
 */
export function buildIgnoredPaths(workdir: string, versionFilePath: string, changelogPath: string): string[] {
  const ignored = [versionFilePath, changelogPath];

  // applyVersionRecommendation keeps package-lock.json in step with package.json,
  // so the lockfile diff is ours too — and a dependency-free version bump still
  // shows up there as a change.
  if (path.basename(versionFilePath) === 'package.json') {
    ignored.push(path.join(path.dirname(versionFilePath), 'package-lock.json'));
  }

  return ignored.map((filePath) => path.relative(workdir, filePath));
}

export function filterRelevantFiles(files: ChangedFile[], ignoredPaths: string[]): ChangedFile[] {
  const ignored = new Set(ignoredPaths.map((filePath) => filePath.replace(/^\.\//, '')));
  return files.filter((file) => !ignored.has(file.filename));
}
