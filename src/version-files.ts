/**
 * version-files.ts
 *
 * Language-specific version file support.
 *
 * To add a new language:
 *   1. Add its filename to VERSION_FILE_CANDIDATES.
 *   2. Add a handler object to VERSION_FILE_HANDLERS with `read` and `write` functions.
 *
 * Everything else (detection, dispatch, error messages) is handled automatically.
 */

import fs from 'node:fs';
import path from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// ──────────────────────────────────────────────────────────────────────
// Handler registry
// ──────────────────────────────────────────────────────────────────────

interface VersionFileHandler {
  read(filePath: string, content: string): string;
  write(filePath: string, content: string, version: string): void;
}

const VERSION_FILE_HANDLERS: Record<string, VersionFileHandler> = {
  'package.json': {
    read(_filePath, content) {
      const pkg = JSON.parse(content) as { version?: string };
      if (!pkg.version) throw new Error(`No "version" field in package.json`);
      return pkg.version;
    },
    write(filePath, _content, version) {
      const pkg = readJsonFile(filePath);
      pkg.version = version;
      writeJsonFile(filePath, pkg);
    }
  },

  'pyproject.toml': {
    read(_filePath, content) {
      // Scope to [project] or [tool.poetry] sections only — avoids matching
      // version fields inside [build-system], [tool.poetry.dependencies], etc.
      const match = /^\[(project|tool\.poetry)\][^\[]*?^\s*version\s*=\s*["']([^"']+)["']/m.exec(content);
      if (!match) throw new Error(`No version field found in pyproject.toml`);
      return match[2];
    },
    write(filePath, content, version) {
      const updated = content.replace(
        /(^\[(project|tool\.poetry)\][^\[]*?^\s*version\s*=\s*)["'][^"']+["']/ms,
        (_, prefix) => `${prefix}"${version}"`
      );
      if (updated === content) throw new Error(`Could not update version in ${filePath}`);
      fs.writeFileSync(filePath, updated);
    }
  },

  'pom.xml': {
    read(_filePath, content) {
      // Strip <parent>...</parent> first — avoids picking up the parent POM version
      // in multi-module Maven projects.
      const withoutParent = content.replace(/<parent>[\s\S]*?<\/parent>/i, '');
      const match = /<version>\s*([^<]+?)\s*<\/version>/.exec(withoutParent);
      if (!match) throw new Error(`No <version> tag found in pom.xml`);
      return match[1];
    },
    write(filePath, content, version) {
      // Temporarily encode < inside <parent> so the regex only touches the project version.
      const withoutParent = content.replace(/(<parent>[\s\S]*?<\/parent>)/i, (m) => m.replace(/</g, '\x00'));
      const updated = withoutParent.replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`);
      if (updated === withoutParent) throw new Error(`Could not update <version> in ${filePath}`);
      fs.writeFileSync(filePath, updated.replace(/\x00/g, '<'));
    }
  },

  'gradle.properties': {
    read(_filePath, content) {
      const match = /^\s*version\s*=\s*(.+)/m.exec(content);
      if (!match) throw new Error(`No version= line found in gradle.properties`);
      return match[1].trim();
    },
    write(filePath, content, version) {
      const updated = content.replace(/^(\s*version\s*=\s*).+/m, `$1${version}`);
      if (updated === content) throw new Error(`Could not update version in ${filePath}`);
      fs.writeFileSync(filePath, updated);
    }
  }
};

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/** Ordered list used by detectVersionFile. First match wins. */
export const VERSION_FILE_CANDIDATES = Object.keys(VERSION_FILE_HANDLERS);

/** Returns the absolute path of the first recognised version file found in workdir. */
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

/** Reads the version string from any supported version file. */
export function readVersionFromFile(filePath: string): string {
  const basename = path.basename(filePath);
  const handler = VERSION_FILE_HANDLERS[basename];
  if (!handler) {
    throw new Error(
      `Unsupported version file: ${basename}. ` +
        `Supported files: ${VERSION_FILE_CANDIDATES.join(', ')}.`
    );
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return handler.read(filePath, content);
}

/** Writes a new version string into any supported version file in-place. */
export function writeVersionToFile(filePath: string, version: string): void {
  const basename = path.basename(filePath);
  const handler = VERSION_FILE_HANDLERS[basename];
  if (!handler) {
    throw new Error(
      `Unsupported version file: ${basename}. ` +
        `Supported files: ${VERSION_FILE_CANDIDATES.join(', ')}.`
    );
  }
  const content = fs.readFileSync(filePath, 'utf8');
  handler.write(filePath, content, version);
}
