import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@actions/core';
import * as github from '@actions/github';

// ──────────────────────────────────────────────────────────────────────
// Version file detection & reading
// ──────────────────────────────────────────────────────────────────────

const VERSION_FILE_CANDIDATES = ['package.json', 'pyproject.toml', 'pom.xml', 'gradle.properties'];

export function detectVersionFile(workdir: string = process.cwd()): string {
  for (const candidate of VERSION_FILE_CANDIDATES) {
    const full = path.join(workdir, candidate);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  throw new Error(
    `Could not auto-detect a version file. ` +
      `Checked: ${VERSION_FILE_CANDIDATES.join(', ')}. ` +
      `Set the "version-file" input explicitly.`
  );
}

export function readVersionFromFile(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(filePath);

  if (basename === 'package.json') {
    const pkg = JSON.parse(content) as { version?: string };
    if (!pkg.version) throw new Error(`No "version" field in ${filePath}`);
    return pkg.version;
  }

  if (basename === 'pyproject.toml') {
    // Matches both [project] and [tool.poetry] version fields.
    const match = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(content);
    if (!match) throw new Error(`No version field found in ${filePath}`);
    return match[1];
  }

  if (basename === 'pom.xml') {
    // First <version> tag — works for standard Maven single-module projects.
    const match = /<version>\s*([^<]+?)\s*<\/version>/.exec(content);
    if (!match) throw new Error(`No <version> tag found in ${filePath}`);
    return match[1];
  }

  if (basename === 'gradle.properties') {
    const match = /^\s*version\s*=\s*(.+)/m.exec(content);
    if (!match) throw new Error(`No version= line found in ${filePath}`);
    return match[1].trim();
  }

  throw new Error(
    `Unsupported version file: ${basename}. ` +
      `Supported files: package.json, pyproject.toml, pom.xml, gradle.properties.`
  );
}

// ──────────────────────────────────────────────────────────────────────
// Changelog extraction
// ──────────────────────────────────────────────────────────────────────

export function extractChangelogSection(changelogContent: string, version: string): string {
  const lines = changelogContent.split('\n');
  const versionHeadingPattern = new RegExp(
    `^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`
  );

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (versionHeadingPattern.test(line)) {
      inSection = true;
      sectionLines.push(line);
      continue;
    }

    if (inSection) {
      if (/^## /.test(line)) break; // Next version section — stop.
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) {
    throw new Error(
      `No changelog section found for version ${version}. ` +
        `Expected a heading starting with "## ${version}".`
    );
  }

  return sectionLines.join('\n').trim();
}

// ──────────────────────────────────────────────────────────────────────
// Main action
// ──────────────────────────────────────────────────────────────────────

export async function runRelease(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', { required: true });
    const changelogPath = (core.getInput('changelog-path') || 'CHANGELOG.md').replace(/^\.\//, '');
    const versionFileInput = core.getInput('version-file').replace(/^\.\//, '');
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const draft = core.getBooleanInput('draft');
    const prerelease = core.getBooleanInput('prerelease');

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);

    // Resolve version file — use the provided path or auto-detect.
    const workdir = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const resolvedVersionFile = versionFileInput
      ? path.resolve(workdir, versionFileInput)
      : detectVersionFile(workdir);

    core.info(`Reading version from: ${resolvedVersionFile}`);
    const version = readVersionFromFile(resolvedVersionFile);
    core.info(`Detected version: ${version}`);

    const tag = `${tagPrefix}${version}`;
    core.setOutput('version', version);
    core.setOutput('tag', tag);

    // Idempotent check — skip if the release already exists.
    try {
      await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
      core.info(`Release ${tag} already exists — skipping.`);
      core.setOutput('released', 'false');
      return;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }

    // Extract changelog section for this version.
    const resolvedChangelogPath = path.resolve(workdir, changelogPath);
    if (!fs.existsSync(resolvedChangelogPath)) {
      throw new Error(`Changelog file not found: ${resolvedChangelogPath}`);
    }

    const changelogContent = fs.readFileSync(resolvedChangelogPath, 'utf8');
    const releaseNotes = extractChangelogSection(changelogContent, version);

    core.info(`Creating release ${tag}…`);
    await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: tag,
      body: releaseNotes,
      draft,
      prerelease
    });

    core.setOutput('released', 'true');
    core.info(`Release ${tag} created successfully.`);

    await core.summary
      .addHeading(`Released ${tag}`)
      .addRaw(`Created GitHub Release **${tag}**`)
      .addBreak()
      .addCodeBlock(releaseNotes, 'markdown')
      .write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runRelease();
}
