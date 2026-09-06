import { getCollection, type CollectionEntry } from 'astro:content';
import { isLocale } from '../i18n/ui';
import type { Locale } from '../../site.config';

export type Post = CollectionEntry<'blog'>;

/** Ngon ngu cua bai viet, lay tu segment dau cua id ("vi/xin-chao" -> "vi"). */
export function postLocale(post: Post): Locale {
  const first = post.id.split('/')[0];
  return isLocale(first) ? first : 'vi';
}

/** Slug khong kem tien to ngon ngu ("vi/xin-chao" -> "xin-chao"). */
export function postSlug(post: Post): string {
  return post.id.split('/').slice(1).join('/');
}

/** Duong dan day du toi bai viet. */
export function postPath(post: Post): string {
  return `/${postLocale(post)}/blog/${postSlug(post)}/`;
}

/**
 * Tat ca bai viet da xuat ban cua mot ngon ngu, moi nhat truoc.
 * Ban nhap bi an khi build production, van xem duoc luc dev.
 */
export async function getPosts(locale: Locale): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data, id }) => {
    if (!id.startsWith(`${locale}/`)) return false;
    return import.meta.env.PROD ? data.draft !== true : true;
  });

  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Dem so bai theo tung tag, sap xep nhieu bai truoc roi theo bang chu cai. */
export async function getTags(locale: Locale): Promise<{ tag: string; count: number }[]> {
  const posts = await getPosts(locale);
  const counts = new Map<string, number>();

  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Bai viet thuoc mot tag. */
export async function getPostsByTag(locale: Locale, tag: string): Promise<Post[]> {
  const posts = await getPosts(locale);
  return posts.filter((p) => p.data.tags.includes(tag));
}

/**
 * Tim ban dich tuong ung o ngon ngu khac.
 * Tra ve undefined neu bai chua duoc dich.
 */
export async function findTranslation(post: Post, target: Locale): Promise<Post | undefined> {
  const key = post.data.translationKey;
  if (!key) return undefined;

  const candidates = await getPosts(target);
  return candidates.find((p) => p.data.translationKey === key);
}

/** Uoc luong thoi gian doc. ~200 tu/phut, dem duoc ca tieng Viet. */
export function readingTime(body: string | undefined): number {
  if (!body) return 1;
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

/** Chuyen tag thanh slug an toan tren URL. */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
