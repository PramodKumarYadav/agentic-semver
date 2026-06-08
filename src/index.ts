import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type Anthropic from '@anthropic-ai/sdk';

const SUPPORTED_BUMPS = new Set<string>(['patch', 'minor', 'major']);
const MAX_PATCH_CHARACTERS = 4000;
const DEFAULT_SYSTEM_PROMPT = [
  'You are a release automation specialist.',
  'Review the pull request changes and decide whether the release impact is patch, minor, or major.',
  'Major means a breaking change or removed compatibility.',
  'Minor means a new backwards-compatible capability.',
  'Patch means a backwards-compatible bug fix, maintenance update, or internal improvement.',
  'Respond with valid JSON only using the shape {"bump":"patch|minor|major","summary":"...","changelog":["..."]}.',
  'Return 2-5 changelog bullet points and keep each bullet concise and factual.'
].join(' ');

export type BumpType = 'patch' | 'minor' | 'major';

export interface PullRequestInfo {
  number: number;
  title: string;
  body?: string | null;
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface AnalysisRecommendation {
  bump: BumpType;
  summary: string;
  changelog: string[];
}

export interface ApplyVersionResult {
  currentVersion: string;
  nextVersion: string;
  changelogEntry: string;
}

interface BuildAnalysisPromptParams {
  repositoryFullName: string;
  baseRef: string;
  headRef: string;
  currentVersion: string;
  pullRequest: PullRequestInfo;
  files: ChangedFile[];
  maxFiles?: number;
}

function buildAnalysisPrompt({
  repositoryFullName,
  baseRef,
  headRef,
  currentVersion,
  pullRequest,
  files,
  maxFiles = 40
}: BuildAnalysisPromptParams): string {
  const selectedFiles = files.slice(0, maxFiles).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch
      ? `${file.patch.slice(0, MAX_PATCH_CHARACTERS)}${file.patch.length > MAX_PATCH_CHARACTERS ? '\n...[patch truncated]' : ''}`
      : '[patch omitted by GitHub API]'
  }));

  return [
    `Repository: ${repositoryFullName}`,
    `Base branch: ${baseRef}`,
    `Head branch: ${headRef}`,
    `Current version: ${currentVersion}`,
    `Pull request: #${pullRequest.number} - ${pullRequest.title}`,
    `Pull request body:\n${pullRequest.body ?? '[no description provided]'}`,
    'Changed files:',
    JSON.stringify(selectedFiles, null, 2)
  ].join('\n\n');
}

interface ContentBlock {
  type: string;
  text?: string;
}

function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }

  return (content ?? [])
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n');
}

export function parseAnalysisResponse(responseText: string): AnalysisRecommendation {
  const trimmed = responseText.trim();
  let candidate = trimmed;

  if (candidate.startsWith('```')) {
    const lines = candidate.split('\n');
    const firstLine = lines[0].trim().toLowerCase();
    const lastLine = lines[lines.length - 1].trim();

    if ((firstLine === '```' || firstLine === '```json') && lastLine === '```') {
      candidate = lines.slice(1, -1).join('\n').trim();
    }
  }

  const firstBraceIndex = candidate.indexOf('{');
  const lastBraceIndex = candidate.lastIndexOf('}');
  if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
    candidate = candidate.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  const payload = JSON.parse(candidate) as Record<string, unknown>;
  const bump = String(payload.bump ?? '').toLowerCase();

  if (!SUPPORTED_BUMPS.has(bump)) {
    throw new Error(`Claude returned an unsupported bump type: ${String(payload.bump)}`);
  }

  const summary = String(payload.summary ?? '').replace(/\s+/g, ' ').trim();
  if (!summary) {
    throw new Error('Claude response is missing a summary.');
  }

  const changelog = Array.isArray(payload.changelog)
    ? (payload.changelog as unknown[])
        .map((item) => String(item).replace(/\s+/g, ' ').trim())
        .filter((item) => item && !/^#{1,6}\s/.test(item) && !/^```/.test(item))
    : [];

  if (changelog.length === 0) {
    throw new Error('Claude response is missing changelog entries.');
  }

  return { bump: bump as BumpType, summary, changelog };
}

export interface AnalyzePullRequestParams {
  anthropic: Anthropic;
  model: string;
  repositoryFullName: string;
  baseRef: string;
  headRef: string;
  currentVersion: string;
  pullRequest: PullRequestInfo;
  files: ChangedFile[];
  maxFiles?: number;
}

export async function analyzePullRequest(params: AnalyzePullRequestParams): Promise<AnalysisRecommendation> {
  const prompt = buildAnalysisPrompt(params);

  const message = await params.anthropic.messages.create({
    model: params.model,
    max_tokens: 1200,
    system: DEFAULT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  return parseAnalysisResponse(extractTextContent(message.content as ContentBlock[]));
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    // Scope the search to [project] or [tool.poetry] sections only.
    const match = /^\[(project|tool\.poetry)\][^\[]*?^\s*version\s*=\s*["']([^"']+)["']/m.exec(content);
    if (!match) throw new Error(`No version field found in ${filePath}`);
    return match[2];
  }

  if (basename === 'pom.xml') {
    // Strip <parent>...</parent> first to avoid picking up the parent version.
    const withoutParent = content.replace(/<parent>[\s\S]*?<\/parent>/i, '');
    const match = /<version>\s*([^<]+?)\s*<\/version>/.exec(withoutParent);
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

const VERSION_FILE_CANDIDATES = ['package.json', 'pyproject.toml', 'pom.xml', 'gradle.properties'];

export function detectVersionFile(workdir: string = process.cwd()): string {
  for (const candidate of VERSION_FILE_CANDIDATES) {
    const full = path.join(workdir, candidate);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    `Could not auto-detect a version file. ` +
      `Checked: ${VERSION_FILE_CANDIDATES.join(', ')}. ` +
      `Set the "version-file" input explicitly.`
  );
}

export function writeVersionToFile(filePath: string, version: string): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(filePath);

  if (basename === 'package.json') {
    const pkg = readJsonFile(filePath);
    pkg.version = version;
    writeJsonFile(filePath, pkg);
    return;
  }

  if (basename === 'pyproject.toml') {
    // Replace the version line inside [project] or [tool.poetry] only.
    const updated = content.replace(
      /(^\[(project|tool\.poetry)\][^\[]*?^\s*version\s*=\s*)["'][^"']+["']/ms,
      (_, prefix) => `${prefix}"${version}"`
    );
    if (updated === content) throw new Error(`Could not update version in ${filePath}`);
    fs.writeFileSync(filePath, updated);
    return;
  }

  if (basename === 'pom.xml') {
    // Replace the project <version> tag, skipping any <parent> block.
    const withoutParent = content.replace(/(<parent>[\s\S]*?<\/parent>)/i, (match) => match.replace(/</g, '\x00'));
    const updated = withoutParent.replace(/<version>[^<]+<\/version>/, `<version>${version}<\/version>`);
    if (updated === withoutParent) throw new Error(`Could not update <version> in ${filePath}`);
    fs.writeFileSync(filePath, updated.replace(/\x00/g, '<'));
    return;
  }

  if (basename === 'gradle.properties') {
    const updated = content.replace(/^(\s*version\s*=\s*).+/m, `$1${version}`);
    if (updated === content) throw new Error(`Could not update version in ${filePath}`);
    fs.writeFileSync(filePath, updated);
    return;
  }

  throw new Error(
    `Unsupported version file: ${basename}. ` +
      `Supported files: package.json, pyproject.toml, pom.xml, gradle.properties.`
  );
}

function calculateNextVersion(currentVersion: string, bump: string): string {
  const nextVersion = semver.inc(currentVersion, bump as semver.ReleaseType);

  if (!nextVersion) {
    throw new Error(`Unable to calculate a ${bump} version from ${currentVersion}.`);
  }

  return nextVersion;
}

function formatDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

interface CreateChangelogEntryParams {
  version: string;
  summary: string;
  changelog: string[];
  date?: string;
}

function createChangelogEntry({ version, summary, changelog, date = formatDate() }: CreateChangelogEntryParams): string {
  return [
    `## ${version} - ${date}`,
    '',
    `- Summary: ${summary}`,
    ...changelog.map((item) => `- ${item}`),
    ''
  ].join('\n');
}

export function upsertChangelogEntry(existingContent: string, entry: string, version: string): string {
  const heading = `## ${version} - `;
  const normalizedEntry = entry.trimEnd();

  if (!existingContent.trim()) {
    return `# Changelog\n\n${normalizedEntry}\n`;
  }

  const header = existingContent.startsWith('# Changelog') ? '# Changelog\n\n' : '';
  const body = existingContent.startsWith('# Changelog')
    ? existingContent.replace(/^# Changelog\n\n?/, '')
    : existingContent;

  if (body.includes(heading)) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(`${escapedHeading}[\\s\\S]*?(?=\\n## |$)`);
    const updatedBody = body.replace(sectionPattern, normalizedEntry);
    return `${header}${updatedBody.trimEnd()}\n`;
  }

  return `${header}${normalizedEntry}\n\n${body.trimStart()}`;
}

export interface ApplyVersionRecommendationParams {
  versionFilePath: string;
  changelogPath: string;
  baseVersion: string;
  recommendation: AnalysisRecommendation;
  date?: string;
}

export function applyVersionRecommendation({
  versionFilePath,
  changelogPath,
  baseVersion,
  recommendation,
  date = formatDate()
}: ApplyVersionRecommendationParams): ApplyVersionResult {
  const nextVersion = calculateNextVersion(baseVersion, recommendation.bump);

  writeVersionToFile(versionFilePath, nextVersion);

  // For Node.js projects keep package-lock.json in sync.
  if (path.basename(versionFilePath) === 'package.json') {
    const lockPath = path.join(path.dirname(versionFilePath), 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      const lock = readJsonFile(lockPath) as {
        version: string;
        packages?: Record<string, { version: string }>;
      };
      lock.version = nextVersion;
      if (lock.packages?.['']) {
        lock.packages[''].version = nextVersion;
      }
      writeJsonFile(lockPath, lock);
    }
  }

  const existingChangelog = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, 'utf8')
    : '';

  const changelogEntry = createChangelogEntry({
    version: nextVersion,
    summary: recommendation.summary,
    changelog: recommendation.changelog,
    date
  });

  fs.writeFileSync(changelogPath, upsertChangelogEntry(existingChangelog, changelogEntry, nextVersion));

  return { currentVersion: baseVersion, nextVersion, changelogEntry };
}

export function resolveRepositoryFile(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}
