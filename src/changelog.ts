/**
 * changelog.ts
 *
 * Functions for creating and upserting CHANGELOG.md entries.
 */

import fs from 'node:fs';

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function formatDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function createChangelogEntry(version: string, summary: string, changelog: string[], date: string): string {
  return [
    `## ${version} - ${date}`,
    '',
    `- Summary: ${summary}`,
    ...changelog.map((item) => `- ${item}`),
    ''
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Inserts or replaces the changelog section for `version` inside `existingContent`.
 * Preserves the `# Changelog` header and all other version sections.
 */
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
    return `${header}${body.replace(sectionPattern, normalizedEntry).trimEnd()}\n`;
  }

  return `${header}${normalizedEntry}\n\n${body.trimStart()}`;
}

/**
 * Writes a new changelog entry for `version` into the file at `changelogPath`.
 * Creates the file if it does not exist. Returns the markdown entry that was written.
 */
export function writeChangelogEntry(
  changelogPath: string,
  version: string,
  summary: string,
  changelog: string[],
  date: string = formatDate()
): string {
  const existingContent = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const entry = createChangelogEntry(version, summary, changelog, date);
  fs.writeFileSync(changelogPath, upsertChangelogEntry(existingContent, entry, version));
  return entry;
}
