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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'my-pkg', version: '1.2.3' }));
  assert.equal(readVersionFromFile(file), '1.2.3');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when package.json has no version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'my-pkg' }));
  assert.throws(() => readVersionFromFile(file), /No "version" field/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads pyproject.toml [project] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[project]\nname = "my-app"\nversion = "3.1.0"\n');
  assert.equal(readVersionFromFile(file), '3.1.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads pyproject.toml [tool.poetry] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[tool.poetry]\nname = "my-app"\nversion = "4.0.0-alpha"\n');
  assert.equal(readVersionFromFile(file), '4.0.0-alpha');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile ignores version fields outside [project]/[tool.poetry] in pyproject.toml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pyproject.toml');
  // version in [build-system] should be ignored; version in [project] should be returned.
  fs.writeFileSync(file, '[build-system]\nrequires = ["setuptools>=61"]\n[project]\nname = "my-app"\nversion = "5.0.0"\n');
  assert.equal(readVersionFromFile(file), '5.0.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when pyproject.toml has no version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[project]\nname = "my-app"\n');
  assert.throws(() => readVersionFromFile(file), /No version field found/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads pom.xml version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pom.xml');
  fs.writeFileSync(file, '<project>\n  <groupId>com.example</groupId>\n  <version>2.5.0</version>\n</project>\n');
  assert.equal(readVersionFromFile(file), '2.5.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads project version when pom.xml has a <parent> block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pom.xml');
  const content = [
    '<project>',
    '  <parent>',
    '    <groupId>org.springframework.boot</groupId>',
    '    <version>3.2.0</version>',
    '  </parent>',
    '  <groupId>com.example</groupId>',
    '  <version>2.5.0</version>',
    '</project>'
  ].join('\n');
  fs.writeFileSync(file, content);
  assert.equal(readVersionFromFile(file), '2.5.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when pom.xml has no version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'pom.xml');
  fs.writeFileSync(file, '<project><groupId>com.example</groupId></project>\n');
  assert.throws(() => readVersionFromFile(file), /No <version> tag found/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads gradle.properties version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'gradle.properties');
  fs.writeFileSync(file, 'group=com.example\nversion=1.0.5\n');
  assert.equal(readVersionFromFile(file), '1.0.5');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads Cargo.toml [package] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, '[package]\nname = "my-crate"\nversion = "0.3.1"\nedition = "2021"\n');
  assert.equal(readVersionFromFile(file), '0.3.1');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile ignores version fields outside [package] in Cargo.toml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'Cargo.toml');
  const content = '[package]\nname = "my-crate"\nversion = "1.0.0"\n\n[dependencies]\nserde = { version = "1.0" }\n';
  fs.writeFileSync(file, content);
  assert.equal(readVersionFromFile(file), '1.0.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when Cargo.toml has no [package] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, '[package]\nname = "my-crate"\n');
  assert.throws(() => readVersionFromFile(file), /No version field found in \[package\]/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads Chart.yaml version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'Chart.yaml');
  fs.writeFileSync(file, 'apiVersion: v2\nname: my-chart\nversion: 2.1.0\n');
  assert.equal(readVersionFromFile(file), '2.1.0');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when Chart.yaml has no version field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'Chart.yaml');
  fs.writeFileSync(file, 'apiVersion: v2\nname: my-chart\n');
  assert.throws(() => readVersionFromFile(file), /No version field found in Chart\.yaml/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile reads composer.json version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'composer.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'vendor/pkg', version: '1.4.2' }));
  assert.equal(readVersionFromFile(file), '1.4.2');
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws when composer.json has no version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'composer.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'vendor/pkg' }));
  assert.throws(() => readVersionFromFile(file), /No "version" field in composer\.json/);
  fs.rmSync(dir, { recursive: true });
});

test('readVersionFromFile throws for unsupported file type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const file = path.join(dir, 'build.gradle');
  fs.writeFileSync(file, "version = '1.0.0'\n");
  assert.throws(() => readVersionFromFile(file), /Unsupported version file/);
  fs.rmSync(dir, { recursive: true });
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
