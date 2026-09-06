---
title: 'Công cụ không phải là một hàm thuần túy'
description: 'Trong một agent cấp production, công cụ là một bản hợp đồng định kiểu, một chính sách thực thi, một kết quả bền vững, và một hình chiếu giao diện có thể phát lại được — chứ không đơn thuần là một callback.'
pubDate: 2026-09-08
tags: ['ai-agents', 'architecture', 'tools']
translationKey: 'agents-03-tools'
sidebarTitle: '3 · Công cụ (Tools)'
order: 3
---

“Hãy hỏi ý kiến tôi trước bất kỳ hành động phá hủy nào” là yêu cầu phơi bày ngay sự ngây thơ trong thiết kế công cụ kiểu cũ.

Nếu một công cụ chỉ là một lệnh `switch-case`, mã kiểm tra phê duyệt sẽ bị nhét vào bên trong `bash`, rồi lại nhét vào bên trong `write_file`, rồi rải rác khắp mọi nơi có khả năng làm biến đổi trạng thái (mutation). Chính sách bị phân mảnh và nhân bản, và công cụ mới được cài đặt đầu tiên sẽ lập tức trở thành lỗ hổng vượt rào đầu tiên.

Góc nhìn an toàn hơn là:

> Một công cụ là một bản hợp đồng đi vào một pipeline thực thi dùng chung duy nhất.

Hàm callback chỉ là phần nằm ở giữa.

## Bản hợp đồng chứa nhiều thứ hơn là một input schema

DeepSeek Harness giao cho mỗi công cụ được đăng ký nhiều trách nhiệm rõ rệt:

```typescript
interface ToolDefinition {
  // Bản hợp đồng đầu vào hướng về phía mô hình
  name: string;
  description: string;
  parameters: JsonSchema;

  // Bản hợp đồng đầu ra chuẩn hóa dành cho máy móc
  output: {
    schema: JsonSchema;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
  };

  // Tác động thực tế
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;

  // Chính sách runtime và hiển thị UI
  isConcurrencySafe?(args: unknown): boolean;
  timeoutMs?: number;
  finalizeContent?(exec: ToolExecution, result: ToolExecutionResult): ContentBlock[] | undefined;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

Đây là bản giản lược từ interface thực tế, nhưng sự phân tách là hoàn toàn chính xác.

Input schema hướng dẫn mô hình cách gọi công cụ và xác thực payload không đáng tin cậy từ mô hình. Output schema xác thực giá trị JSON chuẩn tắc của công cụ. `render` biến giá trị đó thành các content block mà mô hình có thể đọc được. Các phương thức hiển thị (presentation) trích xuất ý định hiển thị UI có thể phát lại (replayable) mà không làm thay đổi những gì mô hình tiếp nhận.

Sự phân tách đó ngăn chặn một sai lầm thiết kế phổ biến: trả về một chuỗi văn bản đã định dạng sẵn rồi sau này lại cố gắng bóc tách dữ liệu có cấu trúc, mã diff, hoặc thẻ trạng thái từ chuỗi văn bản xuôi đó.

## Toàn bộ đường ống thực thi (execution path)

Pipeline của Harness rộng hơn nhiều so với chuỗi đơn giản “trước, thực thi, sau”:

<figure class="dg">
  <img src="/diagrams/part03-tool-pipeline-vi.svg" alt="Một lệnh gọi công cụ đi qua chính sách tiền thực thi, các guard đơn điệu, phê duyệt tùy chọn, middleware bao quanh thực thi, thân công cụ, chính sách hậu thực thi, chuẩn hóa cuối cùng, và ghi log kết quả bền vững." loading="lazy" />
  <figcaption><strong>Một lệnh gọi, một con đường quản trị duy nhất.</strong> Các lệnh gọi native, lệnh gọi MCP, và các lệnh gọi từ mã do mô hình tự viết đều hội tụ vào cùng một ranh giới chính sách này.</figcaption>
</figure>

1. **Phân giải và xác thực (Resolve & validate):** Tìm công cụ trong registry có phạm vi của caller, snapshot các đối số, và kiểm tra cấu trúc JSON của chúng.
2. **`tools/pre-execute`:** Các listener theo cơ chế waterfall có thể cho phép, từ chối, hoặc yêu cầu người dùng phê duyệt. Nếu tính năng phê duyệt bị thiếu hoặc không thể trả lời, trạng thái `ask` sẽ tự động chuyển thành từ chối (deny).
3. **Monotonic guards (Các rào chắn đơn điệu):** Các guard đã đăng ký chỉ có thể làm quyết định trở nên nghiêm ngặt hơn. Chúng không thể dùng một listener phía sau để biến một quyết định từ chối ngược lại thành cho phép.
4. **`tools/execute`:** Middleware bao quanh việc điều phối (around-dispatch) cung cấp deadline giới hạn thời gian, cơ chế thử lại (retry), và đo lường số liệu trong khi vẫn giữ nguyên tín hiệu hủy (cancellation signal) của caller ban đầu.
5. **Thân công cụ (Tool body):** Lệnh gọi được chấp nhận sẽ trả về một giá trị JSON chuẩn tắc. Mọi ngoại lệ (throw) đều được chuẩn hóa thành kết quả lỗi thất bại.
6. **`tools/post-execute`:** Các listener có thể chấp nhận, thay thế, bổ sung dữ liệu hoặc chặn kết quả đã chuẩn hóa.
7. **Xác thực đầu ra và kết xuất (Output validation & rendering):** Các giá trị thành công được kiểm tra đối chiếu với output schema đã khai báo và được chiếu thành các content block.
8. **`finalizeContent`:** Công cụ sở hữu có một cơ hội cuối cùng để chuyển đổi chỉ riêng phần nội dung; các trường định danh và trạng thái thất bại thuộc quyền của registry không thể bị ghi đè.
9. **`tools/result`:** Một snapshot bất biến (frozen), không mất mát dữ liệu được phát ra cho các observer, sau đó vòng lặp agent sẽ ghi thêm một `tool/result` bền vững vào log.

Việc đặt chính sách ở đâu chính là mấu chốt. Kiểm tra phê duyệt không thuộc về mã cài đặt shell, bởi vì cùng một shell đó có thể được gọi tự nhiên (natively), thông qua mã do mô hình viết, hoặc từ một bên sử dụng khác. Nó thuộc về nơi mà mọi lệnh gọi đều phải hội tụ qua.

## Sự từ chối vẫn là một kết quả

Khi chính sách từ chối một lệnh gọi, mô hình cần một kết quả quan sát rõ ràng:

```typescript
{
  content: [{ type: 'text', text: 'Người dùng đã từ chối thao tác này.' }],
  isError: true,
  error: { code: 'APPROVAL_DENIED' }
}
```

Âm thầm bỏ qua lệnh gọi sẽ khiến cuộc hội thoại bị khuyết tật về mặt cấu trúc: assistant đã phát ra một ID lệnh gọi công cụ, nhưng không hề có kết quả tương ứng nào tồn tại. Quăng lỗi từ chối ra ngoài vòng lặp cũng không tốt hơn; mô hình sẽ không có cơ hội chọn một giải pháp an toàn khác để thay thế.

Một tác động bị từ chối thì không được phép xảy ra, nhưng sự thật về việc nó bị từ chối bắt buộc phải hiển thị rõ ràng và được lưu trữ bền vững.

## Lập lịch cũng là một dạng chính sách

Khi một tin nhắn của assistant chứa nhiều lệnh gọi công cụ, runtime phải quyết định lệnh nào có thể chạy đan xen song song với nhau.

DeepSeek Harness sử dụng hai chế độ thực thi:

- **`parallel`**: công cụ trả về `true` một cách tường minh từ hàm `isConcurrencySafe(args)`;
- **`exclusive`**: là mặc định cho các bộ phân loại bị bỏ qua, bị lỗi throw, hoặc trả về `false`.

<figure class="dg">
  <img src="/diagrams/part03-barrier-scheduler-vi.svg" alt="Các lệnh gọi an toàn song song chạy đan xen trong một pool có giới hạn; các lệnh gọi độc quyền chờ pool giải phóng và chạy một mình như những rào chắn thứ tự." loading="lazy" />
  <figcaption><strong>Song song là cơ chế opt-in; độc quyền là mặc định an toàn.</strong> Việc điều phối có thể đan xen, nhưng các kết quả bền vững luôn được ghi nhận theo đúng thứ tự ban đầu của mô hình.</figcaption>
</figure>

Ba chi tiết biến cơ chế này vượt trội hơn một lệnh `Promise.all` thông thường:

**Pool có giới hạn (Bounded pool):** Tối đa `maxParallelToolCalls` thân hàm chạy song song cùng một lúc. Mô hình không thể tạo ra sự bùng nổ fan-out cục bộ vô hạn chỉ với một phản hồi.

**Phân loại lại trực tiếp (Live reclassification):** Một lệnh gọi phía sau được phân loại lại ngay trước khi nó bắt đầu. Các thay đổi về registry hoặc chính sách do một commit có thứ tự phía trước tạo ra có thể biến một lệnh gọi chưa bắt đầu thành một rào chắn độc quyền (exclusive barrier).

**Commit theo đúng thứ tự (Ordered commit):** Quá trình thực thi có thể hoàn thành lệch thứ tự, nhưng khâu hậu xử lý, các sự kiện `tool/result` bền vững và ngữ cảnh bổ sung luôn được commit theo thứ tự của mô hình. Tính tất định (determinism) được bảo toàn mà không phải từ bỏ khả năng chạy đan xen an toàn.

Việc hủy bỏ sẽ dừng nạp thêm việc vào pool, rút cạn những việc đã bắt đầu, và ghi các kết quả lỗi giả lập (synthetic error results) cho những lệnh gọi chưa từng được điều phối. Bước cuối cùng đó giữ cho việc phát lại (replay) luôn hợp lệ về mặt cấu trúc: mọi lệnh gọi công cụ của assistant đều có một kết quả đi kèm.

## Schema và giao diện UI phải dùng chung một nguồn sự thật

Thẻ giao diện trạng thái chờ (pending UI card) được trích xuất từ các đối số lưu kèm với `tool/call`. Thẻ giao diện khi đã hoàn thành được trích xuất từ các đối số đó cộng với kết quả bền vững và metadata hiển thị tùy chọn. Cả hai luồng này đều không được phép phụ thuộc vào trạng thái công cụ có thể biến đổi (mutable) lúc đang chạy, bởi vì việc phát lại sau đó nhiều giờ đồng hồ vẫn phải hiển thị cùng một ý nghĩa chính xác.

Đây là lý do tại sao tư duy “chỉ cần trả về Markdown” nhanh chóng bộc lộ hạn chế. Nội dung cho mô hình đọc, dữ liệu chuẩn tắc dành cho máy tính, và giao diện trực quan cho con người là ba hình chiếu (projections) phục vụ các đối tượng hoàn toàn khác nhau.

## Tiếp theo

**[Phần 4 — Hộp thư đến (The Inbox)](/vi/blog/building-agents/the-inbox/)**. Khi việc thực thi công cụ cần nhiều thời gian, agent cần một nơi rõ ràng và chính xác cho các câu hỏi tiếp theo, các tín hiệu điều hướng tức thời và ngữ cảnh thụ động được gửi đến trong lúc nó đang làm việc.
