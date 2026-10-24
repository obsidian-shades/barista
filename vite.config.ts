// @ts-expect-error Node built-ins are supplied by Vite's config runner; the editor tsconfig targets the DOM.
import { cp, readdir } from 'node:fs/promises';
// @ts-expect-error see above
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The Rust server (`pnpm server`) answers /api; Vite serves the editor and forwards to it.
// The purchased pack in public/materials-pack is a local development library: it is served by the
// dev server but deliberately left out of dist (and out of a Tauri installer).
export default defineConfig({
  plugins: [react(), {
    name: 'copy-public-without-purchased-pack',
    apply: 'build',
    async writeBundle() {
      for (const name of await readdir('public')) {
        if (name === 'materials-pack') continue;
        await cp(join('public', name), join('dist', name), { recursive: true });
      }
    },
  }],
  build: { copyPublicDir: false },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
