---
title: 'Hồi tưởng xuyên phiên (Cross-session Recall)'
description: 'Bạn đã sửa lỗi này vào tuần trước — bằng cách nào? Cuộc hội thoại đó đã đóng, đã bị thu gọn và nằm ở một phiên khác. File log có câu trả lời nhưng không gì có thể chạm tới.'
pubDate: 2026-09-17
tags: ['ai-agents', 'architecture', 'persistence']
translationKey: 'agents-12-recall'
sidebarTitle: '12 · Hồi tưởng (Recall)'
order: 12
---

*"Thứ Ba tuần trước bạn vừa sửa chính xác lỗi này. Lúc đó bạn đã làm những gì?"*

Mọi thứ cần thiết để trả lời câu hỏi đó đều nằm sẵn trên ổ đĩa. [Phần 8](/vi/blog/building-agents/the-session-log/) đã đảm bảo điều đó — mọi tin nhắn, mọi lệnh gọi công cụ, mọi kết quả trả về, đều nằm trong một append-only log bền vững. Nhưng agent lại không thể chạm tới dù chỉ một byte dữ liệu trong đó, bởi vì thứ duy nhất nó có thể nhìn thấy chỉ là cuộc trò chuyện mà nó hiện đang tham gia.

Lưu ý rằng đây không phải là [bài toán ngân sách ngữ cảnh](/vi/blog/building-agents/the-context-budget/). Bài toán đó là về việc cửa sổ ngữ cảnh bị tràn ngập *ngay lúc này*. Còn bài toán ở đây là về việc quá khứ hoàn toàn *không thể tiếp cận được*. Chúng kéo theo hai hướng trái ngược nhau, và đó chính là lý do tại sao chúng bắt buộc phải được tách bạch rõ ràng.

<figure class="dg">
  <img src="/diagrams/part12-cross-session-recall.svg" alt="Quá trình thu gọn compaction thu nhỏ ngữ cảnh hoạt động trong khi kho lưu trữ bền vững giữ lại toàn bộ; việc truy xuất bắt buộc phải đọc từ kho lưu trữ, không bao giờ đọc từ hình chiếu." loading="lazy" />
  <figcaption><strong>Compaction phá hủy ngữ cảnh hoạt động. Nhưng nó tuyệt đối không được phá hủy bản ghi lịch sử.</strong> Hồi tưởng đọc từ log — luôn luôn là từ log, không bao giờ từ hình chiếu projection.</figcaption>
</figure>

## Đường ranh giới

> Quá trình thu gọn (Compaction) phá hủy **ngữ cảnh hoạt động (active context)**. Nhưng nó tuyệt đối không được phép phá hủy **bản ghi lịch sử (record)**. Hồi tưởng đọc từ kho ngữ liệu bền vững, và câu trả lời của nó không phụ thuộc vào việc phiên làm việc hiện tại đã bị thu gọn đến mức độ nào.

Nếu việc truy xuất lại đọc từ ngữ cảnh hoạt động, nó sẽ suy thoái chất lượng chính xác vào lúc nó được cần đến nhất. Nó bắt buộc phải đọc trực tiếp từ log.

## Kho ngữ liệu ưu tiên phiên đang hoạt động (Live-preferred)

Đây là quyết định thiết kế đầu tiên, và là quyết định mà nhiều người hay bỏ qua nhất.

Các phiên làm việc tồn tại ở hai trạng thái: **đang hoạt động (live)** (nằm trong RAM, đang được ghi dữ liệu ngay lúc này) và **nguội (cold)** (nằm trên đĩa, không có ai truy cập). Hãy truy vấn cả hai, và ưu tiên bản sao live ở nơi nó tồn tại:

```typescript
async function corpus(): Promise<SessionHandle[]> {
  const live = sessions.all();                    // registry trong bộ nhớ RAM
  const stored = await persistence.list();        // nằm trên ổ đĩa
  const seen = new Set(live.map((s) => s.id));
  return [...live, ...stored.filter((s) => !seen.has(s.id))];
}
```

Nhẹ nhàng và chính xác: bản sao live không bao giờ bị cũ, và một phiên làm việc vừa được ghi cách đây 5 giây có thể tìm thấy được ngay trước khi dữ liệu kịp flush xuống đĩa. Nếu bạn chỉ truy vấn ổ đĩa, một người dùng hỏi về một phiên chạy song song sẽ nhận về kết quả "không tìm thấy" cho một cuộc trò chuyện đang diễn ra ngay trước mắt họ.

## Bốn câu hỏi riêng biệt, không phải một

"Tìm kiếm (Search)" là một thao tác nguyên thủy tồi vì nó gộp chung bốn nhu cầu hoàn toàn khác nhau. Hãy cung cấp chúng một cách tách bạch:

**Đọc chính xác (Exact read)** — *"hãy cho tôi xem turn 12 của phiên X."* Không cần tìm kiếm, không cần xếp hạng điểm số. Được giới hạn bởi một khoảng phạm vi (range), bởi vì một phiên làm việc có thể cực kỳ đồ sộ.

**Danh sách có bộ lọc (Filtered list)** — *"các phiên trong workspace này, trong 7 ngày qua, có chạm vào file `auth.ts`."* Đọc metadata, không đọc nội dung. Nhanh, và thường là bước đi đúng đắn đầu tiên.

**Lần theo huyết thống (Lineage trace)** — *"phiên này được fork từ đâu, và những phiên nào đã fork từ nó?"* Cấu trúc thuần túy, lấy từ header `parentSession`. Trả lời câu hỏi "trạng thái này bắt nguồn từ đâu", vốn là câu hỏi sống còn trong một sự cố.

**Tìm kiếm toàn văn (Full-text search)** — *"phiên nào có nhắc tới mã lỗi `ECONNRESET`?"* Đây là phần tốn kém nhất. Cần có một chỉ mục index.

```typescript
interface SessionQuery {
  read(id: SessionId, range?: { from: number; to: number }): Promise<SessionEvent[]>;
  list(filter: { workspace?: string; since?: Date; touchedPath?: string }): Promise<SessionMeta[]>;
  trace(id: SessionId): Promise<{ ancestors: SessionId[]; descendants: SessionId[] }>;
  search(q: string, opts?: { limit?: number }): Promise<SearchHit[]>;
}
```

Hầu hết các câu hỏi thực tế đều được giải quyết chỉ bằng `list` + `read`. Hãy xây dựng tính năng search sau cùng; nó là phần duy nhất cần bảo trì chỉ mục index và là thứ người dùng ít đụng tới nhất một khi ba tính năng đầu tiên đã hiện diện.

## Tìm kiếm là cơ chế Opt-in

Một bộ chỉ mục index tiêu tốn dung lượng đĩa, gây thêm độ trễ ghi trên mỗi lần ghi thêm sự kiện, và cần một bước build chỉ mục. Rất nhiều môi trường triển khai không hề muốn điều này — nhưng họ vẫn xứng đáng có được khả năng đọc chính xác, liệt kê danh sách và truy vết huyết thống.

Vì vậy hãy biến nó thành một chính sách (policy), chứ không phải một cờ tính năng làm tắt ngấm toàn bộ dịch vụ:

```typescript
type IndexPolicy = 'never' | 'first-search' | 'startup';
```

Với `never`, dịch vụ vẫn được gắn kết bình thường, các hàm `read`/`list`/`trace` hoạt động trơn tru, và `search` sẽ trả về một lỗi cụ thể, trung thực — `SEARCH_DISABLED`, chứ không phải trả về một mảng kết quả rỗng. Một tập kết quả rỗng là một lời nói dối: nó bảo rằng "không có gì khớp" trong khi sự thật là "không có ai tìm kiếm cả".

`first-search` là giá trị mặc định lý tưởng. Không tốn bất kỳ chi phí nào cho đến khi có ai đó thực sự tìm kiếm, lúc đó mới build một lần và giữ ấm bộ nhớ cache.

## Trao năng lực này cho mô hình

Ba công cụ, tương ứng với các câu hỏi ở trên:

```typescript
{
  name: 'search_history',
  description:
    'Tìm kiếm các phiên làm việc trong quá khứ của chính bạn theo nội dung. Sử dụng khi người dùng nhắc tới công việc trước đó ' +
    '("lần trước", "chúng ta từng sửa lỗi này rồi") hoặc khi bạn nghi ngờ vấn đề này đã được giải quyết từ trước. ' +
    'Trả về các phiên khớp kèm trích đoạn snippet; dùng read_history để đọc chi tiết toàn bộ.',
  inputSchema: { /* query, limit */ },
}
```

Có hai chi tiết trong phần mô tả đó đang làm công việc thực tế, và cả hai đều là bài học từ [Phần 11](/vi/blog/building-agents/skills-knowledge-on-demand/):

*"các phiên làm việc trong quá khứ của chính bạn"* — mô hình cần hiểu rõ đây là bộ nhớ ký ức của chính nó, không phải là mạng internet. Nếu không có câu này, bạn sẽ nhận lại những lệnh tìm kiếm Google cho các chuỗi mã lỗi nội bộ của dự án.

*Các cụm từ kích hoạt.* "Lần trước", "chúng ta từng sửa lỗi này rồi". Khả năng truy xuất mà không bao giờ được kích hoạt thì cũng tương đương với việc bạn chưa từng xây dựng nó.

Và các kết quả trả về bắt buộc phải **có giới hạn và kèm theo tham chiếu**, không bao giờ đổ ào toàn bộ dữ liệu ra:

```typescript
async execute({ query, limit = 5 }) {
  const hits = await sessionQuery.search(query, { limit });
  if (hits.length === 0) return `Không có phiên làm việc nào khớp với "${query}".`;
  return hits.map((h) =>
    `phiên ${h.sessionId} · ${h.title} · ${fmt(h.at)}\n` +
    `  …${h.snippet}…\n` +
    `  read_history({ session: "${h.sessionId}", from: ${h.seq - 5}, to: ${h.seq + 15} })`
  ).join('\n\n');
}
```

Các đoạn trích snippet kèm một lệnh gọi tiếp theo — lại là [mẫu hình tràn dữ liệu (spill pattern)](/vi/blog/building-agents/the-context-budget/). Một lệnh tìm kiếm trả về nguyên vẹn 5 phiên làm việc đầy đủ sẽ nuốt chửng toàn bộ cửa sổ ngữ cảnh của bạn chỉ để lưu câu trả lời.

## Quyền riêng tư là câu hỏi bắt buộc

Hồi tưởng xuyên phiên đồng nghĩa với việc phiên A có thể đọc dữ liệu của phiên B. Hãy tuyên bố rõ quy tắc trước khi bạn phát hành, bởi vì mặc định sẽ là bất kỳ điều gì mã nguồn của bạn tình cờ thực thi:

- Cùng người dùng, cùng workspace — thường là an toàn và hợp lý.
- Cùng người dùng, khác workspace — thường là không nên. Dữ liệu công việc của khách hàng này không được phép rò rỉ sang phiên làm việc của khách hàng khác.
- Khác người dùng — tuyệt đối không bao giờ, trừ khi có sự cấp quyền rõ ràng và được kiểm toán nghiêm ngặt.

Phạm vi phân quyền này thuộc về tầng truy vấn (query layer), chứ không nằm ở lời prompt của công cụ. Một mô hình được dặn dò bằng lời là không được tìm kiếm workspace khác sẽ chỉ tuân thủ ở mức tương đối; nhưng một truy vấn về mặt cấu trúc không thể nhìn thấy các workspace đó thì sẽ luôn luôn tuân thủ 100%.

## Đây không phải là RAG

Chúng trông có vẻ giống nhau — cả hai đều truy xuất văn bản và đưa vào ngữ cảnh — nhưng đánh đồng chúng sẽ tạo ra một hệ thống không làm tốt nổi việc nào.

| Đặc điểm | Hồi tưởng phiên (Session recall) | RAG (Retrieval-Augmented Generation) |
|---|---|---|
| Ngữ liệu (Corpus) | Lịch sử của chính bản thân agent | Tài liệu do con người chọn lọc, biên soạn |
| Ai viết ra | Chính agent, như một tác dụng phụ | Một pipeline thu nạp dữ liệu (ingestion) |
| Tốc độ tăng trưởng | Tăng sau mỗi turn, mãi mãi | Tăng khi có người xuất bản tài liệu mới |
| Câu hỏi | "Tôi đã từng làm gì?" | "Tài liệu hướng dẫn nói gì?" |
| Mức độ tin cậy | Bên thứ nhất, đã nằm trong log | Nội dung bên ngoài, [không tin cậy](/vi/blog/building-agents/what-it-reads-is-not-an-order/) |

Hồi tưởng phiên làm việc là bộ nhớ (memory). Còn RAG là một công cụ tra cứu — chỉ là một mục nữa trong [registry công cụ](/vi/blog/building-agents/tools-registry-schema-pipeline/), với một kho lưu trữ vector embedding nằm phía sau. Hãy xây dựng chúng tách biệt nhau. Vòng đời, mô hình tin cậy và các kịch bản lỗi của chúng hoàn toàn không có điểm chung nào.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness có một nhóm `session-query` mang chính xác cấu trúc này: một dịch vụ hợp nhất duy nhất chạy trên cả các phiên trực tiếp lẫn phiên bền vững, hỗ trợ đọc chính xác, danh sách có lọc, truy vết quan hệ huyết thống, lọc ngữ nghĩa, và tìm kiếm toàn văn SQLite ẩn sau một chính sách kiểm soát.

Hai chi tiết rất đáng học hỏi:

**Thành phần mặc định gắn kết với `openAt: 'never'`.** Dịch vụ luôn hiện diện; nhưng chỉ mục không bị mở tự động. Đọc chính xác, tiêu đề, và phả hệ đều hoạt động bình thường — những thứ đó là cần thiết cho việc xuất phiên làm việc và kế thừa khi fork nhánh — trong khi tìm kiếm sẽ trả về lỗi đã tắt cụ thể và SQLite hoàn toàn không bị đụng tới. Các bản triển khai muốn tìm kiếm nội dung sẽ ghi đè chính sách này trong một tầng patch.

**Các công cụ hướng về mô hình mang tên `session_event_read`, `session_event_search`, `session_event_trace`.** Được đặt tên dựa theo đúng bốn câu hỏi cốt lõi, chứ không bị gộp vào một hàm `search` duy nhất rồi cố gắng đoán mò xem bạn thực sự muốn gì.

## Cái bẫy thường gặp

Cái bẫy là khiến cho tính năng hồi tưởng bị phụ thuộc vào trạng thái của phiên hiện tại.

Nó diễn ra rất tự nhiên: bạn đã có sẵn hàm `deriveMessages`, vì vậy tính năng search liền với tay lấy lịch sử đã được chiếu đó bởi vì nó nằm ngay trước mắt. Thế rồi quá trình thu gọn compaction kích hoạt, lịch sử bị teo nhỏ lại, và search âm thầm ngừng tìm thấy những thứ vốn vẫn còn nguyên vẹn trên đĩa.

Triệu chứng này cực kỳ tàn nhẫn khi gỡ lỗi, bởi vì nó *đúng từ đầu và chỉ sai về sau*. Nó chạy hoàn hảo trong mọi bài test, chạy mượt mà trong các phiên ngắn, và chỉ lăn ra hỏng trong những cuộc trò chuyện dài — chính là nơi mà tính năng hồi tưởng là toàn bộ giá trị của hệ thống.

Hồi tưởng phải đọc từ log. Luôn luôn là từ log — tuyệt đối không bao giờ đọc từ hình chiếu projection.

## Tiếp theo

**[Phần 13 — Plugin và các điểm kết nối năng lực (Capability Seams)](/vi/blog/building-agents/plugins-and-capability-seams/)**. Ai đó yêu cầu các công cụ phải chạy trong một sandbox từ xa thay vì trên cỗ máy này. Hãy đếm xem bạn phải sửa bao nhiêu file. Câu trả lời sẽ cho bạn biết liệu bạn có thực sự sở hữu một kiến trúc hay không.
