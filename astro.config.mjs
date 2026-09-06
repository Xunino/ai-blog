// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE, LOCALES, DEFAULT_LOCALE } from './site.config';

export default defineConfig({
  site: SITE.url,

  // Khop voi cau hinh Nginx: moi trang la mot thu muc co index.html
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // Nhung toan bo CSS vao <head> -> bo mot round-trip chan render.
    inlineStylesheets: 'always',
  },

  i18n: {
    locales: [...LOCALES],
    defaultLocale: DEFAULT_LOCALE,
    routing: {
      // Ca hai ngon ngu deu co tien to ro rang: /vi/... va /en/...
      prefixDefaultLocale: true,
      // Trang goc / la trang chuyen huong thu cong (chay ca khi tat JS)
      redirectToDefaultLocale: false,
    },
  },

  // Tai truoc khi ro chuot -> chuyen trang gan nhu tuc thi,
  // ma khong tai truoc toan bo site.
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },

  integrations: [
    sitemap({
      i18n: {
        defaultLocale: DEFAULT_LOCALE,
        locales: Object.fromEntries(LOCALES.map((l) => [l, l])),
      },
    }),
  ],

  markdown: {
    // Sätteri (mac dinh tu Astro 7) — khong can remark/rehype.
    syntaxHighlight: 'shiki',
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: true,
    },
  },
});
