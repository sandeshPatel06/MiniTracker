import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
// Deployed to GitHub Pages project site; internal links are base-prefixed.
export default defineConfig({
  site: 'https://sandeshpatel06.github.io',
  base: '/MiniTracker',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
