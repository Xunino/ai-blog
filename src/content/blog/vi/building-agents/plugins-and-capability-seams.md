---
title: 'Plugin và các điểm kết nối năng lực (Capability Seams)'
description: 'Chạy các công cụ trong một sandbox từ xa thay vì trên cỗ máy này. Hãy đếm xem bạn phải sửa bao nhiêu file — con số đó sẽ cho bạn biết liệu bạn có thực sự sở hữu một kiến trúc hay không.'
pubDate: 2026-09-18
tags: ['ai-agents', 'architecture', 'plugins']
translationKey: 'agents-13-seams'
sidebarTitle: '13 · Điểm kết nối (Seams)'
order: 13
---

Yêu cầu chỉ vỏn vẹn đúng một câu: *hãy chạy các công cụ trong một sandbox từ xa thay vì chạy trực tiếp trên cỗ máy này.*

Hãy đi và đếm số lượng file bạn phải chỉnh sửa. Trong hệ thống được xây dựng từ đầu đến giờ: `run_command` gọi trực tiếp `execSync`, `read_file` gọi trực tiếp `readFileSync`, kho lưu trữ tràn spill store ghi vào một đường dẫn cục bộ, và thư mục làm việc là một hằng số cố định ở cấp module. Bốn file, bốn giả định hoàn toàn khác nhau về việc "ở đây" là ở đâu, và không có một nơi duy nhất nào đại diện cho *cỗ máy nơi công việc thực sự diễn ra*.

Số lượng file cần sửa đó chính là bài kiểm tra chẩn đoán. Một chỗ sửa duy nhất có nghĩa là bạn sở hữu một điểm kết nối (seam). Bốn chỗ sửa có nghĩa là bạn đang có bốn bản sao của một quyết định mà chưa ai từng viết ra thành văn bản.

## Ba vai trò, nếu không thì đó không phải là một điểm kết nối

Từ "trừu tượng hóa (abstraction)" là chưa đủ ở đây, bởi vì nó không nói rõ có bao nhiêu mảnh ghép cấu thành.

> Một **điểm kết nối năng lực (capability seam)** gồm ba vai trò: một **Định nghĩa dịch vụ (Service Definition)** khai báo interface hợp đồng, một **Nhà cung cấp dịch vụ (Service Provider)** hiện thực hóa nó, và một **Bên tiêu thụ (Consumer)** sử dụng nó. Chỉ có một vai trò đơn độc thì không phải là một seam — đó chỉ là một interface chưa từng có ai hoán đổi.

```text
Definition   interface Shell { run(spec): Promise<Result> }        ← chỉ là bản hợp đồng
Provider     LocalShell · SandboxedShell                           ← có thể hoán đổi cho nhau
Consumer     công cụ `bash`                                        ← chỉ biết đến Definition
```

Consumer chỉ phụ thuộc vào Definition, tuyệt đối không bao giờ phụ thuộc vào Provider. Mũi tên phụ thuộc đó là thứ giúp cho việc hoán đổi trở nên khả thi, và nó cũng là thứ người ta hay phá vỡ đầu tiên — thường bằng cách import thẳng một class cụ thể "chỉ để lấy cái type". Nếu bạn không thể gọi tên đầy đủ cả ba vai trò này, bạn chưa hề xây dựng một seam.

<figure class="dg">
  <img src="/diagrams/part13-plugins-seams.svg" alt="Một seam có ba vai trò: một Definition mà Consumer phụ thuộc vào, và các Provider có thể hoán đổi cho nhau đứng phía sau." loading="lazy" />
  <figcaption><strong>Chỉ một vai trò đơn độc thì không phải là seam.</strong> Một interface chỉ có đúng một triển khai và một lệnh import trực tiếp là một thứ seam mà trình biên dịch sẽ cho phép bạn xóa bỏ hoàn toàn.</figcaption>
</figure>

## Đăng ký là một tác động có thể hoàn tác (Effect)

Đây là nửa còn lại của mẫu hình thiết kế, và là nửa rất dễ bị bỏ qua vì không có thứ gì ép bạn phải làm nó từ sớm.

> Mọi đóng góp năng lực đều phải tự trả về thao tác hoàn tác (undo) của chính nó.

Bạn đã nhìn thấy điều này ba lần trước đây mà tôi chưa kịp gọi tên — `registry.register()` trong Phần 3, `systemPrompt.section()` trong Phần 9, và `skills.register()` trong Phần 11. Cả ba đều trả về một hàm hủy disposer. Đó là sự sắp đặt có chủ đích.

```typescript
type Disposer = () => void;

class Context {
  private disposers: Disposer[] = [];

  effect(setup: () => Disposer): void {
    this.disposers.push(setup());
  }

  dispose(): void {
    // Thứ tự ngược lại: đăng ký sau cùng sẽ được gỡ bỏ đầu tiên.
    for (const d of this.disposers.reverse()) d();
    this.disposers = [];
  }
}
```

Một plugin khi đó chỉ là một hàm đóng góp năng lực thông qua một context:

```typescript
export interface Plugin {
  name: string;
  /** Các dịch vụ mà plugin này cần có trước khi nó có thể áp dụng. */
  inject?: string[];
  apply(ctx: Context, config?: unknown): void;
}

export const bashTool: Plugin = {
  name: 'tool-bash',
  inject: ['tools', 'shell'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'bash',
      description: 'Chạy một lệnh shell.',
      inputSchema: { /* ... */ },
      execute: (input) => ctx.shell.run({ command: input.command }),
    }));
  },
};
```

Hãy nhìn vào những gì bạn vừa nhận được. Công cụ hoàn toàn không cần biết `ctx.shell` đang chạy với trình thực thi cục bộ hay trong sandbox. Việc gỡ bỏ plugin (unload) sẽ tự động xóa sạch công cụ — khỏi registry, khỏi prompt, khỏi thế giới nhận thức của mô hình — mà không cần bất kỳ đoạn mã dọn dẹp nào ở bất kỳ nơi nào khác. Và trường `inject` đảm bảo thứ tự nạp được tự động suy ra thay vì phải duy trì thủ công.

## Cuộc hoán đổi Provider

Bây giờ hãy quay lại yêu cầu ban đầu. Bản Definition:

```typescript
export interface ShellSpec { command: string; cwd?: string; timeoutMs?: number }
export interface ShellResult { stdout: string; stderr: string; exitCode: number }

export interface Shell {
  run(spec: ShellSpec, signal: AbortSignal): Promise<ShellResult>;
}
```

Hai provider, được minh họa ở đây dưới dạng thiết kế từ máy cục bộ sang container thay vì sao chép nguyên văn mã nguồn từ DeepSeek Harness:

```typescript
export const localShell: Plugin = {
  name: 'shell-local',
  apply(ctx) {
    ctx.effect(() => ctx.provide('shell', {
      run: (spec, signal) => execFile('bash', ['-lc', spec.command], { signal, cwd: spec.cwd }),
    }));
  },
};

export const dockerShell: Plugin = {
  name: 'shell-docker',
  apply(ctx, config: { image: string }) {
    ctx.effect(() => ctx.provide('shell', {
      run: (spec, signal) =>
        execFile('docker', ['run', '--rm', '-w', spec.cwd ?? '/w', config.image,
                            'bash', '-lc', spec.command], { signal }),
    }));
  },
};
```

Và việc phối hợp cấu hình (composition) chỉ là một danh sách:

```yaml
plugins:
  - name: tools
  - name: shell-docker          # trước đây là: shell-local
    config: { image: 'node:22' }
  - name: tool-bash
```

Đúng một dòng duy nhất. Bản thân công cụ không đổi, vòng lặp không đổi, không có bất kỳ thứ gì *sử dụng* shell phải thay đổi. Đó chính là ý nghĩa mà bài kiểm tra đếm số lượng file cần sửa nhắm tới.

## Profile và các tầng xếp chồng (Layers)

Một khi việc phối hợp đã được biểu diễn dưới dạng dữ liệu, bạn sẽ muốn có các biến thể — một bộ chạy không giao diện (headless runner), một ứng dụng web, một khung kiểm thử test harness — chúng dùng chung phần lớn cây thành phần và chỉ khác nhau ở vùng rìa. Việc sao chép danh sách cấu hình cho từng biến thể đồng nghĩa với việc bạn phải sửa một lỗi bug năm lần ở năm nơi khác nhau.

Các tầng xếp chồng (layers), được áp dụng tuần tự, mỗi tầng vá đè lên tầng trước đó:

```text
base bundle          cây thành phần dùng chung: tools, persistence, policy, adapters
  + app bundle       những gì ứng dụng cụ thể này bổ sung thêm (server, CLI, giao thức)
  + profile patch    những gì môi trường triển khai này thay đổi
  + user patch       những gì cỗ máy cá nhân này thay đổi
  + --patch overlay  những gì lần gọi lệnh cụ thể này ghi đè
```

Một bản patch nhắm vào một hàng theo định danh id và thay thế phần cấu hình của nó, hoặc chèn thêm một hàng mới. Nhờ đó, bài toán "cùng một agent đó, nhưng chạy trong một thế giới thực thi từ xa" chỉ là một overlay áp đặt lên trên chứ không phải là một nhánh fork rẽ rời của toàn bộ cấu hình.

Và có một quy tắc vận hành mang lại lợi ích ngay trong tuần đầu tiên: **hãy làm cho cây cấu hình sau khi merge có thể in ra được dễ dàng.**

```bash
$ agent --dump-config
```

Khi ai đó thắc mắc tại sao một công cụ bỗng nhiên biến mất, câu trả lời nằm ngay trong đầu ra của lệnh đó — hàng cấu hình nào đã vô hiệu hóa nó, và tầng layer nào đã viết ra hàng đó. Nếu không có lệnh này, việc gỡ lỗi cấu hình tổ hợp chẳng khác nào đi khảo cổ học.

## Khi nào KHÔNG NÊN dựng một điểm kết nối?

Mẫu hình này rất quyến rũ và cái giá phải trả cũng rất thật: một interface, một registry, thêm một tầng gián tiếp ở mọi điểm gọi, và một stack trace phải nhảy qua ba file mới chạm tới đoạn mã thực sự làm việc.

> Chỉ trích xuất một seam khi bạn đã có **hai triển khai thực tế**, hoặc một triển khai và một cam kết chắc chắn bằng văn bản về triển khai thứ hai. Tuyệt đối không làm trước điều đó.

Trình tự trung thực là: viết nó thẳng vào mã (inline), viết triển khai thứ hai cũng thẳng vào mã, quan sát xem những điểm nào thực sự khác nhau giữa chúng, *rồi sau đó mới* trích xuất thành seam. Interface bạn có được từ hai triển khai đang chạy tốt sẽ luôn luôn chính xác. Còn interface bạn vẽ ra từ trí tưởng tượng về cái thứ hai sẽ là một hình thù quái gở mà bạn sẽ phải vật lộn đau khổ suốt một năm trời.

Các dấu hiệu cho thấy lẽ ra bạn phải trích xuất seam từ lâu: cùng một câu lệnh điều kiện `if/else` xuất hiện ở nhiều hơn hai file; một hàm nhận tham số kiểu `mode: 'local' | 'remote'`; một bài test bắt buộc phải khởi tạo một tiến trình con subprocess thực sự chỉ vì không có cách nào để thay thế.

## Lời kết: Agent tự điều chỉnh chính nó

Một khi việc phối hợp đã là dữ liệu và việc đăng ký có thể đảo ngược hoàn tác, một khả năng kỳ diệu nữa sẽ mở ra, và bạn rất nên biết nó tồn tại ngay cả khi không bao giờ đưa vào sản phẩm chính thức.

Về mặt nguyên lý, một agent hoàn toàn có thể tự kiểm tra cây plugin của chính mình, tự định nghĩa một plugin mới, tự gắn nó vào hệ thống (mount), sử dụng nó, rồi tự tháo gỡ nó (unmount) ngay trong phiên làm việc. DeepSeek Harness không cung cấp tính năng này như một năng lực mặc định hướng về mô hình; đó chỉ là một sự ngoại suy kiến trúc bắt nguồn từ bản hợp đồng `ctx.effect`.

Nó thực sự cực kỳ hữu ích cho việc khám phá thử nghiệm nhưng đồng thời cũng là một lỗ hổng to đùng xuyên qua mọi ranh giới an toàn bạn đã dày công dựng nên, vì một plugin được gắn vào có thể tự do đăng ký một pre-hook để vô hiệu hóa hoàn toàn cơ chế phê duyệt. Nếu bạn xây dựng tính năng này, hãy khóa chặt nó phía sau một lớp phân quyền nghiêm ngặt ([Phần 22](/vi/blog/building-agents/approval-and-permissions/)) và đối xử với nó như một tính năng dành riêng cho quản trị viên tối cao.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness được xây dựng trên nền tảng Cordis và đưa triết lý này đi xa hơn hầu hết các hệ thống khác: **mọi thành phần của sản phẩm đều là một plugin**, bao gồm cả adapter mô hình, registry công cụ, session log, và ngay cả chính bản thân vòng lặp agent loop. Hoàn toàn không có một phần lõi đặc quyền nào — bạn mở rộng hệ thống bằng cách gắn thêm một plugin đứng ngang hàng bên cạnh các plugin khác.

Hai hệ quả rất đáng học hỏi:

**Sự phân tách Definition/Provider/Consumer lộ rõ ngay trong tên package.** `dsh-shell` là Definition, `dsh-shell-local` là Provider, `dsh-tool-bash` là Consumer. Chiều hướng phụ thuộc được cưỡng chế nghiêm ngặt bởi đồ thị dependency của package thay vì dựa vào tính kỷ luật của lập trình viên — một Consumer cố tình import một Provider sẽ lập tức bị báo lỗi khi kiểm tra mã.

**Các Provider có thể siêu nhỏ gọn.** Provider subagent chạy trong tiến trình chỉ vỏn vẹn 70 dòng code: một bảng khai báo năng lực và hai lệnh gọi vào một driver dùng chung. Khi các provider của bạn nhỏ gọn đến mức đó, việc bổ sung thêm một backend mới không còn là một dự án kéo dài hàng tháng trời.

## Cái bẫy thường gặp

Cái bẫy là vội vã xây dựng seam trước khi có triển khai thực tế thứ hai.

Lý lẽ biện minh luôn luôn giống nhau và nghe chừng rất cẩn trọng: chắc chắn sau này chúng ta sẽ cần một bộ thực thi từ xa, vì vậy hãy thiết kế sẵn cho nó ngay bây giờ. Thế rồi hình thù của interface bị nhào nặn bởi trí tưởng tượng viển vông thay vì nhu cầu thực tế của một caller thứ hai. Nó mang những tham số sai lệch, và đến khi triển khai thứ hai thực sự xuất hiện, nó lại cần một trường mà bạn chưa hề nghĩ tới — kết quả là bạn phải liên tục nới rộng interface cho đến khi nó trở thành một mớ hỗn độn hợp nhất của hai thứ cụ thể mang một cái tên chung chung vô nghĩa.

Hãy làm xong hai triển khai thực tế trước đã. Điểm kết nối seam sẽ tự nhiên rơi ra từ chính phần diff giữa chúng, và nó sẽ chính xác ngay từ lần đầu tiên.

## Tiếp theo

**[Phần 14 — Sự kiện và Waterfalls](/vi/blog/building-agents/events-and-waterfalls/)**. Bạn muốn cơ chế thu gọn ngữ cảnh compaction chạy ngay trước khi yêu cầu mô hình được dựng, mà không để compaction biết bất cứ điều gì về vòng lặp và cũng không để vòng lặp biết bất cứ điều gì về compaction.
