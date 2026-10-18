import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'emoji-browser',
      requires: ['identity', 'relay', 'outbox', 'resource', 'storage', 'common', 'inc'],
      optional: ['theme'],
      icon: { data: readFileSync(new URL('./icon.png', import.meta.url)), mimeType: 'image/png' },
      artifactMode: 'single-file',
    }),
  ],
  resolve: { dedupe: ['svelte'] },
  server: { port: 9534, cors: true },
  build: { outDir: 'dist' },
});
