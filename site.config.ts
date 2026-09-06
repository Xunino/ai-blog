/**
 * NGUỒN SỰ THẬT DUY NHẤT cho cấu hình blog.
 * Sửa file này là đổi toàn bộ site — không cần động vào chỗ khác.
 */

export const LOCALES = ['vi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'vi';

/** Số bài viết mỗi trang danh sách. */
export const POSTS_PER_PAGE = 10;

export const SITE = {
  /** Đổi thành domain thật trước khi deploy. Ảnh hưởng canonical, RSS, sitemap. */
  url: 'https://news.meva.io.vn',

  title: {
    vi: 'The Latent Space',
    en: 'The Latent Space',
  },

  description: {
    vi: 'Giải mã AI, kiến trúc phần mềm và những vùng tri thức thú vị.',
    en: 'Exploring AI, software architecture, and the spaces between.',
  },

  author: {
    name: 'Xunino',
    bio: {
      vi: 'Kỹ sư phần mềm & người nghiên cứu AI. Thích xây dựng những hệ thống tối giản, siêu nhẹ và bền vững.',
      en: 'Software engineer & AI explorer. Passionate about building minimal, ultra-fast, and durable systems.',
    },
    github: 'https://github.com',
    twitter: '',
  },
} as const;

/**
 * Bình luận Giscus. Để trống `repo` thì phần bình luận tự ẩn,
 * build vẫn chạy bình thường.
 * Lấy thông số tại: https://giscus.app
 */
export const GISCUS = {
  repo: '', // vd: 'xunino/ai-blog'
  repoId: '',
  category: 'Announcements',
  categoryId: '',
} as const;

/** Menu điều hướng. `key` trỏ tới chuỗi trong src/i18n/ui.ts */
export const NAV_LINKS = [
  { key: 'nav.home', path: '' },
  { key: 'nav.tags', path: 'tags' },
] as const;
