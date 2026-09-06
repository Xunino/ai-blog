---
title: 'Ngân sách ngữ cảnh'
description: 'Một lệnh grep duy nhất trả về 200KB và giết chết cuộc hội thoại. Ngữ cảnh bị tiêu tốn bởi kết quả công cụ chứ không phải bởi mô hình — vì vậy hãy quản lý nó ngay nơi sinh ra kết quả.'
pubDate: 2026-09-15
tags: ['ai-agents', 'llm', 'performance']
translationKey: 'agents-10-context-budget'
sidebarTitle: '10 · Ngân sách ngữ cảnh'
order: 10
---

```text
> grep -rn "id" src/
[204,881 bytes]
```

Toàn bộ sự cố chỉ tóm gọn trong ngần ấy dòng. Một câu lệnh duy nhất, một kết quả trả về, và một cuộc trò chuyện đang diễn ra êm đẹp suốt hai mươi phút bỗng chốc chỉ còn cách mức trần kịch khung đúng ba turn. Agent không học thêm được điều gì hữu ích và cũng không còn đủ khả năng chi trả để nạp thêm bất kỳ dữ liệu nào khác.

Trong một phiên làm việc thực tế, kết quả của công cụ chiếm từ 60–85% lượng token. Bản thân đầu ra của mô hình chỉ chiếm 5–15%; và đầu vào của người dùng thường dưới 5%.

> **Ngữ cảnh bị tiêu thụ bởi kết quả công cụ, chứ không phải bởi lời lẽ của mô hình.** Hãy quản lý nó ngay tại nơi kết quả được sinh ra, chứ không phải đợi đến lúc cửa sổ ngữ cảnh cạn kiệt.

Bản năng đầu tiên của mọi người luôn là tóm tắt (summarisation). Nhưng đó là đòn bẩy *cuối cùng*, và là đòn bẩy duy nhất làm mất mát thông tin mà bạn không bao giờ có thể lấy lại được.

<figure class="dg">
  <img src="/diagrams/part10-context-budget.svg" alt="Bốn đòn bẩy theo thứ tự: giới hạn (cap), tràn ra ngoài (spill), cắt tỉa (prune) và chỉ sau đó mới tóm tắt (summarise), vốn là đòn bẩy duy nhất phá hủy thông tin." loading="lazy" />
  <figcaption><strong>Tóm tắt là đòn bẩy cuối cùng, không phải đầu tiên.</strong> Có ba đòn bẩy rẻ hơn đứng trước nó, và hai trong số đó không làm mất mát bất kỳ thông tin nào.</figcaption>
</figure>

## Đòn bẩy thứ nhất: Giới hạn (Cap) ngay tại nguồn

Cách sửa chữa rẻ nhất là đặt một giới hạn trong giai đoạn `post` của pipeline, áp dụng đồng loạt cho mọi công cụ — đó chính là phần thưởng cho việc xây dựng [một pipeline](/vi/blog/building-agents/tools-registry-schema-pipeline/) trong Phần 3.

```typescript
const MAX_RESULT_BYTES = 20_000;

registry.addPostHook(async (tool, result) => {
  if (result.length <= MAX_RESULT_BYTES) return result;
  const head = result.slice(0, MAX_RESULT_BYTES);
  const dropped = result.length - MAX_RESULT_BYTES;
  return `${head}\n\n[bị cắt bớt: còn ${dropped} byte nữa]`;
});
```

Dấu hiệu `[bị cắt bớt]` không phải là để cho lịch sự. Không có nó, mô hình đọc một kết quả `grep` dừng lại ở dòng 400 và sẽ vội vã kết luận rằng không còn kết quả nào khớp nữa. Việc cắt ngắn mà mô hình không nhìn thấy còn tồi tệ hơn việc cắt ngắn mà nó nhận biết được, bởi vì nó biến một bài toán ngân sách thành một bài toán sai lệch tính đúng đắn.

## Đòn bẩy thứ hai: Tràn ra ngoài (Spill), đừng cắt cụt

Cắt ngắn sẽ vứt bỏ phần đuôi. Nhưng thông thường phần đuôi lại là nơi chứa câu trả lời.

Kỹ thuật tràn (spill) sẽ ghi toàn bộ kết quả đầy đủ vào một nơi lưu trữ bền vững và chỉ đặt một *con trỏ (handle)* vào cuộc hội thoại:

```typescript
registry.addPostHook(async (tool, result, ctx) => {
  if (result.length <= MAX_RESULT_BYTES) return result;

  const ref = await spillStore.write(result);      // định danh theo nội dung (content-addressed)
  const lines = result.split('\n');

  return [
    `[Kết quả lớn: ${result.length} byte, ${lines.length} dòng — được lưu tại ${ref}]`,
    `40 dòng đầu tiên:`,
    lines.slice(0, 40).join('\n'),
    ``,
    `Sử dụng read_spill({ ref: "${ref}", offset, limit }) để đọc thêm.`,
  ].join('\n');
});
```

Đi kèm với đó là một công cụ giúp mô hình đọc ngược lại dữ liệu. Giờ đây không có gì bị mất — dữ liệu được chuyển từ ngữ cảnh đắt đỏ sang một nơi mà mô hình có thể chủ động phân trang đọc khi cần. Một lệnh `grep` 200KB chỉ tiêu tốn vài trăm token trong ngữ cảnh nhưng vẫn hoàn toàn sẵn sàng để tra cứu.

Đây là mẫu hình (pattern) cần tìm đến bất cứ khi nào kết quả mang tính chất *dung lượng lớn nhưng có cấu trúc*: kết quả tìm kiếm, danh sách file, file log, kết quả chạy test. Mô hình hiếm khi cần đọc tất cả; nó chỉ cần biết dữ liệu đó tồn tại và có khả năng tra cứu sâu hơn.

## Đòn bẩy thứ ba: Cắt tỉa (Prune) các kết quả đã cũ

Một số kết quả từng rất hữu ích tại một thời điểm nhưng giờ đây là gánh nặng vô ích. Tình huống kinh điển: agent đọc một file, sửa file đó, rồi đọc lại lần nữa. Lần đọc đầu tiên tiêu tốn 3.000 token chỉ để mô tả một phiên bản file hiện không còn tồn tại nữa.

Cắt tỉa (pruning) sẽ thay thế nội dung của các kết quả đã bị thay thế (superseded) bằng một dấu hiệu đánh dấu ngay tại chỗ:

```typescript
function pruneSupersededReads(events: SessionEvent[]): SessionEvent[] {
  const latestReadOf = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'tool/call' && e.name === 'read') {
      latestReadOf.set((e.input as { path: string }).path, e.seq);
    }
  }
  // ...thay thế nội dung của mọi lần đọc trước đó đối với cùng file bằng một dấu hiệu đánh dấu
}
```

Hai quy tắc giữ cho cơ chế này luôn trung thực:

**Chỉ cắt tỉa hình chiếu (projection), không bao giờ cắt tỉa log.** Phiên bản bị cắt tỉa là thứ mà hàm `deriveMessages` sinh ra cho mô hình đọc. File log vẫn lưu giữ toàn bộ nguyên vẹn — đó là [toàn bộ ý nghĩa của Phần 8](/vi/blog/building-agents/the-session-log/). Nếu việc cắt tỉa chỉnh sửa trực tiếp vào file log, bản ghi lịch sử của bạn sẽ không còn khớp với những gì đã thực sự xảy ra.

**Luôn để lại một dấu hiệu đánh dấu.** Dòng chữ `[lần đọc trước của src/a.ts — đã bị thay thế]` là một sự trung thực. Việc âm thầm xóa bỏ sẽ khiến mô hình tin rằng nó chưa từng đọc file đó bao giờ, dẫn đến việc nó lại đọc lại, và bạn vừa tự tạo ra một vòng lặp luẩn quẩn.

## Đòn bẩy thứ tư: Tóm tắt (Summarise) sau cùng

Khi ba đòn bẩy đầu tiên không còn đủ sức gánh vác, bạn tiến hành nén. Đây là đòn bẩy duy nhất phá hủy thông tin, vì vậy nó phải đứng cuối cùng và cần sự cẩn trọng cao nhất.

Ngưỡng kích hoạt quan trọng hơn nhiều so với kỹ thuật tóm tắt:

```typescript
const TRIGGER_RATIO = 0.7;    // TUYỆT ĐỐI KHÔNG ĐỂ 0.95

async function maybeCompact(log: SessionLog, model: ModelInfo) {
  const used = await countTokens(deriveMessages(log.read()));
  if (used < model.contextWindow * TRIGGER_RATIO) return;
  await compact(log);
}
```

Tại sao lại là 70%: **bản thân việc tóm tắt là một yêu cầu gửi đến mô hình, và nó cần không gian trống để thở.** Nó bắt buộc phải đọc phần lịch sử cần tóm tắt và sinh ra văn bản tóm tắt. Nếu bạn kích hoạt ở ngưỡng 95%, thao tác giải cứu bạn sẽ không thể nhét vừa vào khoảng trống ít ỏi còn lại. Đây là cách phổ biến nhất khiến việc thu gọn ngữ cảnh thất bại trong thực tế — không phải do bản tóm tắt tồi, mà là không thể tạo ra bản tóm tắt nào cả, vì nó bị kích hoạt từ bên trong tình trạng khẩn cấp.

Những gì sống sót qua quá trình thu gọn là một quyết định thiết kế kiến trúc, không chỉ là lời prompt. Theo thứ tự tầm quan trọng: nhiệm vụ ban đầu, các quyết định đã đưa ra và lý do, các đường dẫn file đã tác động, các câu hỏi chưa được giải quyết, và vài turn cuối cùng nguyên văn. Những gì cần loại bỏ: đầu ra trung gian của công cụ, các lần đọc file cũ, quá trình khám phá đi vào ngõ cụt.

Và quy tắc ranh giới: **chỉ thu gọn một vùng cân bằng.** Một bản tóm tắt không được phép nuốt chửng một lệnh gọi công cụ mà bỏ lại kết quả của nó, hoặc băng qua một ranh giới turn đang mở; điều đó sẽ tạo ra một lịch sử mà adapter không thể phát lại một cách an toàn.

## Phục hồi sau khi bị tràn ngữ cảnh (Overflow)

Dù đã áp dụng cả bốn đòn bẩy, bạn vẫn có thể đụng trần, bởi vì một kết quả công cụ khổng lồ đơn lẻ có thể tự thân nó vượt quá toàn bộ cửa sổ ngữ cảnh.

Hãy xử lý nó như một nhánh phục hồi (recovery path), chứ không phải một lỗi sập chương trình:

```typescript
const finish = await llm.request(req, signal);

if (finish.kind === 'error' && finish.error.code === 'context_overflow') {
  const freed = await emergencyPrune(log);      // quyết liệt: xóa bỏ toàn bộ thân kết quả công cụ
  if (!freed) return finish;                    // không còn gì để giải phóng — thất bại thực sự
  return llm.request({ ...req, messages: deriveMessages(log.read()) }, signal);
}
```

Chỉ thử lại **khi việc cắt tỉa thực sự giải phóng được token.** Nếu không kiểm tra điều này, việc tràn ngữ cảnh do một tin nhắn khổng lồ duy nhất gây ra sẽ biến thành một vòng lặp vô tận của các yêu cầu giống hệt nhau cùng thất bại. Điều kiện không phải là "chúng ta có thử cắt tỉa hay không" mà là "số lượng token có thực sự giảm xuống hay không".

## Đo đếm định lượng (Metering)

Bạn không thể quản lý một ngân sách mà bạn không đo lường. Hãy ghi log trên từng turn:

```typescript
interface TurnBudget {
  turnId: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolResultTokens: number;   // con số thực sự báo trước rắc rối
  windowUsedRatio: number;
}
```

`toolResultTokens` là chỉ số báo trước hàng đầu (leading indicator). Khi tỷ trọng của nó trong tổng input bắt đầu tăng vọt, bạn sắp sửa phải đối mặt với việc thu gọn ngữ cảnh dù cho tỷ lệ tổng thể trông vẫn có vẻ an toàn — và nguyên nhân thường là một công cụ đáng lẽ phải dùng cơ chế spill nhưng lại không làm vậy.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness phân chia bài toán này thành ba nhóm năng lực — `compaction`, `spill`, và `token-meter` — mỗi nhóm được triển khai bởi một số package nhỏ gọn. Chi tiết tích hợp mới là phần đáng chú ý.

Compaction hook vào hai sự kiện: `agent/pre-step`, để kiểm tra áp lực ngữ cảnh *trước khi* yêu cầu được dựng, và `agent/request-error`, để đón bắt lỗi tràn ngữ cảnh chuẩn tắc mà nó chưa dự đoán được. Luồng thứ nhất là con đường có kế hoạch, luồng thứ hai là con đường phục hồi khẩn cấp, và chúng được tách biệt thành hai đoạn mã riêng biệt có chủ đích.

Nhánh phục hồi có một quy tắc rất đáng học hỏi nguyên văn: nó chỉ mở một turn thử lại mới **khi việc cắt tỉa hoặc tóm tắt thực sự nâng cấp thế hệ thay thế.** Nếu không, lỗi ban đầu sẽ được giữ nguyên. Đó chính là khâu kiểm tra "liệu nó có thực sự giải phóng được gì không", được hiện thực hóa thành cấu trúc vững chắc.

Và spill là một ranh giới có provider lưu trữ riêng biệt, không bị gắn cứng vào một thư mục tạm thời trên máy cục bộ — vì vậy cùng một chính sách đó vẫn hoạt động hoàn hảo khi [thế giới thực thi](/vi/blog/building-agents/the-execution-world/) chuyển sang một sandbox từ xa.

## Cái bẫy thường gặp

Cái bẫy là chỉ tiến hành tóm tắt khi cửa sổ ngữ cảnh đã đầy ứ.

Nghe có vẻ rất có trách nhiệm — đừng nén cho đến khi thực sự bắt buộc, hãy giữ độ chi tiết trung thực càng lâu càng tốt. Nhưng nó lại thất bại chính xác vào lúc quan trọng nhất, bởi vì việc thu gọn ngữ cảnh bản thân nó là một yêu cầu gửi đến mô hình và vào thời điểm đó không còn bất kỳ khoảng trống nào cho một yêu cầu như vậy nữa. Agent sẽ rơi vào trạng thái bế tắc nơi thao tác duy nhất có thể giải cứu nó lại chính là thao tác không thể nào nhét vừa.

Một cái bẫy liên quan khác là coi việc tóm tắt là toàn bộ giải pháp. Nếu một lệnh `grep` duy nhất có thể nuốt trọn 40% cửa sổ ngữ cảnh của bạn, không có chiến lược tóm tắt nào có thể cứu vãn nổi — bạn đang gặp vấn đề về kết quả công cụ đội lốt một bài toán quản lý ngữ cảnh. Hãy giới hạn (cap) và cho tràn ra ngoài (spill) trước; rồi mới tóm tắt những gì còn lại.

## Tiếp theo

**[Phần 11 — Kỹ năng (Skills)](/vi/blog/building-agents/skills-knowledge-on-demand/)**. Agent của bạn cần hiểu quy trình phát hành phần mềm của công ty. Nhét nó vào system prompt và mọi phiên làm việc đều phải trả tiền cho nó, kể cả phiên chỉ sửa mỗi file CSS.
