// @ts-expect-error Node built-ins are supplied by Vite's config runner; the editor tsconfig targets the DOM.
import { cp, readdir } from 'node:fs/promises';
// @ts-expect-error see above
import { join, sep } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The Rust server (`pnpm server`) answers /api; Vite serves the editor and forwards to it.
// The purchased pack in public/assets/materials/pack and the DECALmachine decals imported into
// public/assets/geometry/decalmachine are local development libraries: served by the dev server but deliberately left
// out of dist (and a Tauri installer).
export default defineConfig({
  plugins: [react(), {
    name: 'copy-public-without-purchased-assets',
    apply: 'build',
    async writeBundle() {
      const local = [join('public', 'assets', 'materials', 'pack'), join('public', 'assets', 'geometry', 'decalmachine')];
      for (const name of await readdir('public')) {
        await cp(join('public', name), join('dist', name), { recursive: true, filter: (src: string) => !local.some((p) => src === p || src.startsWith(p + sep)) });
      }
    },
  }],
  build: { copyPublicDir: false },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
    // the engine keeps its build and running .exe in engine/target; watching it only made EBUSY reload churn
    watch: { ignored: ['**/target/**', '**/dist/**'] },
  },
});
