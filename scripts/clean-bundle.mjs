/**
 * clean-bundle.mjs
 *
 * ncc honours `declaration: true` from tsconfig.json, so each bundle directory
 * ends up with a copy of the .d.ts files that already live in dist/. They are
 * dead weight in a committed directory and add diff noise on every rebuild,
 * so drop them and keep only the runtime bundle.
 */

import fs from 'node:fs';
import path from 'node:path';

for (const dir of process.argv.slice(2)) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.d.ts') || entry.endsWith('.d.ts.map')) {
      fs.rmSync(path.join(dir, entry));
    }
  }
}
