/**
 * clean-bundle.mjs
 *
 * ncc honours `declaration: true` from tsconfig.json, so each bundle directory
 * ends up with a copy of the .d.ts files that already live in dist/. They are
 * dead weight in a committed directory and add diff noise on every rebuild,
 * so drop them and keep only the runtime bundle.
 *
 * The .d.ts.map files matter more than noise: they record the source path as an
 * absolute file:// URL, so they differ between a laptop and a CI runner and make
 * the committed bundle look permanently out of date. Recurse, because an entry
 * point in a subdirectory of src/ is mirrored as a subdirectory here.
 */

import fs from 'node:fs';
import path from 'node:path';

function clean(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      clean(full);
      // Directories that held nothing but declarations have no reason to remain.
      if (fs.readdirSync(full).length === 0) {
        fs.rmdirSync(full);
      }
      continue;
    }

    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map')) {
      fs.rmSync(full);
    }
  }
}

for (const dir of process.argv.slice(2)) {
  clean(dir);
}
