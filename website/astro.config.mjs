import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://get-hike.pages.dev',
  base: '/',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
      serialize(item) {
        if (item.url === 'https://get-hike.pages.dev/') {
          item.priority = 1.0;
          item.changefreq = 'weekly';
        } else if (item.url.includes('/download')) {
          item.priority = 0.9;
          item.changefreq = 'weekly';
        } else if (item.url.includes('/features') || item.url.includes('/get-started')) {
          item.priority = 0.8;
          item.changefreq = 'monthly';
        } else if (item.url.includes('/changelog')) {
          item.priority = 0.7;
          item.changefreq = 'weekly';
        } else {
          item.priority = 0.5;
          item.changefreq = 'monthly';
        }
        item.lastmod = new Date();
        return item;
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
