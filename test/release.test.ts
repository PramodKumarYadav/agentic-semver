import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { detectVersionFile, readVersionFromFile, extractChangelogSection } from '../src/release.js';

// ---------------------------------------------------------------------------
// detectVersionFile
// ---------------------------------------------------------------------------

test('detectVersionFile finds package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(detectVersionFile(dir), path.join(dir, 'package.json'));
  fs.rmSync(dir, { recursive: true });
});

test('detectVersionFile finds pyproject.toml when no package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nversion = "2.0.0"\n');
  assert.equal(detectVersionFile(dir), path.join(dir, 'pyproject.toml'));
  fs.rmSync(dir, { recursive: true });
});

test('detectVersionFile throws when no supported file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  assert.throws(() => detectVersionFile(dir), /Could not auto-detect/);
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// readVersionFromFile
// ---------------------------------------------------------------------------

test('readVersionFromFile reads package.json', () => {
  const file = path.join(os.tmpdir(), 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'my-pkg', version: '1.2.3' }));
  assert.equal(readVersionFromFile(file), '1.2.3');
  fs.rmSync(file);
});

test('readVersionFromFile throws when package.json has no version', () => {
  const file = path.join(os.tmpdir(), 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'my-pkg' }));
  assert.throws(() => readVersionFromFile(file), /No "version" field/);
  fs.rmSync(file);
});

test('readVersionFromFile reads pyproject.toml [project] version', () => {
  const file = path.join(os.tmpdir(), 'pyproject.toml');
  fs.writeFileSync(file, '[project]\nname = "my-app"\nversion = "3.1.0"\n');
  assert.equal(readVersionFromFile(file), '3.1.0');
  fs.rmSync(file);
});

test('readVersionFromFile reads pyproject.toml [tool.poetry] version', () => {
  const file = path.join(os.tmpdir(), 'pyproject.toml');
  fs.writeFileSync(file, '[tool.poetry]\nname = "my-app"\nversion = "4.0.0-alpha"\n');
  assert.equal(readVersionFromFile(file), '4.0.0-alpha');
  fs.rmSync(file);
});

test('readVersionFromFile throws when pyproject.toml has no version', () => {
  const file = path.join(os.tmpdir(), 'pyproject.toml');
  fs.writeFileSync(file, '[project]\nname = "my-app"\n');
  assert.throws(() => readVersionFromFile(file), /No version field found/);
  fs.rmSync(file);
});

test('readVersionFromFile reads pom.xml version', () => {
  const file = path.join(os.tmpdir(), 'pom.xml');
  fs.writeFileSync(file, '<project>\n  <groupId>com.example</groupId>\n  <version>2.5.0</version>\n</project>\n');
  assert.equal(readVersionFromFile(file), '2.5.0');
  fs.rmSync(file);
});

test('readVersionFromFile throws when pom.xml has no version', () => {
  const file = path.join(os.tmpdir(), 'pom.xml');
  fs.writeFileSync(file, '<project><groupId>com.example</groupId></project>\n');
  assert.throws(() => readVersionFromFile(file), /No <version> tag found/);
  fs.rmSync(file);
});

test('readVersionFromFile reads gradle.properties version', () => {
  const file = path.join(os.tmpdir(), 'gradle.properties');
  fs.writeFileSync(file, 'group=com.example\nversion=1.0.5\n');
  assert.equal(readVersionFromFile(file), '1.0.5');
  fs.rmSync(file);
});

test('readVersionFromFile throws for unsupported file type', () => {
  const file = path.join(os.tmpdir(), 'build.gradle');
  fs.writeFileSync(file, "version = '1.0.0'\n");
  assert.throws(() => readVersionFromFile(file), /Unsupported version file/);
  fs.rmSync(file);
});

// ---------------------------------------------------------------------------
// extractChangelogSection
// ---------------------------------------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

## 1.2.3 - 2026-06-01

- Summary: Bug fixes and improvements
- Fixed login timeout issue
- Improved error messages

## 1.2.2 - 2026-05-15

- Summary: Minor patch
- Updated dependencies
`;

test('extractChangelogSection returns the matching section', () => {
  const result = extractChangelogSection(SAMPLE_CHANGELOG, '1.2.3');
  assert.ok(result.startsWith('## 1.2.3 - 2026-06-01'));
  assert.ok(result.includes('Fixed login timeout issue'));
  assert.ok(!result.includes('1.2.2'));
});

test('extractChangelogSection stops at the next version heading', () => {
  const result = extractChangelogSection(SAMPLE_CHANGELOG, '1.2.3');
  assert.ok(!result.includes('## 1.2.2'));
  assert.ok(!result.includes('Updated dependencies'));
});

test('extractChangelogSection extracts the last section (no trailing heading)', () => {
  const result = extractChangelogSection(SAMPLE_CHANGELOG, '1.2.2');
  assert.ok(result.includes('Updated dependencies'));
});

test('extractChangelogSection throws when version not found', () => {
  assert.throws(
    () => extractChangelogSection(SAMPLE_CHANGELOG, '9.9.9'),
    /No changelog section found for version 9\.9\.9/
  );
});

test('extractChangelogSection handles version with regex special chars', () => {
  const changelog = `# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- Initial release\n`;
  const result = extractChangelogSection(changelog, '1.0.0');
  assert.ok(result.includes('Initial release'));
});
