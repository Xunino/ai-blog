---
title: 'Nhật ký phiên là nguồn sự thật duy nhất'
description: 'Lịch sử tin nhắn gửi đến mô hình được chiếu từ một append-only log — chứ không phải được duy trì song song với nó. Đảo ngược điều này là sai lầm đắt giá nhất trong toàn bộ hệ thống.'
pubDate: 2026-09-13
tags: ['ai-agents', 'architecture', 'persistence']
translationKey: 'agents-08-session-log'
sidebarTitle: '8 · Session log'
order: 8
---

Khởi động lại tiến trình. Cuộc hội thoại biến mất hoàn toàn.

Đó là vấn đề hiển nhiên nhất, và cách khắc phục hiển nhiên nhất là ghi mảng `messages` ra một file rồi đọc lại khi cần. Bạn làm điều đó, xuất xưởng tính năng, và ba tuần sau bạn nhận được những yêu cầu bóc trần lý do tại sao cách sửa hiển nhiên đó lại hoàn toàn sai lầm:

- *"Hãy quay lại những gì bạn đã nói từ 5 turn trước và thử một hướng tiếp cận khác từ thời điểm đó."*
- *"Hãy cho tôi xem chính xác mô hình đã nhìn thấy những gì khi nó quyết định xóa file đó."*
- *"Agent quả quyết rằng nó đã chạy bộ kiểm thử test. Nó có thực sự chạy không?"*
- *"Hãy tóm tắt cuộc hội thoại này để nó vừa vặn với cửa sổ ngữ cảnh, nhưng vẫn phải giữ nguyên bản ghi lịch sử ban đầu."*

Không có câu hỏi nào trong số này có thể trả lời được từ một mảng tin nhắn `messages`. Không phải vì mảng đó nằm trong bộ nhớ RAM — mà vì mảng đó là **dữ liệu bị mất mát (lossy)**. Nó chỉ chứa những gì mô hình cần cho yêu cầu tiếp theo, vốn là một tập hợp con nhỏ hẹp của những gì thực sự đã diễn ra.

## Phép đảo ngược tư duy

> **Hiển thị cho mô hình ⟺ Đã được ghi log.** Bất cứ thứ gì đi vào một yêu cầu mô hình đều bắt buộc phải tái tạo lại được từ log. Lịch sử tin nhắn là một **hình chiếu (projection)** của log — chứ không phải là một bản sao thứ hai được duy trì song song bên cạnh nó.

Hãy đọc lại câu trên hai lần, bởi vì chiều hướng của mối quan hệ này là toàn bộ tinh hoa của bài viết. Hầu hết mọi người xây dựng theo hướng:

```text
messages[]  ──append──►  file log        (log là bản sao chép lại của lịch sử)
```

Nhưng thứ bạn thực sự cần là:

```text
log[]  ──deriveMessages()──►  messages    (lịch sử là một góc nhìn (view) của log)
```

Sự khác biệt lộ rõ ngay khoảnh khắc hai bên có thể mâu thuẫn nhau. Trong thiết kế thứ nhất, chúng *chắc chắn* sẽ mâu thuẫn nhau, và bạn sẽ phát hiện ra điều đó ngay giữa một sự cố khẩn cấp, khi bản log bạn đang đọc lại không khớp với những gì mô hình đã thực sự nhìn thấy.

## Sự kiện (Events), không phải tin nhắn

Đơn vị cơ bản của log là một **sự kiện (event)**, và các sự kiện ghi lại nhiều loại sự thật phong phú hơn tin nhắn rất nhiều:

```typescript
type SessionEvent =
  | { seq: number; at: number; kind: 'turn/start'; turnId: string }
  | { seq: number; at: number; kind: 'turn/end'; turnId: string; reason: StopReason }
  | { seq: number; at: number; kind: 'step/start'; stepId: string }
  | { seq: number; at: number; kind: 'user/message'; content: ContentBlock[]; source: MessageSource }
  | { seq: number; at: number; kind: 'assistant/chunk'; delta: unknown }
  | { seq: number; at: number; kind: 'assistant/message'; content: ContentBlock[]; usage: Usage }
  | { seq: number; at: number; kind: 'tool/call'; id: string; name: string; input: unknown }
  | { seq: number; at: number; kind: 'tool/result'; id: string; content: string; isError: boolean }
  | { seq: number; at: number; kind: 'request/header'; provider: string; model: string };
```

Ba đặc tính sau đây gánh vác toàn bộ thiết kế. **Chỉ ghi thêm (Append-only)** — các điều chỉnh được ghi nối tiếp vào đuôi, không bao giờ chỉnh sửa quá khứ, đó là điều làm cho việc phát lại (replay) có ý nghĩa. **Chỉ số `seq` tăng đơn điệu** — thứ tự không phụ thuộc vào timestamp đồng hồ, và lệnh "tách nhánh tại vị trí 47" trở thành một chỉ thị hoàn toàn chính xác. **Một số sự kiện hiển thị cho mô hình, hầu hết thì không** — đó là lý do tại sao log có thể chứa đựng nhiều thông tin hơn toàn bộ cuộc hội thoại.

Nơi lưu trữ có thể đơn giản là một file JSONL. Hoàn toàn nghiêm túc — mỗi dòng là một JSON object, được ghi nối tiếp vào file:

```typescript
class SessionLog {
  private events: SessionEvent[] = [];
  private seq = 0;

  append<K extends SessionEvent['kind']>(kind: K, payload: Omit<...>): SessionEvent {
    const event = { seq: this.seq++, at: Date.now(), kind, ...payload } as SessionEvent;
    this.events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    return event;
  }

  read(): readonly SessionEvent[] { return this.events; }
}
```

Cố gắng làm phức tạp hóa tầng lưu trữ ở giai đoạn này là quá sớm. Bản thiết kế nằm ở cấu trúc log; cơ chế lưu trữ chỉ là chi tiết vụn vặt mà bạn có thể nâng cấp sau này khi bộ đo hiệu năng (profiler) yêu cầu.

<figure class="dg">
  <img src="/diagrams/part08-session-log-projection.svg" alt="Log chỉ ghi thêm là nguồn sự thật duy nhất; lịch sử mô hình được chiếu từ nó, và các độc giả khác gấp cùng một luồng sự kiện vào trạng thái của riêng họ." loading="lazy" />
  <figcaption><strong>Lịch sử là một góc nhìn, không phải bản sao.</strong> Một nguồn sự thật duy nhất, nhiều độc giả — mỗi độc giả là một hàm fold thuần túy trên cùng một luồng sự kiện.</figcaption>
</figure>

## Phép chiếu (Projection)

Hàm `deriveMessages` duyệt qua các sự kiện và xây dựng đúng những gì API yêu cầu. Đó là nơi duy nhất biết quy tắc ánh xạ:

```typescript
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of projectCurrentSurface(events)) {
    const message = deriveEventMessage(event);
    if (message !== null) messages.push(message);
  }
  return messages;
}
```

Phép chiếu thực tế mang tính lũy tiến (incremental) và hiểu rõ việc thay thế bề mặt hiển thị, nhưng quy tắc cốt lõi rất ngắn gọn: `user/message`, `assistant/message`, và `tool/result` chiếu ra các tin nhắn chuẩn tắc của riêng chúng; còn các ranh giới turn, chunk stream, request header, thông tin usage, và các sự kiện chỉ-dành-cho-log khác thì không. Adapter DeepSeek sau đó sẽ bung từng kết quả công cụ chuẩn tắc thành tin nhắn độc lập `role: 'tool'` trên đường truyền mạng theo đúng yêu cầu của nhà cung cấp.

Thay đổi trong vòng lặp rất nhỏ nhưng mang tính triệt để:

```typescript
- const response = await client.chat.completions.create({ ...req, messages: state.messages });
+ const response = await ctx.llm.stream({ ...req, messages: session.deriveMessages() });
```

Không còn tồn tại `state.messages` nữa. Không còn bất kỳ chỗ nào cho một nguồn sự thật thứ hai nảy sinh.

## Tại sao phải lưu trữ các chunk stream?

Sự kiện `assistant/chunk` nằm trong danh sách sự kiện đó và nó hoàn toàn không hiển thị cho mô hình. Việc lưu trữ từng mảnh delta của luồng stream thoạt nhìn có vẻ là một sự lãng phí thuần túy — bạn vốn đã có một `assistant/message` hoàn chỉnh được lắp ráp xong rồi cơ mà?

Hãy giữ lại chúng. Chúng chính là thứ làm cho bản ghi lịch sử có thể **phát lại (replayable)** một cách sống động thay vì chỉ có thể đọc được bằng mắt. Một giao diện UI khi dựng lại phiên làm việc có thể mô phỏng lại từng nhịp gõ chữ của mô hình. Một phiên gỡ lỗi có thể thấy được mô hình ban đầu định viết một đằng nhưng sau đó đã đổi ý viết một nẻo. Và khi một luồng stream bị hủy giữa chừng, các chunk là bằng chứng duy nhất ghi lại phần tiền tố đã từng tồn tại — bởi vì tin nhắn lắp ráp hoàn chỉnh chưa bao giờ kịp hình thành.

Cái giá phải trả chỉ là dung lượng ổ cứng, thứ rẻ mạt nhất mà bạn sở hữu. Sự kiện `assistant/message` mang theo trường `sourceEventSeqs` liệt kê rõ ràng các chunk nào đã tạo nên nó, vì vậy mối liên kết là tường minh chứ không phải dựa vào suy đoán lân cận.

## Lợi ích nhận được ngay lập tức

**Khôi phục phiên (Resume).** Đọc file, dựng lại trạng thái, tiếp tục chạy. Chỉ vỏn vẹn ba dòng code.

**Tách nhánh (Fork) tại ranh giới turn.** Sao chép các sự kiện cho đến một `seq` nhất định, bắt đầu một phiên làm việc mới với tiền tố đó:

```typescript
function fork(source: SessionLog, atSeq: number, newId: string): SessionLog {
  const seed = source.read().filter((e) => e.seq <= atSeq);
  return SessionLog.create(newId, {
    seed,
    inheritedEventCount: seed.length,     // nơi lịch sử thừa kế kết thúc
    parentSession: source.id,
  });
}
```

Trường `inheritedEventCount` trông có vẻ như một việc ghi chép sổ sách phụ trợ, nhưng thực chất không phải vậy. Nó là ranh giới phân định giữa *các sự kiện mà phiên này thừa hưởng* và *các sự kiện do chính phiên này sinh ra*, và nhiều tính năng phía sau phụ thuộc sống còn vào khả năng phân biệt đó. Nếu bạn fold một trạng thái trên toàn bộ log, bạn sẽ đọc giá trị của phiên cha; nếu fold trên phần đuôi hậu tố, bạn sẽ nhận được trạng thái riêng của chính phiên này. Tính năng [Ủy quyền subagent](/vi/blog/building-agents/delegation-subagents/) có một lỗi bug cực kỳ nguy hiểm bắt nguồn chính từ sự nhầm lẫn này.

Chỉ fork tại ranh giới của một turn. Ở giữa một turn, các lệnh gọi công cụ còn đang chờ xử lý và các kết quả chưa được ghép cặp — bạn sẽ tự đẩy mình vào tình thế phân nhánh từ một trạng thái mà mô hình không bao giờ có thể tự nhiên đạt tới.

**Những câu trả lời trung thực về quá khứ.** "Nó có chạy bộ kiểm thử test không?" chỉ là một câu lệnh `grep` tìm kiếm các sự kiện `tool/call`. "Mô hình đã nhìn thấy những gì?" chính là `deriveMessages(events.filter(e => e.seq <= n))`.

**Các phép chiếu đa dạng (Projections).** Khi các sự kiện đã là chất nền cơ bản, mọi trạng thái phái sinh đều chỉ là một phép fold: tổng số token đã tiêu tốn, dàn ý các turn cho UI, tiêu đề phiên, chi phí trên từng turn. Mỗi thứ là một reducer nhỏ gọn chạy trên cùng một luồng sự kiện, được tính toán động thay vì phải duy trì thủ công. Và vì các phép fold là thuần túy (pure), chúng hoàn toàn có thể được cache lại với một mốc watermark và chỉ tính toán lại khi watermark dịch chuyển.

## Đặt phiên bản (Versioning) trước khi bạn cần đến nó

Log là dữ liệu bền vững, điều đó đồng nghĩa với việc định dạng của ngày hôm nay sẽ được đọc bởi mã nguồn của ngày mai:

```typescript
const SESSION_FORMAT_VERSION = 0;   // tiền phát hành: chưa cam kết tương thích
```

Hai quy tắc không tốn của bạn đồng nào ngay bây giờ nhưng sẽ cứu bạn khỏi một cuộc di chuyển dữ liệu (migration) đầy đau đớn sau này:

**Thêm một loại sự kiện mới không phải là nâng phiên bản format.** Mã nguồn cũ khi gặp một loại sự kiện lạ nên bỏ qua nó — miễn là sự kiện đó không hiển thị cho mô hình. Nhưng nếu nó *có* hiển thị cho mô hình, việc âm thầm bỏ qua đồng nghĩa với việc phát lại một cuộc hội thoại mà mô hình chưa từng trải qua, vì vậy những sự kiện đó bắt buộc phải bị từ chối chứ không được lờ đi. Hãy đánh dấu các sự kiện bằng một cờ `ignorable` và để giá trị mặc định là *từ chối*.

**Chỉ nâng phiên bản cho các thay đổi về mặt cấu trúc** — đổi tên trường `seq`, thay đổi cách lồng ghép nội dung. Việc bổ sung thêm các trường mới không phải là thay đổi cấu trúc.

## Tệp đính kèm cũng thuộc về nơi này

Người dùng dán một hình ảnh vào cuộc trò chuyện. Nó hiển thị cho mô hình, vì vậy bắt buộc phải được ghi log — nhưng một chuỗi base64 khổng lồ nằm trong một dòng JSONL sẽ khiến file log không thể đọc nổi bằng mắt và phình to vô tận.

Hãy lưu trữ các byte dữ liệu theo địa chỉ nội dung (content-addressed), và chỉ ghi tham chiếu vào log:

```typescript
{ kind: 'user/message', content: [{ type: 'image', attachmentId: 'sha256:9f2a…' }, …] }
```

Phép chiếu sẽ phân giải các id thành nội dung thực tế khi xây dựng yêu cầu gửi đến mô hình. File log vẫn là văn bản thuần túy, các byte dữ liệu tự động được loại bỏ trùng lặp miễn phí, và định lý "Hiển thị cho mô hình ⟺ Đã được ghi log" vẫn được giữ vững trọn vẹn — tham chiếu là hoàn toàn đủ để tái tạo lại chính xác những gì đã được gửi đi.

## Cái bẫy thường gặp

Cái bẫy là giữ lại mảng `messages` cũ "cho tiện".

Điều đó nghe rất hợp lý vào thời điểm đó. Bạn đang có một vòng lặp chạy tốt với `state.messages`; bạn thêm file log bên cạnh nó; bạn tự nhủ sẽ dọn dẹp mảng đó sau. Đó là một refactor mất có 5 phút.

Thế rồi một nhánh mã nào đó ghi thêm vào mảng nhưng quên ghi vào log. Hoặc ghi vào log nhưng quên ghi vào mảng. Lỗi bug không bao giờ lộ ra dưới dạng một cú sập chương trình — nó lộ ra dưới dạng một bản ghi lịch sử không khớp với những gì mô hình đã nhìn thấy, và bạn sẽ không nhận ra cho đến khi bạn phải đọc bản ghi đó để giải trình một sự cố nghiêm trọng, tại thời điểm đó chính cổ vật bạn dùng để giải thích chuyện gì đã xảy ra lại là thứ bị sai lệch.

Hãy xóa bỏ mảng đó ngay trong chính commit bổ sung thêm log. Chỉ có một nguồn sự thật duy nhất, nếu có hai nguồn, chắc chắn bạn sẽ gặp race condition.

## Tiếp theo

**[Phần 9 — Tiền tố của Prompt (The Prompt Prefix)](/vi/blog/building-agents/the-prompt-prefix/)**. Hóa đơn tiền điện toán tăng gấp ba và độ trễ tăng gấp đôi trong khi lưu lượng người dùng không hề đổi. Thủ phạm chỉ là một dòng duy nhất: một chuỗi timestamp ghi ngày giờ đặt ở ngay đầu system prompt.
