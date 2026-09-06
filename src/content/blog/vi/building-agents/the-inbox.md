---
title: 'Hộp thư đến: Hai ranh giới, một hàng đợi bền vững'
description: 'Lời nhắn tiếp theo, tín hiệu điều hướng tức thời và ngữ cảnh thụ động khác nhau ở thời điểm chúng được phép đi vào vòng lặp và liệu chúng có đánh thức agent hay không. Hộp thư đến (inbox) làm rõ ràng các lựa chọn này.'
pubDate: 2026-09-09
tags: ['ai-agents', 'architecture', 'concurrency']
translationKey: 'agents-04-inbox'
sidebarTitle: '4 · Hộp thư (The Inbox)'
order: 4
---

Agent đang đi được nửa đường theo một hướng tiếp cận sai lầm. Bạn gõ: “Dừng sửa module đó lại; hãy kiểm tra thư mục `config/` trước.”

Một hàm `run(task)` chạy một lần (one-shot) không có chỗ nào để đặt thông điệp điều chỉnh đó vào. Hủy tiến trình sẽ vứt bỏ công sức đã làm; chờ đợi sẽ làm cho thông điệp điều chỉnh trở nên lỗi thời. Runtime cần một ranh giới chuyển giao giữa “đầu vào đã được chấp nhận” và “đầu vào đi vào một yêu cầu mô hình.”

DeepSeek Harness gọi ranh giới đó là **hộp thư đến (inbox)**.

## Một inbox, hai danh sách bền vững

Cấu trúc thực tế chính xác hơn nhiều so với một hàng đợi FIFO đơn lẻ. Mỗi agent sở hữu một `Inbox` với hai danh sách có thứ tự:

- **`next-turn`** chứa các prompt tiếp theo thông thường. Tại ranh giới của turn, driver claim tối đa một tin nhắn.
- **`next-step`** chứa các tín hiệu điều hướng (steering) và ngữ cảnh được chèn vào. Tại mọi ranh giới của step, driver claim toàn bộ lô tin nhắn đang chờ.

Khi bắt đầu một turn, `claim('next-turn')` trả về tất cả các tin nhắn `next-step` đang chờ trước, sau đó trả về một tin nhắn `next-turn`. Ở giữa các step, `claim('next-step')` chỉ rút cạn dữ liệu đầu vào của `next-step`.

<figure class="dg">
  <img src="/diagrams/part04-inbox-funnel-vi.svg" alt="Các tin nhắn tiếp theo đi vào danh sách next-turn; tín hiệu điều hướng và ngữ cảnh được chèn đi vào danh sách next-step; một thao tác claim sẽ rút cạn lô tin nhắn đủ điều kiện." loading="lazy" />
  <figcaption><strong>Một bề mặt biến đổi, hai ranh giới ngữ nghĩa.</strong> Các danh sách riêng biệt ngăn việc cập nhật ngữ cảnh thụ động vô tình biến thành một user turn ngoài ý muốn.</figcaption>
</figure>

Mọi biến đổi đều được ghi thêm dưới dạng sự kiện `agent/inbox/spliced` vào log trước khi hình chiếu trong bộ nhớ (in-memory projection) thay đổi. Nhờ đó, các thao tác chèn (insert), thay thế (replace), gỡ bỏ (remove), xóa sạch (clear) và nhận việc (claim) đều sống sót qua các lần khởi động lại và có thể phát lại được. Inbox đang hoạt động thực chất là một hình chiếu từ các sự kiện ghép (splice) bền vững, chứ không phải là một hàng đợi tách rời nằm cạnh log.

## Ba thao tác chuyển giao

Các thao tác công khai được thiết kế tinh gọn có chủ đích:

| Thao tác | Đích đến | Có đánh thức agent đang nhàn rỗi (idle)? | Ý nghĩa |
|---|---|:---:|---|
| `followup(message)` | `next-turn` | Có | Bắt đầu một turn bình thường tiếp theo. |
| `steer(message)` | `next-step` | Có | Chuyển hướng step gần nhất có thể; nếu đang idle, mở một turn mới. |
| `inject(message)` | `next-step` | Không | Bổ sung ngữ cảnh hướng về mô hình mà tự thân nó không tạo ra công việc mới. |

Hàng cuối cùng rất dễ bị hiểu sai. `inject` **không** nhắm vào `next-turn`. Nó nhắm vào step tiếp theo, nhưng vẫn giữ trạng thái thụ động. Nếu agent đang chạy, nó có thể được claim tại ranh giới step sau đó. Nếu agent đang nhàn rỗi (idle), nó tiếp tục nằm chờ cho đến khi một thao tác `followup` hoặc `steer` đánh thức driver.

```typescript
followup(message) { send(message, 'next-turn', true); }
steer(message)    { send(message, 'next-step', true); }
inject(message)   { send(message, 'next-step', false); }
```

Đích đến và cờ đánh thức trả lời hai câu hỏi độc lập:

1. **Khi nào nội dung này được phép tiếp nhận?**
2. **Liệu tự thân nội dung này có được phép tạo ra hoạt động hay không?**

Việc đánh đồng hai điều này là nguyên nhân khiến một trình theo dõi tệp (file watcher) bất ngờ kích hoạt các lệnh gọi mô hình ngoài ý muốn, hoặc khiến một lời điều chỉnh của người dùng phải chờ đến tận cuộc hội thoại tiếp theo.

## Điều hướng là sự phối hợp nhịp nhàng (cooperative)

Tín hiệu điều hướng (steering) không chắp vá văn bản vào một yêu cầu đã đang được truyền trên đường truyền mạng (on the wire). Nó đi vào tại ranh giới tiền-step (pre-step) gần nhất tiếp theo:

<figure class="dg">
  <img src="/diagrams/part04-steering-sequence-vi.svg" alt="Người dùng gửi tín hiệu điều hướng trong khi các công cụ đang chạy; công việc hiện tại chạm đến ranh giới của nó, sau đó pre-step tiếp theo sẽ claim thông điệp điều chỉnh." loading="lazy" />
  <figcaption><strong>Điều hướng làm thay đổi yêu cầu tiếp theo, chứ không phải yêu cầu đang bay trên đường truyền.</strong> Hủy bỏ là một thao tác riêng biệt khi công việc hiện tại bắt buộc phải dừng lại ngay lập tức.</figcaption>
</figure>

Sự phân biệt này giữ cho lịch sử tin nhắn luôn mạch lạc và nhất quán. Yêu cầu gửi đến mô hình và các kết quả công cụ của nó vẫn tạo thành một step hoàn chỉnh; thông điệp điều chỉnh trở thành một tin nhắn người dùng có nguồn gốc rõ ràng trong step kế tiếp. Nếu người dùng muốn cả hai: “dừng lại ngay bây giờ” và “hãy làm việc này thay thế”, bề mặt tương tác sẽ kết hợp việc hủy bỏ với việc giữ lại đầu vào trong inbox, thay vì giả vờ như tín hiệu điều hướng có thể du hành ngược thời gian.

## Cuộc đua chấp nhận đầu vào (acceptance race)

Có một khoảng thời gian nguy hiểm giữa thời điểm chấp nhận đầu vào đánh thức và thời điểm driver bất đồng bộ bắt đầu làm công việc hữu ích. Nếu trạng thái vẫn giữ nguyên là `idle` cho đến một microtask sau đó, một chủ thể quản lý vòng đời có thể quan sát thấy “idle”, giải phóng (dispose) agent, và làm mắc kẹt một prompt mà API đã xác nhận chấp nhận.

DeepSeek Harness đóng khoảng trống nguy hiểm đó một cách đồng bộ:

1. ghi thêm sự kiện chèn vào inbox;
2. giữ chỗ cho một driver mới ngay lập tức bằng cách đổi phase nội bộ sang `running`;
3. phát đi thông báo chuyển đổi trạng thái;
4. bắt đầu turn bất đồng bộ.

`whenIdle()` theo dõi promise của hoạt động hiện tại và kiểm tra lại xem công việc thay thế có được cài đặt trước khi hoạt động quan sát được kết thúc hay không. Một tín hiệu đánh thức đến sau quá trình bảo trì hoặc sau một hoạt động đã bị hủy bỏ sẽ được chốt lại (latched) và phát lại khi hoạt động đó hội tụ về trạng thái nhàn rỗi (idle).

Bất biến này mạnh mẽ hơn nhiều so với việc “kiểm tra hàng đợi hai lần”:

> Nếu một lượt chuyển giao có tính năng đánh thức được chấp nhận, quyền sở hữu hoạt động trong tương lai sẽ thay đổi một cách đồng bộ.

## Hủy bỏ và hộp thư đến

Mặc định, `cancel(cause)` sẽ hủy bỏ thao tác đang hoạt động và xóa sạch các công việc đang chờ trong inbox. Còn `cancel(cause, { keepInbox: true })` sẽ hủy bỏ hoạt động hiện tại nhưng bảo toàn các prompt và tín hiệu điều hướng đang xếp hàng cho một turn sau đó.

Một tin nhắn có tính năng đánh thức được gửi sau khi lệnh hủy bỏ đang hoạt động diễn ra sẽ được phân loại lại thành `next-turn`, bởi vì nó không thể tham gia vào một thao tác có tín hiệu đã bị hủy. Lệnh hủy bỏ để giải phóng tài nguyên (disposal) không phát lại tín hiệu đánh thức: quá trình dọn dẹp không được phép vô tình bắt đầu một model turn mới trong khi đang cố gắng đưa hệ thống về trạng thái tĩnh lặng hoàn toàn.

Những quy tắc này là lý do tại sao việc chuyển giao inbox thuộc về bên trong vòng đời của agent thay vì nằm trong một component UI. Giao diện dòng lệnh (Terminal), Web, SDK, webhook, và việc giải quyết kết quả của subagent đều cần cùng một thứ tự chuẩn mực này.

## Tiếp theo

**[Phần 5 — Tầng LLM](/vi/blog/building-agents/the-llm-layer/)**. Một vòng lặp cấp production không tiêu thụ trực tiếp SSE đặc thù của từng nhà cung cấp; nó cần một bộ từ vựng stream chuẩn hóa và ngữ nghĩa kết thúc chính xác.
