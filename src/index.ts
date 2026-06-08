import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type Anthropic from '@anthropic-ai/sdk';
import { detectVersionFile, readVersionFromFile, writeVersionToFile, VERSION_FILE_CANDIDATES } from './version-files.js';
import { writeChangelogEntry, upsertChangelogEntry } from './changelog.js';

// Re-export so consumers only need to import from this one entry point.
export { detectVersionFile, readVersionFromFile, writeVersionToFile, VERSION_FILE_CANDIDATES };
export { upsertChangelogEntry };

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

function calculateNextVersion(currentVersion: string, bump: string): string {
  const nextVersion = semver.inc(currentVersion, bump as semver.ReleaseType);
  if (!nextVersion) throw new Error(`Unable to calculate a ${bump} version from ${currentVersion}.`);
  return nextVersion;
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
  date
}: ApplyVersionRecommendationParams): ApplyVersionResult {
  const nextVersion = calculateNextVersion(baseVersion, recommendation.bump);

  writeVersionToFile(versionFilePath, nextVersion);

  // Keep package-lock.json in sync for Node.js projects.
  if (path.basename(versionFilePath) === 'package.json') {
    const lockPath = path.join(path.dirname(versionFilePath), 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        version: string;
        packages?: Record<string, { version: string }>;
      };
      lock.version = nextVersion;
      if (lock.packages?.['']) lock.packages[''].version = nextVersion;
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
  }

  const changelogEntry = writeChangelogEntry(
    changelogPath,
    nextVersion,
    recommendation.summary,
    recommendation.changelog,
    date
  );

  return { currentVersion: baseVersion, nextVersion, changelogEntry };
}

export function resolveRepositoryFile(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}
