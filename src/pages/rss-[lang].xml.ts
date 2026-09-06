import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { LOCALES, SITE, type Locale } from '../../site.config';
import { getPosts, postPath } from '../lib/posts';

export function getStaticPaths() {
  return LOCALES.map((lang) => ({ params: { lang } }));
}

export async function GET(context: APIContext) {
  const locale = context.params.lang as Locale;
  const posts = await getPosts(locale);

  return rss({
    title: SITE.title[locale],
    description: SITE.description[locale],
    site: context.site!,
    trailingSlash: true,
    customData: `<language>${locale === 'vi' ? 'vi-VN' : 'en-US'}</language>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postPath(post),
      categories: [...post.data.tags],
    })),
  });
}
