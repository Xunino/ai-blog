---
title: 'Tầng LLM là một ranh giới giao thức'
description: 'DeepSeek SSE là dữ liệu thô trên đường truyền của nhà cung cấp. Vòng lặp agent cần các khối chuẩn hoá, lỗi ổn định, trạng thái phát lại, và duy nhất một điểm kết thúc terminal.'
pubDate: 2026-09-10
tags: ['ai-agents', 'llm', 'architecture']
translationKey: 'agents-05-llm-layer'
sidebarTitle: '5 · Tầng LLM'
order: 5
---

Trong suốt bốn phần vừa qua, một lệnh gọi duy nhất đã đại diện cho toàn bộ hệ thống con của mô hình:

```typescript
const response = await client.chat.completions.create(request);
```

Điều đó là đủ cho một bản demo. Một bộ khung harness hỗ trợ nhiều hơn một adapter cần một ranh giới rõ ràng giữa định dạng đường truyền (wire format) của nhà cung cấp và phần còn lại của agent.

DeepSeek Harness đặt một dịch vụ `ctx.llm` trung lập với nhà cung cấp tại ranh giới đó. Vòng lặp, session log, bộ thu gọn ngữ cảnh (compactor), và giao diện UI đều giao tiếp bằng một bộ từ vựng chuẩn tắc (canonical vocabulary) duy nhất; chỉ riêng adapter DeepSeek chịu trách nhiệm về HTTP, SSE, các tin nhắn đường truyền, trường suy luận (thinking), và việc ánh xạ mã lỗi đặc thù của nhà cung cấp.

## Các chunk chuẩn tắc, không phải sự kiện thô của nhà cung cấp

Giao thức stream dùng chung là một chuỗi có gắn thẻ (tagged sequence):

```typescript
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
      type: 'tool-call-delta';
      index: number;
      id: ToolCallId;
      name?: string;
      argumentsDelta: string;
    }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

Chỉ số khối (block index) là bắt buộc vì văn bản, suy luận reasoning, và nhiều lệnh gọi công cụ có thể truyền đến dưới dạng các phần delta đan xen nhau. Các đối số của công cụ vẫn giữ nguyên ở dạng chuỗi JSON thô cho đến thời điểm thực thi. Việc cố gắng phân tích cú pháp (parse) JSON chưa trọn vẹn bên trong adapter sẽ biến sự phân mảnh mạng thông thường thành các lỗi cú pháp giả.

<figure class="dg">
  <img src="/diagrams/part05-sse-pipeline-vi.svg" alt="Các payload DeepSeek SSE được phân tích cú pháp thành text, reasoning, và tool-call delta có chỉ số, sau đó được đóng lại thành canonical block trước khi nhận thông tin usage và finish." loading="lazy" />
  <figcaption><strong>Adapter phiên dịch; vòng lặp lắp ráp.</strong> Các trường đặc thù của nhà cung cấp dừng lại tại đường ranh giới này.</figcaption>
</figure>

Bộ chuyển đổi DeepSeek duy trì một khối văn bản đang mở, một khối suy luận (reasoning), và một map chứa các khối lệnh gọi công cụ được định danh bằng chỉ số lệnh gọi trên đường truyền mạng. ID và tên của lệnh gọi công cụ xác lập danh tính; các trường rỗng hoặc null đến sau không được phép xóa bỏ chúng. Các mảnh đối số được gom dồn lại dưới dạng văn bản.

DeepSeek có thể đính kèm thông tin token usage vào chunk chứa tín hiệu finish, hoặc gửi một chunk chỉ chứa riêng usage ở cuối cùng. Adapter lưu giữ usage mới nhất và hoãn lại mọi sự kiện `block-end`, sau đó đến `usage`, và cuối cùng là sự kiện kết thúc `finish` cho đến khi gặp tín hiệu `[DONE]`. Tuyệt đối không có bất kỳ thứ gì được phép xuất hiện sau `finish`.

## Duy nhất một điểm kết thúc (terminal finish)

Bộ từ vựng của Harness phân biệt rạch ròi giữa lý do dừng thành công và kết quả thất bại:

| Loại finish | Ý nghĩa trong vòng lặp |
|---|---|
| `stop` | Mô hình hoàn thành mà không yêu cầu thêm lượt gọi công cụ nào. |
| `tool-calls` | Tin nhắn assistant được lắp ráp có chứa các lệnh gọi cần điều phối thực thi. |
| `max-tokens` | Tin nhắn assistant hợp lệ một phần đã chạm ngưỡng giới hạn token đầu ra. |
| `aborted` | Việc hủy bỏ từ caller đã kết thúc nỗ lực gọi nhà cung cấp. |
| `error` | Lỗi tầng truyền tải, lỗi giao thức, lỗi từ nhà cung cấp, hoặc lỗi finish được ánh xạ. |

<figure class="dg">
  <img src="/diagrams/part05-terminal-finishes-vi.svg" alt="Mọi nỗ lực gọi mô hình đều kết thúc đúng một lần dưới dạng stop, tool-calls, max-tokens, aborted, hoặc error." loading="lazy" />
  <figcaption><strong>Hủy bỏ không phải là sự cố của nhà cung cấp.</strong> Việc tách biệt `aborted` ngăn chặn thao tác ngắt của người dùng làm ô nhiễm số liệu độ tin cậy và chính sách thử lại (retry).</figcaption>
</figure>

Trên đường truyền DeepSeek, các trạng thái `stop`, `tool_calls`, và `length` được ánh xạ tương ứng thành `stop`, `tool-calls`, và `max-tokens`. Một giá trị chưa biết như `content_filter` sẽ trở thành một `error` mang mã chữ hoa ổn định; nó không bị âm thầm coi như một câu trả lời rỗng thành công.

Nếu nguồn SSE kết thúc trước khi có tín hiệu `[DONE]`, hoặc một payload bị biến dạng, adapter sẽ ném ra lỗi có kiểu `LlmError`. Tầng LLM runtime bên ngoài sẽ chuẩn hóa các ngoại lệ do adapter ném ra thành cấu trúc chunk kết thúc `error` hoặc `aborted` tương tự. Do đó, các tầng tiêu thụ không cần đến một giao thức ngoại lệ thứ hai cho các lỗi nhà cung cấp thông thường.

## Khâu lắp ráp nghiêm ngặt hơn phép nối chuỗi đơn thuần

`BlockAssembler` thực thi các bất biến của luồng stream trong khi tái tạo lại toàn bộ nội dung hoàn chỉnh:

- các delta phải tham chiếu đến một khối đang mở có kiểu tương ứng;
- mỗi khối chỉ đóng một lần duy nhất;
- sự kiện usage luôn đi trước finish;
- finish chỉ xuất hiện duy nhất một lần;
- không có dữ liệu nào được phép đi sau finish.

Vòng lặp ghi lại từng chunk chuẩn tắc thô vào log dưới dạng sự kiện `assistant/chunk`. Sau khi lắp ráp thành công, nó ghi thêm một sự kiện `assistant/message` duy nhất có trường `sourceEventSeqs` trích dẫn chính xác các chunk đã tạo ra nó.

Khi bị hủy bỏ, bộ lắp ráp vẫn có thể trả về các khối đã bị ngắt quãng. Nếu nội dung có thể hiển thị đã truyền đến trước khi có lệnh hủy, vòng lặp sẽ ghi thêm một `assistant/message` được đánh dấu `interrupted: true`. Yêu cầu tiếp theo sau đó có thể chứa cùng tiền tố mà người dùng đã nhìn thấy, thay vì giả vờ như phản hồi dở dang đó chưa từng tồn tại.

## Phát lại ý nghĩa, không phải các byte tùy tiện trên đường truyền

“Lặp lại nguyên văn phản hồi thô” là một lời khuyên tốt cho một vòng lặp siêu nhỏ chỉ dùng một nhà cung cấp đơn lẻ, nhưng đó không phải là một kiến trúc đủ tốt.

DeepSeek Harness lưu trữ các khối assistant chuẩn tắc:

- văn bản hiển thị vẫn là `text`;
- dòng suy luận (thinking) vẫn là khối `reasoning` riêng biệt;
- mỗi lệnh gọi công cụ giữ nguyên id, name và chuỗi tham số thô.

Adapter DeepSeek tuần tự hóa các khối đó ngược trở lại thành `content`, `reasoning_content`, và `tool_calls`. Mỗi kết quả công cụ trở thành một tin nhắn đường truyền riêng biệt với `role: 'tool'` được liên kết qua `tool_call_id`.

Các adapter cũng có thể đính kèm `replayState` ẩn (opaque) khi nhà cung cấp yêu cầu metadata tiếp nối riêng tư. Trạng thái đó chỉ đi kèm khi cùng một phiên bản adapter sở hữu cả tuyến đường lịch sử lẫn tuyến đường đích; việc chuyển đổi adapter sẽ chủ động loại bỏ nó. Ý nghĩa cuộc hội thoại chuẩn tắc có tính di động cao, còn trạng thái riêng tư của nhà cung cấp thì không được mặc định như vậy.

## Chính sách thử lại (Retry) nằm ngoài adapter

Dịch vụ LLM thực hiện một nỗ lực gọi duy nhất tới nhà cung cấp. Nó ghi lại mã lỗi ổn định như `RATE_LIMIT`, `AUTH`, hoặc `CONTEXT_WINDOW_EXCEEDED`, nhưng không tự động phát lại yêu cầu.

Việc thực thi thử lại thuộc về ranh giới bước lỗi bền vững (durable failed-step) của agent. Một plugin thử lại có thể kết hợp chính sách của adapter với trạng thái phiên, trạng thái hủy bỏ và quá trình phục hồi khi tràn ngữ cảnh. Việc giấu nhẹm cơ chế thử lại bên trong mã HTTP sẽ làm cho mức độ sử dụng, thời gian và ngữ nghĩa đầu ra một phần trở nên vô hình đối với vòng lặp.

## Chuẩn bị yêu cầu là một phần của ranh giới

Trước khi điều phối gửi đi, `prepareCall()` sẽ phân giải thế hệ adapter chính xác và metadata của mô hình, xác thực mức độ suy luận (reasoning effort) cùng các phương thức đầu vào (modalities), hiện thực hóa các giá trị mặc định thuộc về adapter, và đóng băng sâu (deep-freeze) yêu cầu. Chính adapter đã được chụp lại đó sẽ thực hiện việc điều phối kết thúc.

Tính nguyên tử đó rất quan trọng trong quá trình tải lại nóng (hot reload). Nếu không có nó, khả năng của mô hình có thể được phân giải từ một thế hệ cấu hình trong khi yêu cầu HTTP lại sử dụng một thế hệ cấu hình khác.

## Tiếp theo

**[Phần 6 — MCP: Các công cụ từ tiến trình bạn không kiểm soát](/vi/blog/building-agents/tools-from-outside-mcp/)**. Chuẩn hóa nhà cung cấp giải quyết sự đa dạng của mô hình; ranh giới tiếp theo là các công cụ được khám phá động thuộc quyền sở hữu của một tiến trình khác.
