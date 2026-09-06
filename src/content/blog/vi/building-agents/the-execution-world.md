---
title: 'Một thế giới thực thi thống nhất'
description: 'Chuyển agent vào một sandbox từ xa và hãy đếm số lượng chỉnh sửa. Nếu bash, các công cụ tệp, terminal và LSP đều tuân theo một thay đổi cấu hình duy nhất, Phần 13 đã thành công.'
pubDate: 2026-09-23
tags: ['ai-agents', 'architecture', 'security']
translationKey: 'agents-18-execution'
sidebarTitle: '18 · Thực thi (Execution)'
order: 18
---

[Phần 13](/vi/blog/building-agents/plugins-and-capability-seams/) đã đặt `bash` phía sau một điểm nối seam. Rất tốt. Bây giờ hãy làm cho hệ thống tệp và tọa độ tiến trình hoàn toàn đồng thuận khi việc thực thi được đưa ra khỏi máy host.

Agent đọc file bằng `readFileSync`. Nó tìm kiếm bằng `glob` trên hệ thống tệp cục bộ. Nó có một terminal bền vững đã spawn ra một tiến trình `bash` trên cỗ máy này. Một LSP client giao tiếp với `tsserver` cũng được khởi động tại đây. Công cụ `run_code` đang chạy trong một worker thread cục bộ.

Hãy chuyển việc thực thi đó sang một sandbox từ xa và bạn sẽ thấy mỗi thành phần trên đều là một cuộc di cư (migration) hoàn toàn riêng biệt — trừ khi tất cả chúng cùng nằm trên một nền móng thống nhất.

## Quan sát mang tính thống nhất

> Hệ thống tệp (Filesystem) và tiến trình con (Subprocess) là hai điểm nối seam bắt buộc phải cùng mô tả **một thế giới thực thi duy nhất**. Trỏ cả hai vào cùng một cơ chất provider nền tảng và các bên tiêu thụ của chúng sẽ cùng nhìn thấy những file và tiến trình giống hệt nhau.

Hầu hết các tính năng thực thi đều được ghép từ một hoặc cả hai seam này. Trỏ chúng tới những nơi khác nhau và bạn sẽ có một language server đang cặm cụi phân tích những file mà các công cụ tệp của agent hoàn toàn không thể nhìn thấy. Có một ngoại lệ hiện tại rất quan trọng cần lưu ý: runtime mã PTC được DeepSeek cung cấp là một năng lực chạy trên worker thread cục bộ, chứ không phải một provider runtime mã E2B, vì vậy việc di dời `fs` và `subprocess` không tự động di dời mã JavaScript do mô hình viết.

<figure class="dg">
  <img src="/diagrams/part18-execution-world.svg" alt="Sáu bên tiêu thụ cùng dựa trên hai seam; việc bọc quanh seam tiến trình con sẽ cô lập tất cả chúng cùng một lúc." loading="lazy" />
  <figcaption><strong>Hai khái niệm nguyên thủy, sáu bên tiêu thụ.</strong> Hàng LSP chính là minh chứng: một language server là một tiến trình con đọc cùng hệ thống tệp mà chính agent đang đọc.</figcaption>
</figure>

## Hai bản định nghĩa hợp đồng

```typescript
export interface FileSystem {
  read(path: string, opts?: { encoding?: 'utf8' | 'binary' }): Promise<Uint8Array | string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  list(dir: string): Promise<DirEntry[]>;
  glob(pattern: string, opts?: { cwd?: string }): Promise<string[]>;
}

export interface Subprocess {
  spawn(spec: SpawnSpec, signal: AbortSignal): Promise<ProcessHandle>;
}

export interface SpawnSpec {
  argv: string[];              // không bao giờ là chuỗi shell string — xem bên dưới
  cwd?: string;
  env?: Record<string, string>;
  pty?: { cols: number; rows: number };
}

export interface ProcessHandle {
  readonly pid: number;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number; signal?: string }>;
  kill(signal?: NodeJS.Signals): void;
}
```

Hai chi tiết trong `SpawnSpec` mang tính chịu lực nền tảng:

**`argv`, không phải một chuỗi câu lệnh.** Việc thông dịch shell thuộc về bất kỳ ai thực sự muốn có shell — `bash` trở thành `argv: ['bash', '-lc', command]` một cách tường minh. Một seam chấp nhận chuỗi văn bản đã tự tiện quyết định rằng mọi triển khai đều bắt buộc phải có một shell và phải escape dấu nháy giống hệt nhau, điều này hoàn toàn sai trên một runtime từ xa và sai trên Windows.

**`pty` là một tùy chọn spawn, không phải một seam riêng biệt.** Một terminal bản chất là một tiến trình con có gắn kèm một pseudo-terminal. Biến nó thành một năng lực riêng biệt đồng nghĩa với việc mọi provider đều phải triển khai nó hai lần.

## Thu dọn tiến trình con (Reaping) là phần dễ gây họa

Đây là lỗi bug bạn sẽ chạm trán ngay trong tuần thứ hai, và rất đáng để phòng ngừa từ trước.

```typescript
const proc = await subprocess.spawn({ argv: ['bash', '-lc', 'npm test'] }, signal);
// ...
proc.kill('SIGTERM');
```

Bạn vừa tiêu diệt `bash`. Nhưng `npm` thì vẫn đang chạy lù lù. Cả tiến trình `vitest` mà nó vừa sinh ra cũng vậy, và bốn worker mà chính *vitest* sinh ra nữa. Giờ đây chúng trở thành những tiến trình mồ côi (orphans), chiếm dụng cổng mạng mà lần chạy test tiếp theo của bạn đang rất cần.

> Một công cụ sinh ra một **cây tiến trình (process tree)**, chứ không chỉ một tiến trình đơn lẻ. Hãy tiêu diệt toàn bộ cái cây đó.

```typescript
// POSIX: đưa tiến trình con vào nhóm tiến trình riêng, sau đó gửi signal cho cả nhóm.
const child = spawn(argv[0], argv.slice(1), { detached: true });
const kill = (sig: NodeJS.Signals = 'SIGTERM') => {
  try { process.kill(-child.pid!, sig); } catch { /* đã thoát từ trước */ }
};

// Leo thang tín hiệu — SIGTERM chỉ là một lời thỉnh cầu, không phải sự bảo đảm.
const killTree = async () => {
  kill('SIGTERM');
  const exited = await Promise.race([once(child, 'exit'), delay(5_000).then(() => null)]);
  if (exited === null) kill('SIGKILL');
};
```

Cơ chế này mang tính đặc thù theo từng provider — process group trên POSIX, job object trên Windows, `docker kill` cho container, hoặc một lệnh gọi API cho một runtime từ xa. Đó chính xác là lý do tại sao nó thuộc về phía sau seam chứ không nằm trong công cụ `bash` của bạn.

## Đặt Sandbox tại tầng tiến trình con

Bây giờ là bài toán bảo mật, và vị trí đặt rào chắn chính là toàn bộ câu trả lời.

Phiên bản đầy cám dỗ thường nhét sự cô lập vào bên trong công cụ:

```typescript
// Sai tầng layer.
execute(input) {
  if (isDangerous(input.command)) throw new Error('bị chặn');
  return shell.run(input.command);
}
```

Mỗi công cụ mới có khả năng spawn bất kỳ thứ gì sẽ lập tức trở thành một lỗ hổng mới. `run_code` vượt qua nó. Máy chủ LSP vượt qua nó. Một phiên terminal vượt qua nó. Sáu tháng sau, bạn có một cơ chế kiểm soát bảo mật với sáu lỗ hổng đã biết và chẳng có lấy một danh sách liệt kê chúng.

> Sự cô lập tiến trình thuộc về **ranh giới subprocess/shell**; sự cô lập tệp thuộc về **ranh giới filesystem**. Cả hai cùng phân giải chung một chính sách sandbox của phiên.

```typescript
export const sandboxedSubprocess: Plugin = {
  name: 'subprocess-sandboxed',
  inject: ['subprocess', 'sandbox'],
  apply(ctx, config: { mode: SandboxMode }) {
    const inner = ctx.subprocess;
    ctx.effect(() => ctx.provide('subprocess', {
      spawn: (spec, signal) => inner.spawn(ctx.sandbox.wrap(spec, config.mode), signal),
    }));
  },
};
```

Một decorator bọc quanh seam tiến trình có thể giam cầm các bên tiêu thụ thực sự sử dụng nó, chẳng hạn như shell, terminal và các language server giao tiếp qua stdio. Các công cụ hệ thống tệp cần provider cưỡng chế chính sách của riêng chúng. Runtime mã chạy trên worker thread có một ranh giới tin cậy riêng biệt và tuyệt đối không được coi là đã tự động được cô lập bởi một wrapper bọc tiến trình con.

Các backend có thể khác nhau theo từng nền tảng và điều đó hoàn toàn bình thường. DeepSeek Harness cung cấp một bộ từ vựng tác động tệp có tính di động cao trong khi các provider tự chịu trách nhiệm về cơ chế nền tảng. Chế độ sandbox chính là bộ từ vựng di động đó:

```typescript
type SandboxMode =
  | 'read-only'         // không được ghi ở bất kỳ đâu
  | 'workspace-write'   // chỉ được ghi trong phạm vi workspace
  | 'danger-full'       // không có bất kỳ sự giam cầm nào — cố tình đặt tên gây khó chịu
```

`danger-full` được đặt tên như vậy là có chủ đích. Nó sẽ xuất hiện sừng sững trong các file cấu hình mà con người phải đọc.

## Workspace thực sự nằm ở đâu?

Một khi việc thực thi có thể diễn ra từ xa, khái niệm "thư mục làm việc" cần một chủ sở hữu rõ ràng. Ba thứ sau đây bắt buộc phải đồng thuận, nếu không agent sẽ đọc một cây thư mục nhưng lại chỉnh sửa ở một cây thư mục khác:

- thư mục gốc của provider hệ thống tệp
- `cwd` của provider tiến trình con
- nơi mà agent tin rằng workspace của nó đang tọa lạc

Hãy biến nó thành một giá trị đã được phân giải duy nhất, được sinh ra một lần duy nhất lúc cấu hình tổ hợp và tiêm vào cả hai provider. Một giá trị `cwd` được cấu hình riêng rẽ ở hai nơi khác nhau là một lỗi bug sẽ biểu hiện dưới dạng một agent tự tin sửa một file vốn không hề tồn tại ở nơi nó đang thực sự chạy.

## Terminal chạy bền vững (Persistent Terminals)

Một số công việc cần một phiên làm việc dài, chứ không phải một câu lệnh đơn lẻ: một REPL, một máy chủ dev server, một prompt tương tác dòng lệnh. Cùng một seam tiến trình con đó, cộng thêm quyền sở hữu và một bộ đệm buffer:

```typescript
interface Terminal {
  readonly id: TerminalId;
  write(data: string): void;
  read(opts?: { since?: number }): Promise<string>;   // đọc từ một ring buffer
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}
```

Hai ràng buộc không hề hiển nhiên cho đến khi chúng làm bạn đau đớn:

**Bộ đệm có giới hạn (Bounded buffer).** Một dev server bị bỏ quên chạy suốt một giờ có thể sinh ra hàng megabyte log. Hãy duy trì một ring buffer, cung cấp tham số `since` để đọc lũy tiến, và để mô hình phân trang đọc thay vì đổ ào một đống dữ liệu — [kỷ luật tràn dữ liệu (spill discipline)](/vi/blog/building-agents/the-context-budget/) cũng áp dụng hoàn hảo cho terminal.

**Được sở hữu bởi agent, và giải phóng cùng với nó.** Một terminal chính xác là loại tài nguyên mà [Phần 15](/vi/blog/building-agents/who-owns-the-agent/) nhắm tới. Nếu nó sống lâu hơn agent của nó, bạn đang có một shell chạy rông trên máy chủ production mà không có ai chịu trách nhiệm về nó.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness có các nhóm package riêng biệt cho `fs`, `subprocess`, `shell`, `terminal`, `sandbox`, `lsp` và `code-runtime` — và chúng được xếp tầng:

```text
subprocess (seam)  ──┬── shell         (bash / pwsh)
                      ├── terminal      (các phiên PTY)
                      └── lsp           (các language server stdio)
         ↑
      sandbox (bọc lại argv trước khi spawn)

fs (seam)  ──┬── các công cụ file (read / write / edit)
             └── các công cụ khám phá (glob / grep)

code-runtime (seam riêng biệt) ── run_code / PTC
```

Và nhóm E2B chính là phần thưởng ngọt ngào: một provider từ xa cho **cả** `fs` và `subprocess`. Gắn kết hai hàng đó vào và các bên tiêu thụ của các seam đó sẽ cùng chuyển dịch đồng bộ. Hàng code-runtime riêng biệt vẫn nằm ở nơi mà provider của chính nó chỉ định.

Đó chính là bài kiểm tra thực tế xem liệu bài viết này đã đi vào hệ thống của bạn hay chưa: **bạn có thể di dời các bên tiêu thụ filesystem và subprocess ra ngoài máy host chỉ bằng cách thay đổi hai hàng provider phối hợp nhịp nhàng hay không?** Nếu mỗi công cụ đều cần một bản fork mã nguồn riêng, các điểm nối seam của bạn đang bị đặt sai chỗ.

## Cái bẫy thường gặp

Cái bẫy là nhét sandbox vào bên trong công cụ.

Đó là nơi mối nguy hiểm *dễ nhìn thấy nhất* — `bash` rõ ràng là kẻ đầy rủi ro, vì vậy đó là nơi người ta vội vàng nhét các bước kiểm tra vào. Nhưng sự dễ nhìn thấy không phải là tiêu chí đúng đắn; **các điểm yết hầu (choke points)** mới là tiêu chí chuẩn xác. Tầng công cụ có bao nhiêu lối vào tùy thuộc vào số lượng công cụ bạn có, và con số đó sẽ liên tục tăng lên. Còn tầng tiến trình con subprocess chỉ có đúng một cửa ải duy nhất, và nó không bao giờ tăng thêm.

Lập luận tương tự cho việc giam cầm đường dẫn tệp: không đặt trong `read`, mà đặt tại điểm nối filesystem seam, nơi mà `glob`, máy chủ LSP và một bên tiêu thụ tương lai bạn chưa từng viết đều bắt buộc phải bước qua.

## Tiếp theo

**[Phần 19 — Cách một Agent thay đổi mã nguồn của bạn](/vi/blog/building-agents/how-an-agent-changes-your-code/)**. Nó vừa chỉnh sửa 14 file và làm hỏng hoàn toàn bài build. Bạn muốn quay trở lại trạng thái cũ. Nhưng chẳng có gì để quay lại cả, bởi vì nó đã ghi thẳng dữ liệu xuống đĩa cứng.
