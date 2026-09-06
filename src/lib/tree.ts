import type { Post } from './posts';
import { postSlug, postPath } from './posts';
import type { Locale } from '../../site.config';

export interface TreeItem {
  id: string;
  title: string;
  url?: string;
  isFolder: boolean;
  order: number;
  children: TreeItem[];
  post?: Post;
}

const FOLDER_NAMES_VI: Record<string, string> = {
  ai: 'Trí tuệ Nhân tạo (AI)',
  llm: 'Large Language Models',
  'machine-learning': 'Machine Learning',
  'deep-learning': 'Deep Learning',
  'ky-thuat': 'Kỹ thuật & Kiến trúc',
  tech: 'Kỹ thuật & Kiến trúc',
  notes: 'Ghi chép & Hướng dẫn',
  'building-agents': 'Xây dựng AI Agents',
};

const FOLDER_NAMES_EN: Record<string, string> = {
  ai: 'Artificial Intelligence (AI)',
  llm: 'Large Language Models',
  'machine-learning': 'Machine Learning',
  'deep-learning': 'Deep Learning',
  'ky-thuat': 'Engineering & Tech',
  tech: 'Engineering & Tech',
  notes: 'Notes & Guides',
  'building-agents': 'Building AI Agents',
};

function formatFolderName(folderSlug: string, locale: Locale): string {
  const dict = locale === 'vi' ? FOLDER_NAMES_VI : FOLDER_NAMES_EN;
  if (dict[folderSlug]) return dict[folderSlug];

  // Mặc định: viết hoa chữ cái đầu và thay dấu gạch nối bằng khoảng trắng
  return folderSlug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Xây dựng cây danh mục phân cấp từ danh sách bài viết Markdown.
 * Tự động phân tích các thư mục lồng nhau thành cây Cha > Con > Cháu.
 */
export function buildTree(posts: Post[], locale: Locale): TreeItem[] {
  const root: TreeItem[] = [];

  for (const post of posts) {
    const slug = postSlug(post);
    const parts = slug.split('/');

    let currentLevel = root;
    let pathAcc = '';

    // Duyệt qua các thư mục cha
    for (let i = 0; i < parts.length - 1; i++) {
      const folderKey = parts[i];
      pathAcc += (pathAcc ? '/' : '') + folderKey;

      let folderNode = currentLevel.find((item) => item.isFolder && item.id === pathAcc);
      if (!folderNode) {
        folderNode = {
          id: pathAcc,
          title: formatFolderName(folderKey, locale),
          isFolder: true,
          order: 100, // Thư mục mặc định xếp cùng nhóm
          children: [],
        };
        currentLevel.push(folderNode);
      }
      currentLevel = folderNode.children;
    }

    // Phần tử lá (Leaf) chính là bài viết
    const postNode: TreeItem = {
      id: slug,
      title: post.data.sidebarTitle || post.data.title,
      url: postPath(post),
      isFolder: false,
      order: post.data.order ?? 999,
      children: [],
      post,
    };
    currentLevel.push(postNode);
  }

  // Hàm đệ quy sắp xếp cây: ưu tiên order nhỏ xếp trước, sau đó đến bảng chữ cái
  function sortLevel(items: TreeItem[]): TreeItem[] {
    items.sort((a, b) => {
      // Nếu cùng là folder hoặc cùng là post thì so sánh order
      if (a.isFolder === b.isFolder) {
        if (a.order !== b.order) return a.order - b.order;
        return a.title.localeCompare(b.title);
      }
      // Ưu tiên folder xếp trên post để tạo cấu trúc mục rõ ràng
      return a.isFolder ? -1 : 1;
    });

    for (const item of items) {
      if (item.children.length > 0) {
        sortLevel(item.children);
      }
    }
    return items;
  }

  return sortLevel(root);
}

/**
 * Kiểm tra xem một nút (node) hoặc bất kỳ con cháu nào của nó
 * có chứa URL của bài viết đang xem hay không (để tự động mở <details open>).
 */
export function hasActiveDescendant(node: TreeItem, currentUrl: string): boolean {
  if (node.url && currentUrl.startsWith(node.url)) {
    return true;
  }
  return node.children.some((child) => hasActiveDescendant(child, currentUrl));
}

/**
 * Trích xuất danh sách tuyến tính các bài viết theo đúng thứ tự đọc của cây danh mục.
 * Phục vụ cho tính năng điều hướng bài trước / bài tiếp theo (Series navigation).
 */
export function getFlatReadingList(tree: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = [];

  function walk(items: TreeItem[]) {
    for (const item of items) {
      if (!item.isFolder && item.url) {
        result.push(item);
      }
      if (item.children.length > 0) {
        walk(item.children);
      }
    }
  }

  walk(tree);
  return result;
}
