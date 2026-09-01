/**
 * metadata.ts
 *
 * The handoff between the two halves of the action.
 *
 * The pull request run decides the bump and writes the changelog prose, but it
 * no longer commits anything — the version file can only be incremented safely
 * once, serially, against main. So the recommendation is parked in an HTML
 * comment inside the summary comment and read back by the post-merge run.
 *
 * What is stored is the recommendation, never a rendered changelog entry. The
 * entry heading carries a version and a date that are only knowable after the
 * merge: another pull request may land first and take the version this run
 * predicted. Storing the raw summary and bullets lets the post-merge run render
 * the heading from facts it can see, while the prose stays exactly the text a
 * reviewer read on the pull request.
 */

import type { AnalysisRecommendation, BumpType } from './index.js';

const MARKER = 'agentic-semver:v1';
const BLOCK_PATTERN = new RegExp(`<!--\\s*${MARKER}\\s*([\\s\\S]*?)-->`, 'g');

const SUPPORTED_BUMPS = new Set<string>(['patch', 'minor', 'major']);

/**
 * Renders the recommendation as an HTML comment safe to embed in a comment body.
 *
 * Every `>` is emitted as its `>` escape. That is still valid JSON, and it
 * is the only thing standing between a summary that happens to contain `-->`
 * and a block that terminates early and takes the rest of the comment with it.
 */
export function serializeMetadata(recommendation: AnalysisRecommendation): string {
  const json = JSON.stringify({
    bump: recommendation.bump,
    summary: recommendation.summary,
    changelog: recommendation.changelog
  }).replace(/>/g, '\\u003e');

  return `<!-- ${MARKER}\n${json}\n-->`;
}

/**
 * Recovers the recommendation from a comment body, or null when there is none.
 *
 * The last well-formed block wins. Every push to the pull request posts a fresh
 * comment, so the newest block is the one describing the diff that was merged.
 */
export function parseMetadata(body: string): AnalysisRecommendation | null {
  let recovered: AnalysisRecommendation | null = null;

  for (const match of body.matchAll(BLOCK_PATTERN)) {
    const parsed = parseBlockPayload(match[1]);
    if (parsed) {
      recovered = parsed;
    }
  }

  return recovered;
}

function parseBlockPayload(payload: string): AnalysisRecommendation | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.trim());
  } catch {
    return null;
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return null;
  }

  const { bump, summary, changelog } = decoded as Record<string, unknown>;

  if (typeof bump !== 'string' || !SUPPORTED_BUMPS.has(bump)) {
    return null;
  }

  if (typeof summary !== 'string' || !summary.trim()) {
    return null;
  }

  if (!Array.isArray(changelog) || changelog.length === 0) {
    return null;
  }

  const bullets = changelog.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  if (bullets.length === 0) {
    return null;
  }

  return { bump: bump as BumpType, summary: summary.trim(), changelog: bullets };
}

interface CommentLike {
  body?: string | null;
}

/** Scans a pull request's comments newest-last and returns the latest recommendation. */
export function recoverRecommendation(comments: CommentLike[]): AnalysisRecommendation | null {
  let recovered: AnalysisRecommendation | null = null;

  for (const comment of comments) {
    const parsed = comment.body ? parseMetadata(comment.body) : null;
    if (parsed) {
      recovered = parsed;
    }
  }

  return recovered;
}
