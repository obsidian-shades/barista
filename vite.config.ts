import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The Rust server (`pnpm server`) answers /api; Vite serves the editor and forwards to it.
export default defineConfig({
  plugins: [react()],
  define: { __VERSION__: JSON.stringify(pkg.version) },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
