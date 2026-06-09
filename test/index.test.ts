import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVersionRecommendation, parseAnalysisResponse, upsertChangelogEntry, writeVersionToFile } from '../src/index.js';

test('parseAnalysisResponse accepts fenced JSON', () => {
  const result = parseAnalysisResponse(
    ['```json', '{"bump":"minor","summary":"Adds a new public capability","changelog":["Adds a new CLI command","Keeps existing calls compatible"]}', '```'].join('\n')
  );

  assert.deepEqual(result, {
    bump: 'minor',
    summary: 'Adds a new public capability',
    changelog: ['Adds a new CLI command', 'Keeps existing calls compatible']
  });
});

test('applyVersionRecommendation updates package.json and changelog idempotently', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-semver-'));
  const packageJsonPath = path.join(tempDir, 'package.json');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2));
  fs.writeFileSync(changelogPath, '# Changelog\n\n## 1.2.3 - 2026-06-01\n\n- Summary: Previous release\n');

  const recommendation = {
    bump: 'minor' as const,
    summary: 'Adds a backwards-compatible feature',
    changelog: ['Introduces generated changelog output', 'Keeps existing API behaviour intact']
  };

  const firstRun = applyVersionRecommendation({ versionFilePath: packageJsonPath, changelogPath, baseVersion: '1.2.3', recommendation, date: '2026-06-08' });
  const secondRun = applyVersionRecommendation({ versionFilePath: packageJsonPath, changelogPath, baseVersion: '1.2.3', recommendation, date: '2026-06-08' });

  assert.equal(firstRun.nextVersion, '1.3.0');
  assert.equal(secondRun.nextVersion, '1.3.0');

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string };
  assert.equal(packageJson.version, '1.3.0');

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  assert.equal((changelog.match(/## 1\.3\.0 - 2026-06-08/g) ?? []).length, 1);
  assert.match(changelog, /Summary: Adds a backwards-compatible feature/);
});

test('upsertChangelogEntry replaces an existing version section', () => {
  const existing = [
    '# Changelog',
    '',
    '## 1.3.0 - 2026-06-08',
    '',
    '- Summary: Old text',
    '',
    '## 1.2.0 - 2026-05-01',
    '',
    '- Summary: Older release',
    ''
  ].join('\n');

  const updated = upsertChangelogEntry(existing, '## 1.3.0 - 2026-06-08\n\n- Summary: New text\n', '1.3.0');

  assert.match(updated, /Summary: New text/);
  assert.equal((updated.match(/## 1\.3\.0 - 2026-06-08/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// writeVersionToFile
// ---------------------------------------------------------------------------

test('writeVersionToFile updates package.json version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'my-pkg', version: '1.0.0' }, null, 2) + '\n');
  writeVersionToFile(file, '2.0.0');
  const result = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string };
  assert.equal(result.version, '2.0.0');
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates pyproject.toml [project] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[project]\nname = "my-app"\nversion = "1.0.0"\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('version = "2.0.0"'));
  assert.ok(!content.includes('"1.0.0"'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates pyproject.toml [tool.poetry] version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[tool.poetry]\nname = "my-app"\nversion = "1.5.0"\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('version = "2.0.0"'));
  assert.ok(!content.includes('"1.5.0"'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile does not touch version fields outside [project]/[tool.poetry] in pyproject.toml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'pyproject.toml');
  fs.writeFileSync(file, '[build-system]\nrequires = ["setuptools>=61"]\n[project]\nname = "my-app"\nversion = "1.0.0"\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  // build-system section unchanged; project version updated
  assert.ok(content.includes('[build-system]'));
  assert.ok(content.includes('version = "2.0.0"'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates pom.xml version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'pom.xml');
  fs.writeFileSync(file, '<project>\n  <groupId>com.example</groupId>\n  <version>1.0.0</version>\n</project>\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('<version>2.0.0</version>'));
  assert.ok(!content.includes('<version>1.0.0</version>'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates project version not parent version in pom.xml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'pom.xml');
  const content = [
    '<project>',
    '  <parent>',
    '    <groupId>org.springframework.boot</groupId>',
    '    <version>3.2.0</version>',
    '  </parent>',
    '  <version>1.0.0</version>',
    '</project>'
  ].join('\n');
  fs.writeFileSync(file, content);
  writeVersionToFile(file, '2.0.0');
  const updated = fs.readFileSync(file, 'utf8');
  // Parent version unchanged, project version updated
  assert.ok(updated.includes('<version>3.2.0</version>'));
  assert.ok(updated.includes('<version>2.0.0</version>'));
  assert.ok(!updated.includes('<version>1.0.0</version>'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates gradle.properties version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'gradle.properties');
  fs.writeFileSync(file, 'group=com.example\nversion=1.0.0\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('version=2.0.0'));
  assert.ok(!content.includes('version=1.0.0'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates Cargo.toml version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, '[package]\nname = "my-crate"\nversion = "1.0.0"\nedition = "2021"\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('version = "2.0.0"'));
  assert.ok(!content.includes('"1.0.0"'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates Cargo.toml version when [package] contains TOML arrays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'Cargo.toml');
  const content = '[package]\nname = "my-crate"\nkeywords = ["async", "runtime"]\nversion = "1.0.0"\n\n[dependencies]\nserde = { version = "1.0" }\n';
  fs.writeFileSync(file, content);
  writeVersionToFile(file, '2.0.0');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.includes('version = "2.0.0"'));
  // Dependency version should be unchanged
  assert.ok(updated.includes('serde = { version = "1.0" }'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates Chart.yaml version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'Chart.yaml');
  fs.writeFileSync(file, 'apiVersion: v2\nname: my-chart\nversion: 1.0.0\n');
  writeVersionToFile(file, '2.0.0');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('version: 2.0.0'));
  assert.ok(!content.includes('version: 1.0.0'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile does not update indented version in Chart.yaml dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'Chart.yaml');
  const content = 'apiVersion: v2\nname: my-chart\nversion: 1.0.0\ndependencies:\n  - name: redis\n    version: 17.0.0\n';
  fs.writeFileSync(file, content);
  writeVersionToFile(file, '2.0.0');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.includes('version: 2.0.0'));
  // Dependency version (indented) must not be touched
  assert.ok(updated.includes('    version: 17.0.0'));
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile updates composer.json version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'composer.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'vendor/pkg', version: '1.0.0' }, null, 2) + '\n');
  writeVersionToFile(file, '2.0.0');
  const result = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string };
  assert.equal(result.version, '2.0.0');
  fs.rmSync(dir, { recursive: true });
});

test('writeVersionToFile throws for unsupported file type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-test-'));
  const file = path.join(dir, 'build.gradle');
  fs.writeFileSync(file, "version = '1.0.0'\n");
  assert.throws(() => writeVersionToFile(file, '2.0.0'), /Unsupported version file/);
  fs.rmSync(dir, { recursive: true });
});

