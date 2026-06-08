const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const SUPPORTED_BUMPS = new Set(['patch', 'minor', 'major']);
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

function buildAnalysisPrompt({ repositoryFullName, baseRef, headRef, currentVersion, pullRequest, files, maxFiles = 40 }) {
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
    `Pull request body:\n${pullRequest.body || '[no description provided]'}`,
    'Changed files:',
    JSON.stringify(selectedFiles, null, 2)
  ].join('\n\n');
}

function extractTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  return (content || [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function parseAnalysisResponse(responseText) {
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

  const payload = JSON.parse(candidate);
  const bump = String(payload.bump || '').toLowerCase();

  if (!SUPPORTED_BUMPS.has(bump)) {
    throw new Error(`Claude returned an unsupported bump type: ${payload.bump}`);
  }

  const summary = String(payload.summary || '').replace(/\s+/g, ' ').trim();
  if (!summary) {
    throw new Error('Claude response is missing a summary.');
  }

  const changelog = Array.isArray(payload.changelog)
    ? payload.changelog
        .map((item) => String(item).replace(/\s+/g, ' ').trim())
        .filter((item) => item && !/^#{1,6}\s/.test(item) && !/^```/.test(item))
    : [];

  if (changelog.length === 0) {
    throw new Error('Claude response is missing changelog entries.');
  }

  return { bump, summary, changelog };
}

async function analyzePullRequest({ anthropic, model, repositoryFullName, baseRef, headRef, currentVersion, pullRequest, files, maxFiles }) {
  const prompt = buildAnalysisPrompt({
    repositoryFullName,
    baseRef,
    headRef,
    currentVersion,
    pullRequest,
    files,
    maxFiles
  });

  const message = await anthropic.messages.create({
    model,
    max_tokens: 1200,
    system: DEFAULT_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  return parseAnalysisResponse(extractTextContent(message.content));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readPackageVersion(packageJsonPath) {
  return readJsonFile(packageJsonPath).version;
}

function calculateNextVersion(currentVersion, bump) {
  const nextVersion = semver.inc(currentVersion, bump);

  if (!nextVersion) {
    throw new Error(`Unable to calculate a ${bump} version from ${currentVersion}.`);
  }

  return nextVersion;
}

function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function createChangelogEntry({ version, summary, changelog, date = formatDate() }) {
  return [
    `## ${version} - ${date}`,
    '',
    `- Summary: ${summary}`,
    ...changelog.map((item) => `- ${item}`),
    ''
  ].join('\n');
}

function upsertChangelogEntry(existingContent, entry, version) {
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

function applyVersionRecommendation({ packageJsonPath, changelogPath, baseVersion, recommendation, date = formatDate() }) {
  const packageJson = readJsonFile(packageJsonPath);
  const nextVersion = calculateNextVersion(baseVersion, recommendation.bump);
  packageJson.version = nextVersion;
  writeJsonFile(packageJsonPath, packageJson);

  const lockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = readJsonFile(lockPath);
    lock.version = nextVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = nextVersion;
    }
    writeJsonFile(lockPath, lock);
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

  return {
    currentVersion: baseVersion,
    nextVersion,
    changelogEntry
  };
}

function resolveRepositoryFile(filePath) {
  return path.resolve(process.cwd(), filePath);
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  analyzePullRequest,
  applyVersionRecommendation,
  buildAnalysisPrompt,
  calculateNextVersion,
  createChangelogEntry,
  extractTextContent,
  formatDate,
  parseAnalysisResponse,
  readPackageVersion,
  resolveRepositoryFile,
  upsertChangelogEntry
};
