# AI Blog

Blog tinh sieu nhe, song ngu Viet/Anh. Dung Astro 7 + Markdown, xuat ra HTML thuan, tu host bang Nginx.

## Con so thuc te

Do tren ban build hien tai:

| Chi so | Gia tri |
| --- | --- |
| Trang bai viet (gzip) | **6.1 KB** |
| CSS (gzip, nhung san trong HTML) | **2.4 KB** |
| JavaScript (gzip) | **1.1 KB** — chi la module prefetch |
| JS cua framework | **0 KB** |
| Request chan render | **1** (chinh file HTML) |
| Webfont tai ve | **0** |

Site chay day du khi **tat JavaScript**: doc bai, dieu huong, doi ngon ngu, phan trang deu binh thuong. Chi tim kiem va binh luan can JS.

## Bat dau

```bash
pnpm install
pnpm dev          # http://localhost:4321
```

Cac lenh khac:

```bash
pnpm build        # build + tao chi muc tim kiem -> dist/
pnpm preview      # xem thu ban build
pnpm check        # kiem tra kieu du lieu
```

> Luu y: tim kiem chi hoat dong sau `pnpm build` (chi muc Pagefind duoc tao luc build, khong co luc `dev`).

## Viec dau tien can lam

Mo `site.config.ts` — day la **noi duy nhat** can sua de doi cau hinh site:

```ts
export const SITE = {
  url: 'https://example.com',   // <- DOI THANH DOMAIN THAT
  title: { vi: 'AI Blog', en: 'AI Blog' },
  description: { vi: '...', en: '...' },
  author: { name: 'Xunino', twitter: '' },
};
```

`url` anh huong toi canonical, RSS va sitemap — nho doi truoc khi deploy.

## Viet bai

Tao file `.md` trong `src/content/blog/vi/` (hoac `en/`):

```markdown
---
title: 'Tieu de bai viet'
description: 'Mo ta ngan, hien o trang danh sach va ket qua tim kiem.'
pubDate: 2025-01-20
tags: ['ky-thuat']
draft: false
translationKey: bai-viet-cua-toi
---

Noi dung bai viet...
```

| Truong | Bat buoc | Y nghia |
| --- | --- | --- |
| `title` | Co | Tieu de |
| `description` | Co | Mo ta cho SEO va trang danh sach |
| `pubDate` | Co | Ngay dang |
| `updatedDate` | Khong | Ngay cap nhat |
| `tags` | Khong | Danh sach chu de |
| `draft` | Khong | `true` = chi hien luc `pnpm dev` |
| `cover` | Khong | Anh bia, dat trong `src/assets/` |
| `translationKey` | Khong | Noi ban Viet <-> Anh |

**Ve `translationKey`:** hai bai `vi/xin-chao.md` va `en/hello-world.md` cung dat `translationKey: hello-world` thi nut doi ngon ngu se nhay dung sang bai tuong ung. Neu chua co ban dich, nut se ve trang chu cua ngon ngu do.

### Anh trong bai

Dat anh vao `src/assets/` roi dung cu phap Markdown binh thuong — Astro tu toi uu sang WebP/AVIF va them `width`/`height` de trang khong bi giat:

```markdown
![Mo ta anh](../../assets/ten-anh.png)
```

## Cau truc thu muc

```
site.config.ts              # cau hinh site (sua o day)
src/
├── content/blog/vi/        # bai tieng Viet
├── content/blog/en/        # bai tieng Anh
├── content.config.ts       # schema frontmatter
├── i18n/ui.ts              # chuoi giao dien 2 ngon ngu
├── lib/posts.ts            # ham truy van bai viet
├── layouts/Base.astro      # SEO, theme, khung trang
├── components/             # Header, Footer, Search, ...
├── styles/global.css       # toan bo CSS
└── pages/                  # dinh tuyen
deploy/
├── nginx.conf              # cau hinh Nginx mau
└── deploy.sh               # script rsync len VPS
```

## Duong dan

| URL | Noi dung |
| --- | --- |
| `/` | Chuyen huong sang `/vi/` |
| `/vi/`, `/en/` | Trang chu tung ngon ngu |
| `/vi/page/2/` | Phan trang |
| `/vi/blog/<slug>/` | Bai viet |
| `/vi/tags/` | Danh sach chu de |
| `/vi/tags/<tag>/` | Bai theo chu de |
| `/rss-vi.xml`, `/rss-en.xml` | RSS tung ngon ngu |
| `/sitemap-index.xml` | Sitemap |

## Bat binh luan (Giscus)

1. Bat Discussions trong repo GitHub cua ban.
2. Cai app [giscus](https://github.com/apps/giscus).
3. Vao [giscus.app](https://giscus.app), dien repo, lay `repoId` va `categoryId`.
4. Dien vao `site.config.ts`:

```ts
export const GISCUS = {
  repo: 'xunino/ai-blog',
  repoId: 'R_kg...',
  category: 'Announcements',
  categoryId: 'DIC_kw...',
};
```

De trong `repo` thi phan binh luan tu an, build van chay binh thuong.

Binh luan chi tai khi nguoi doc cuon toi (IntersectionObserver) — khong lam cham luc vao trang.

## Deploy len VPS

### Lan dau

```bash
# Tren VPS
sudo mkdir -p /var/www/blog
sudo chown -R $USER:$USER /var/www/blog

# Chep cau hinh Nginx (nho sua server_name va root)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/blog
sudo ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS mien phi
sudo certbot --nginx -d example.com
```

### Moi lan cap nhat

```bash
REMOTE_HOST=user@ip-cua-ban ./deploy/deploy.sh
```

Script se build, cho ban xem truoc nhung file thay doi, hoi xac nhan roi moi day len.

Hoac lam thu cong:

```bash
pnpm build
rsync -az --delete dist/ user@host:/var/www/blog/
```

### Ve cache

`deploy/nginx.conf` da dat san:

- `/_astro/*` va `/pagefind/*` — cache 1 nam (ten file co hash, doi noi dung la doi ten)
- File `.html` — `no-cache`, nguoi doc luon thay ban moi nhat
- Anh, SVG — cache 30 ngay

Nen bat **brotli** neu Nginx cua ban co module `ngx_brotli` (nen tot hon gzip ~15-20%) — xem phan da comment san trong file config.

## Ghi chu ky thuat

- **Astro 7** dung trinh bien dich Rust, nghiem ngat ve HTML hop le: moi the khong phai void deu phai dong.
- **`compressHTML: 'jsx'`** (mac dinh tu v7) cat khoang trang giua cac the inline. Neu thieu khoang trang o dau, chen `{" "}`.
- **Markdown chay bang Sätteri** (mac dinh tu v7), khong dung remark/rehype. Neu can plugin unified, cai `@astrojs/markdown-remark` roi dat `markdown.processor` — xem [tai lieu](https://docs.astro.build/en/guides/markdown-content/#setting-up-a-markdown-processor).
- **Dark mode khong nhay** nho script dong bo chay truoc khi ve khung hinh dau tien (trong `Base.astro`).
- **Cache npm nam trong workspace** (`.npmrc`) vi moi truong nay chan ghi vao `~/.npm`.

## Muon them gi nua?

Nhung thu chua co: CI/CD tu dong, CMS giao dien, analytics, newsletter, series bai viet, PWA offline.
