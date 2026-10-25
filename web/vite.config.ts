import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { argusReconPlugin } from './server/plugin';

export default defineConfig(({ mode }) => {
  // Server-side only: no VITE_ prefix, so these never reach the client bundle.
  const root = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, root, '');
  return {
    server: {
      host: '127.0.0.1',
      // recon-cache JSON is written by the API at runtime; don't full-reload the page for it.
      watch: { ignored: ['**/data/recon-cache/**', '**/.cache/**', '**/shots/**'] },
    },
    build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
    plugins: [
      argusReconPlugin({
        apiKey: env.GEMINI_API_KEY ?? '',
        model: env.GEMINI_MODEL || 'gemini-4-argon',
        root,
      }),
    ],
  };
});
