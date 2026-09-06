import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * Bài viết nằm trong src/content/blog/<locale>/<nested-folders>/<slug>.md
 * -> id có dạng "vi/ai/llm/prompt-engineering", "en/tech/performance".
 * Segment đầu chính là ngôn ngữ, các segment tiếp theo là thư mục lồng nhau dạng cây.
 */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
      /** Ảnh bìa — đặt trong cùng thư mục hoặc src/assets/ */
      cover: image().optional(),
      coverAlt: z.string().optional(),
      /**
       * Nối bài viết vi <-> en. Hai bản dịch dùng chung một giá trị
       * để nút đổi ngôn ngữ nhảy đúng bài.
       */
      translationKey: z.string().optional(),
      /** Tiêu đề rút gọn trên thanh Sidebar Cây (nếu tiêu đề chính quá dài) */
      sidebarTitle: z.string().optional(),
      /** Thứ tự sắp xếp trong cây danh mục (số nhỏ xếp trước) */
      order: z.number().default(999),
    }),
});

export const collections = { blog };
