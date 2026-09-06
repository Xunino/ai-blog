import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../site.config';

/** Từ điển chuỗi giao diện với đầy đủ dấu tiếng Việt chuẩn. */
export const UI = {
  vi: {
    'nav.home': 'Trang chủ',
    'nav.tags': 'Chủ đề',
    'nav.menu': 'Danh mục',
    'nav.close': 'Đóng',
    'nav.skipToContent': 'Bỏ qua, đến nội dung chính',

    'deals.sideProject': 'Dự án khác',
    'deals.title': 'Shopee Deal Finder',
    'deals.desc': 'Săn deal & theo dõi biến động giá Shopee',

    'theme.toggle': 'Đổi giao diện sáng/tối',

    'search.label': 'Tìm kiếm',
    'search.placeholder': 'Tìm bài viết...',
    'search.open': 'Tìm kiếm',
    'search.close': 'Đóng',
    'search.loading': 'Đang tải...',
    'search.noJs': 'Cần bật JavaScript để tìm kiếm.',

    'hero.featured': 'Chủ đề nổi bật',
    'hero.latestPosts': 'Bài viết mới nhất',

    'sidebar.about': 'Về tác giả',
    'sidebar.topics': 'Tất cả chủ đề',
    'sidebar.feed': 'Kênh tin tức',
    'sidebar.feedDesc': 'Nhận bài viết mới nhất qua RSS feed tiêu chuẩn.',
    'sidebar.subscribe': 'Đăng ký RSS',

    'post.publishedOn': 'Đăng ngày',
    'post.updatedOn': 'Cập nhật',
    'post.readingTime': 'phút đọc',
    'post.tags': 'Chủ đề',
    'post.draft': 'Bản nháp',
    'post.prev': 'Bài trước',
    'post.next': 'Bài tiếp theo',
    'post.backToList': 'Tất cả bài viết',
    'post.toc': 'Mục lục bài viết',

    'toc.title': 'Trong bài này',
    'toc.backToTop': 'Lên đầu trang',

    'list.empty': 'Chưa có bài viết nào.',
    'list.readMore': 'Đọc tiếp',

    'pagination.prev': 'Trang trước',
    'pagination.next': 'Trang sau',
    'pagination.page': 'Trang',

    'tags.title': 'Tất cả chủ đề',
    'tags.postCount': 'bài viết',
    'tags.empty': 'Chưa có chủ đề nào.',

    'comments.title': 'Bình luận',

    'lang.switchTo': 'English',
    'lang.notTranslated': 'Bài này chưa có bản tiếng Anh.',

    '404.title': 'Không tìm thấy trang',
    '404.description': 'Trang bạn tìm không tồn tại hoặc đã bị di chuyển.',
    '404.backHome': 'Về trang chủ',

    'rss.label': 'RSS',
    'footer.builtWith': 'Siêu nhẹ · Zero JS',
  },

  en: {
    'nav.home': 'Home',
    'nav.tags': 'Topics',
    'nav.menu': 'Contents',
    'nav.close': 'Close',
    'nav.skipToContent': 'Skip to main content',

    'deals.sideProject': 'Side project',
    'deals.title': 'Shopee Deal Finder',
    'deals.desc': 'Track price history & find Shopee deals',

    'theme.toggle': 'Toggle light/dark theme',

    'search.label': 'Search',
    'search.placeholder': 'Search posts...',
    'search.open': 'Search',
    'search.close': 'Close',
    'search.loading': 'Loading...',
    'search.noJs': 'JavaScript is required to search.',

    'hero.featured': 'Featured topics',
    'hero.latestPosts': 'Latest posts',

    'sidebar.about': 'About author',
    'sidebar.topics': 'All topics',
    'sidebar.feed': 'Stay updated',
    'sidebar.feedDesc': 'Subscribe via RSS to get newly published articles.',
    'sidebar.subscribe': 'Subscribe RSS',

    'post.publishedOn': 'Published',
    'post.updatedOn': 'Updated',
    'post.readingTime': 'min read',
    'post.tags': 'Topics',
    'post.draft': 'Draft',
    'post.prev': 'Previous article',
    'post.next': 'Next article',
    'post.backToList': 'All posts',
    'post.toc': 'Table of contents',

    'toc.title': 'On this page',
    'toc.backToTop': 'Back to top',

    'list.empty': 'No posts yet.',
    'list.readMore': 'Read more',

    'pagination.prev': 'Previous',
    'pagination.next': 'Next',
    'pagination.page': 'Page',

    'tags.title': 'All topics',
    'tags.postCount': 'posts',
    'tags.empty': 'No topics yet.',

    'comments.title': 'Comments',

    'lang.switchTo': 'Tiếng Việt',
    'lang.notTranslated': 'This post has no Vietnamese version yet.',

    '404.title': 'Page not found',
    '404.description': 'The page you are looking for does not exist or has moved.',
    '404.backHome': 'Back to home',

    'rss.label': 'RSS',
    'footer.builtWith': 'Ultra-light · Zero JS',
  },
} as const;

export type UIKey = keyof (typeof UI)['vi'];

/** Tạo hàm dịch cho một ngôn ngữ. */
export function useTranslations(locale: Locale) {
  return function t(key: UIKey): string {
    return UI[locale][key] ?? UI[DEFAULT_LOCALE][key] ?? key;
  };
}

/** Kiểm tra một chuỗi bất kỳ có phải locale hợp lệ không. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Locale còn lại (dùng cho nút đổi ngôn ngữ). */
export function otherLocale(locale: Locale): Locale {
  return locale === 'vi' ? 'en' : 'vi';
}

/** Định dạng ngày theo ngôn ngữ. */
export function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
