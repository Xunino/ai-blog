---
title: 'Turn và Step: Khi nào agent thực sự xong việc?'
description: 'Phản hồi từ mô hình, một step, và một turn của người dùng kết thúc ở những ranh giới khác nhau. Nhầm lẫn giữa chúng sẽ làm mất tín hiệu điều hướng, hỏng vết kiểm toán và giải phóng tài nguyên quá sớm.'
pubDate: 2026-09-07
tags: ['ai-agents', 'architecture']
translationKey: 'agents-02-turn-and-step'
sidebarTitle: '2 · Turn và Step'
order: 2
---

Vòng lặp trong [Phần 1](/vi/blog/building-agents/an-agent-is-a-while-loop/) dừng lại khi assistant không trả về lệnh gọi công cụ nào nữa. Đó là một sự thật về một phản hồi duy nhất của mô hình. Nó chưa phải là sự thật về toàn bộ đơn vị công việc bao quanh.

Sự phân biệt này trở nên vô cùng quan trọng ngay khi có dữ liệu đầu vào xuất hiện trong lúc agent đang chạy.

<figure class="dg">
  <img src="/diagrams/part02-race-condition-vi.svg" alt="Một phản hồi kết thúc trong khi tín hiệu điều hướng mới đang chờ; vòng lặp ngây thơ thoát ra trước khi kịp claim lấy nó." loading="lazy" />
  <figcaption><strong>Điểm dừng tự nhiên của mô hình chỉ là một ranh giới ứng viên.</strong> Runtime vẫn phải tính đến dữ liệu đầu vào đã được chấp nhận cho step tiếp theo.</figcaption>
</figure>

## Hai vòng đời (lifetimes)

DeepSeek Harness định danh hai đơn vị rõ rệt:

> Một **step** là một yêu cầu gửi đến mô hình cộng với các lệnh gọi công cụ được sinh ra từ yêu cầu đó.  
> Một **turn** gồm 0 hoặc nhiều step được mở ra xung quanh một đơn vị công việc tương tác đã được tiếp nhận.

Một phản hồi có gọi công cụ thường kết thúc step mà không tạo ra kết quả cuối cùng (terminal outcome) cho turn. Các kết quả công cụ được ghi thêm vào log, sau đó step tiếp theo sẽ gửi các kết quả quan sát đó ngược lại cho mô hình. Một phản hồi dạng văn bản thuần, một kết thúc do chạm trần token (max-token finish), một lệnh chặn từ chính sách, hoặc một kết quả công cụ mang tính kết luận có thể tạo ra một kết quả turn ứng viên (candidate turn outcome).

Trước khi commit kết quả đó, driver kiểm tra hàng đợi inbox của `next-step` và cung cấp cho các listener `agent/turn-stopping` một điểm kiểm tra (checkpoint) cuối cùng. Do đó, tín hiệu điều hướng (steering) hoặc ngữ cảnh được chèn vào đã được chấp nhận cho turn hiện tại có thể kích hoạt thêm một step nữa. Một lời nhắn tiếp theo thông thường được xếp hàng cho `next-turn` sẽ không bị gộp vào turn hiện tại; nó sẽ mở ra một ranh giới bền vững khác sau khi turn hiện tại đóng lại.

<figure class="dg">
  <img src="/diagrams/part02-turn-container-vi.svg" alt="Một turn chứa không hoặc nhiều step; đầu vào next-step có thể kéo dài turn, trong khi đầu vào next-turn sẽ mở ra turn tiếp theo." loading="lazy" />
  <figcaption><strong>Step hỏi: “yêu cầu này đã hoàn tất chưa?” Turn hỏi: “tương tác này có còn nợ một yêu cầu nào không?”</strong></figcaption>
</figure>

## Máy trạng thái trong thực tế

Khi lược bỏ bớt chi tiết về các quyết định điều khiển, luồng xử lý trong production trông như sau:

```typescript
async function runTurn() {
  append('turn/start');
  let target: 'next-turn' | 'next-step' = 'next-turn';
  let outcome: TurnOutcome | null = null;

  try {
    while (true) {
      // Khi bắt đầu turn: toàn bộ đầu vào next-step + một lời nhắn tiếp theo đang xếp hàng.
      // Giữa các step: chỉ lấy đầu vào next-step.
      const claimed = inbox.claim(target);
      const decision = await preStep(claimed);

      if (decision.kind === 'reject') {
        outcome = { kind: 'blocked' };
        break;
      }
      if (isFirstStep() && decision.messages.length === 0) {
        outcome = { kind: 'completed' }; // turn không có step nào (zero-step turn)
        break;
      }

      append('step/start');
      outcome = await runModelAndTools(decision); // null có nghĩa là còn nợ một yêu cầu nữa
      append('step/end');

      if (outcome && inbox.nextStep.length === 0) {
        await emitTurnStoppingCheckpoint();
      }
      if (outcome && inbox.nextStep.length === 0) break;
      target = 'next-step';
    }
  } finally {
    append('turn/end', outcome);
  }
}
```

Đoạn code này đã được tinh giản có chủ đích. Thứ tự quan trọng đến từ việc triển khai thực tế:

- `turn/start` được ghi nhận bền vững trước lần claim đầu tiên;
- `step/start` chỉ tồn tại sau khi `agent/pre-step` tiếp nhận công việc không rỗng;
- các tin nhắn người dùng được tiếp nhận sẽ được ghi vào log trước khi gửi yêu cầu đến mô hình;
- `step/end` luôn được ghi nhận ngay cả khi quá trình xử lý yêu cầu gặp lỗi;
- `turn/end` luôn được ghi nhận từ khối `finally`, bao gồm cả các kết quả hủy bỏ (abort) và lỗi (error).

Do đó, nhật ký phiên (log) ghi lại ranh giới mà hệ thống đã cố gắng thực hiện, chứ không chỉ công việc thực sự đến được mô hình.

## Zero-step turn không phải là dữ liệu bị mất

Có hai nhánh có thể mở một turn nhưng không tiêu tốn bất kỳ yêu cầu mô hình nào.

Thứ nhất, chính sách `pre-step` có thể từ chối lô tin nhắn vừa được claim. Turn kết thúc với trạng thái `blocked`. Tin nhắn đã claim không còn ở trạng thái chờ nữa và không có `user/message` nào được ghi thêm vào log, bởi vì mô hình chưa từng nhìn thấy nó.

Thứ hai, dữ liệu đánh thức có thể bị gỡ bỏ hoặc ghi lại thành quyết định tiếp nhận rỗng trước khi step đầu tiên bắt đầu. Turn vẫn kết thúc với trạng thái `completed`. Ranh giới rỗng đó rất quan trọng: một tín hiệu đánh thức đã được chấp nhận, một driver đã được cấp phát, và log bền vững sẽ giải thích rõ tại sao không có lệnh gọi mô hình nào diễn ra sau đó.

Coi cả hai trường hợp trên là "không có gì xảy ra" sẽ vứt bỏ hoàn toàn vết kiểm toán (audit trail).

## Điều gì thực sự còn nợ lại?

Ở cấp độ turn, chỉ những công việc bắt buộc phải chuyển tiếp vào một yêu cầu khác mới giữ cho turn hiện tại tiếp tục mở:

| Sự thật đang chờ (Pending fact) | Hệ quả |
|---|---|
| Assistant phát ra các lệnh gọi công cụ | Thực thi chúng và trả kết quả về trong một step khác. |
| Kết quả công cụ bổ sung thêm ngữ cảnh next-step | Claim lấy nó trước khi turn đóng lại. |
| Tín hiệu điều hướng đi vào inbox next-step | Tiếp nhận nó tại ranh giới step gần nhất tiếp theo. |
| Một listener kết thúc chèn thêm công việc next-step | Đánh giá lại thay vì commit quyết định dừng ứng viên. |

Các tác vụ chạy ngầm (background jobs) và subagent có vòng đời sở hữu độc lập riêng. Một turn cha **không** giữ trạng thái mở chỉ vì một tiến trình con đang tồn tại; nếu không, một tác vụ chạy lâu được ủy quyền sẽ khóa chặt vòng lặp mô hình của cha. Việc hoàn tất của con sau đó có thể chèn ngữ cảnh hoặc đánh thức công việc mới, và việc hủy bỏ tiến trình cha vẫn phải dọn sạch các con thuộc quyền sở hữu của nó. Việc hoàn thành một turn và việc toàn bộ cây agent lắng xuống (quiescence) là hai câu hỏi hoàn toàn khác nhau.

## Vì sao việc đặt tên lại quan trọng?

Nếu "turn" có nghĩa là "một HTTP request" ở một package và là "một tương tác người dùng" ở một package khác, việc hủy bỏ, đo đếm số liệu và lưu trữ bền vững sẽ trở nên bất khả thi để diễn giải. Thuật ngữ nhất quán cung cấp cho mọi hệ thống con cùng một hệ quy chiếu tọa độ:

- việc thử lại (retry) có thể diễn ra bên trong một step hoặc tại một ranh giới bền vững hoàn toàn mới tùy theo chính sách;
- mức sử dụng token/tài nguyên có thể gán chính xác cho một bộ `(turn, step)` cụ thể;
- giao diện UI có thể nhóm các khối dữ liệu stream, lệnh gọi, và kết quả vào đúng tương tác sở hữu chúng;
- cơ chế khắc phục sự cố sập (crash repair) có thể nhận biết log đã kết thúc giữa chừng trong một turn hay tại một ranh giới ổn định.

## Tiếp theo

**[Phần 3 — Công cụ không phải là một hàm thuần túy](/vi/blog/building-agents/tools-registry-schema-pipeline/)**. Ranh giới tiếp theo là con đường nằm giữa việc mô hình yêu cầu một tác động và hệ thống cho phép tác động đó được diễn ra.
