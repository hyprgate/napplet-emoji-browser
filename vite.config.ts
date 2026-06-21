import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    UnoCSS(),
    svelte(),
    nip5aManifest({
      nappletType: 'emoji-browser',
      requires: ['identity', 'relay', 'outbox', 'resource', 'theme'],
      artifactMode: 'single-file',
    }),
  ],
  resolve: { dedupe: ['svelte'] },
  server: { port: 9534, cors: true },
  build: { outDir: 'dist' },
});
