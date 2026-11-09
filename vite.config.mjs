import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';

const directory = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Existing reader scripts are served in their original order by the bridge.
  publicDir: false,
  resolve: {alias: {
    "@coconut/reader": directory("reader"),
    "@coconut/shared": directory("shared"),
  }},
  optimizeDeps: {
    // Local CommonJS inputs can change without changing the dependency lockfile.
    force: true,
    entries: ['frontend/app/main.tsx'],
    // These shared UMD/CommonJS modules also run in Node and the packaged reader.
    include: ['@coconut/reader/editions.js', '@coconut/reader/interview.js', '@coconut/shared/source-media.js',
      '@coconut/shared/transcript-resources.js', '@coconut/shared/transcript-review', '@coconut/shared/source-alignment.js'],
  },
  server: {
    middlewareMode: true,
    fs: {
      strict: true,
      allow: ['frontend', 'reader', 'shared', 'node_modules'].map(directory),
      deny: ['.env', '.env.*', '**/.git/**', '**/.coconut/**', '**/*.pem', '**/*.crt'],
    },
  },
  appType: 'custom',
});
