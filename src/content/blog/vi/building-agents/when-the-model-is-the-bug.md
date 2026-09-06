---
title: 'Khi mô hình chính là một con Bug (Loop Hygiene)'
description: 'Lệnh grep giống hệt nhau lần thứ chín. Không có lỗi nào xảy ra. Hệ thống vẫn đang chạy hoàn hảo và đang đốt tiền một cách hoàn hảo — và không có exception nào báo cho bạn biết.'
pubDate: 2026-09-30
tags: ['ai-agents', 'operations', 'architecture']
translationKey: 'agents-25-guards'
sidebarTitle: '25 · Vệ sinh vòng lặp'
order: 25
---

```text
step 14  grep -rn "handleAuth" src/
step 15  grep -rn "handleAuth" src/
step 16  grep -rn "handleAuth" src/
```

Giống hệt nhau từng byte, ba lần liên tiếp. Và nó chuẩn bị làm thêm sáu lần nữa như thế.

Mọi tầng bạn đã dày công xây dựng đều đang hoạt động hoàn toàn chính xác. Công cụ chạy êm ru, trả về kết quả hợp lệ, và dữ liệu đến tay mô hình trọn vẹn. Không có ngoại lệ exception nào bắn ra, không có timeout, không có kết quả lỗi, không có số liệu metric nào bất thường. Bảng điều khiển giám sát của bạn vẫn xanh rì bởi vì chẳng có thứ gì bị hỏng cả.

> Có một lớp sự cố mà không một kênh báo lỗi nào có thể phát hiện được: **hệ thống thì hoàn toàn đúng nhưng mô hình thì hoàn toàn sai.**

Không có thứ gì bạn xây dựng từ đầu đến giờ có thể nhìn thấy được điều này, bởi vì mọi thứ bạn xây từ trước đến nay đều chỉ canh chừng các *thất bại kỹ thuật*, và đây thì không phải là một thất bại kỹ thuật. Nó cần một cơ chế riêng biệt của chính nó.

## Hai hình thái phổ biến

**Lặp vô tận (Repetition)** — cùng một lệnh gọi với cùng các đối số, kết quả trả về không hề được tiếp thu. Thường là do mô hình bị mắc kẹt giữa hai giả thuyết, hoặc đang đọc đi đọc lại một file với hy vọng hão huyền rằng các byte dữ liệu sẽ tự thay đổi.

**Bị treo (Hanging)** — một công cụ không bao giờ trả về kết quả. Lệnh `npm install` nằm phía sau một proxy mạng đã chết; một tiến trình con subprocess dài cổ chờ đợi dữ liệu từ stdin mà không ai thèm nhập vào.

Cùng một triệu chứng nhìn thấy từ bên ngoài — hệ thống bận rộn nhưng không hề tiến triển thêm — nhưng cách khắc phục hoàn toàn khác nhau, đó là lý do tại sao chúng phải là hai cơ chế tách biệt.

<figure class="dg">
  <img src="/diagrams/part25-model-guards.svg" alt="DeepSeek đi kèm một lời nhắc lặp lại mang tính cố vấn và các deadline công cụ mang tính hợp tác; ngân sách step cho turn vẫn là một đề xuất mở rộng." loading="lazy" />
  <figcaption><strong>Khuyên răn từ sớm, cưỡng chế muộn màng.</strong> Chặn đứng ngay từ lần gọi trùng lặp thứ hai sẽ bóp chết mọi nỗ lực polling, thử lại và chờ đợi hoàn toàn chính đáng.</figcaption>
</figure>

## Lặp lại: Nhắc nhở mà không phủ quyết

Băm mã hash lệnh gọi, đếm số lần lặp lại:

```typescript
const seen = new Map<string, number>();
const key = (c: ToolCall) => `${c.name}:${stableStringify(c.input)}`;

ctx.events.on('tools/post-execute', async (call, next) => {
  const k = key(call);
  const n = (seen.get(k) ?? 0) + 1;
  seen.set(k, n);

  const result = await next();

  if ([3, 5, 8].includes(n)) {
    ctx.agent.send({ role: 'user', content: [{ type: 'text', text:
      `Bạn vừa gọi ${call.name} với các đối số giống hệt nhau ${n} lần liên tiếp. ` +
      `Kết quả sẽ không thay đổi đâu. Hãy sử dụng những gì đã nhận được, thử một ` +
      `hướng tiếp cận khác, hoặc nói rõ cho người dùng biết điều gì đang làm bạn bế tắc.` }] },
      { boundary: 'next-step', wake: false, source: { kind: 'guard' } });
  }
  return result;
});
```

Ba lựa chọn thiết kế rất đáng bảo vệ:

**Nó vẫn cho phép lệnh gọi được thực thi bình thường.** Lời nhắc nhở chỉ mang tính cố vấn (advisory). Việc chặn đứng ngay ở lần gọi trùng lặp thứ ba giả định rằng sự lặp lại luôn luôn là sai trái, nhưng thực tế không phải vậy — việc thăm dò polling một bài build, thử lại một lần đọc mạng chập chờn, chờ đợi một file được sinh ra đều là những hành vi hoàn toàn chính đáng. Lời khuyên bảo tồn được những trường hợp đó; còn sự ngăn chặn sẽ bóp chết chúng.

**Nó đến dưới dạng một tin nhắn, không phải một lỗi công cụ.** Mô hình không hề phạm phải một sai lầm mà nó có thể sửa được bằng cách đổi tham số. Nó cần một cú hích về mặt *chiến lược*, và lời khuyên về mặt chiến lược thuộc về cuộc trò chuyện. Được gửi với cờ `wake: false` để nó đi kèm theo step thực sự tiếp theo thay vì tiêu tốn một turn riêng biệt — chính là [trường hợp inject](/vi/blog/building-agents/the-inbox/) từ Phần 4.

**Ba lần, không phải hai lần.** Hai lần gọi giống nhau là chuyện hết sức bình thường. Ngưỡng kích hoạt bắt buộc phải nằm trên mức hành vi thông thường, nếu không lời nhắc nhở sẽ biến thành tiếng ồn rác rưởi mà mô hình học cách lờ đi, đó là cùng một dạng thất bại với [sự mệt mỏi vì lời nhắc](/vi/blog/building-agents/approval-and-permissions/) ở một tầng sâu hơn.

Triển khai của DeepSeek sẽ tự động reset chuỗi đếm này khi có một prompt mới của người dùng được tiếp nhận. Các lệnh gọi bị loại trừ khỏi việc theo dõi sẽ hoàn toàn trong suốt chứ không làm reset chuỗi, và các lệnh gọi bị từ chối vẫn được tính vào số lần lặp vì việc phát hiện diễn ra trong `tools/post-execute`.

## Bị treo: Một thời hạn chót mang tính hợp tác (Cooperative Deadline)

Chỉ những công cụ có khai báo `timeoutMs` trong `ToolDefinition` mới nhận được một hạn chót deadline. Chính sách sẽ bọc quanh `tools/execute`, tạo ra một tín hiệu hủy bỏ cancellation signal, và yêu cầu công việc ở hạ lưu dừng lại:

```typescript
ctx.events.on('tools/execute', async (call, next) => {
  const ms = call.tool.timeoutMs;
  if (ms === undefined) return next();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DeadlineExceeded(ms)), ms);

  try {
    return await nextWithSignal(anySignal([call.signal, ctl.signal]));
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      return {
        isError: true,
        content: `Lệnh gọi công cụ đã bị timeout sau ${ms}ms.`,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
});
```

**Đây là sự hợp tác (cooperative), không phải một cú chém chết cưỡng bức (hard kill).** Nếu đoạn mã ở hạ lưu phớt lờ tín hiệu signal, wrapper vẫn sẽ tiếp tục nằm bên trong `await next()` và không thể trả về kết quả timeout cho đến khi công việc đó thực sự dừng lại. Việc cưỡng bức tiêu diệt cây tiến trình thuộc về việc triển khai của từng năng lực cụ thể, chứ không thuộc về chính sách chung chung này.

**Thông điệp là dành cho mô hình.** Một từ "Timeout" cộc lốc chẳng dạy cho nó được điều gì cả. "Đã bị dừng lại, có thể đang chờ dữ liệu đầu vào, hãy thử thu hẹp phạm vi lại" mang lại cho nó ba giả thuyết có thể hành động được ngay.

**Chạy chậm không đồng nghĩa với bị treo.** Một lệnh `npm run build` chạy mất tám phút là hoàn toàn có chủ đích. Đó là lý do [tác vụ ngầm (background jobs)](/vi/blog/building-agents/background-work/) ra đời — hạn chót deadline là dành cho những công việc đáng lẽ phải nhanh nhưng lại bị chậm, chứ không dành cho những công việc vốn dĩ đã biết trước là sẽ chạy lâu.

## Đề xuất mở rộng: Ngân sách Step (Step Budgets)

Việc phát hiện lặp lại tóm được các lệnh gọi giống hệt nhau. Nhưng nó bỏ lọt sự lang thang trông có vẻ rất năng suất: đọc file này, rồi file kia, rồi lại file khác, sâu tới 40 bước mà không bao giờ hội tụ về đích.

Một mức trần theo từng turn có thể tóm được điều đó:

```typescript
ctx.events.on('agent/pre-step', async (decision, next) => {
  const n = ctx.turn.stepCount;
  const max = ctx.config.maxStepsPerTurn ?? 50;

  if (n >= max) {
    return { kind: 'reject',
      reason: `Ngân sách số step (${max}) đã cạn kiệt. Hãy tóm tắt tiến độ và dừng lại.` };
  }
  if (n === Math.floor(max * 0.8)) {
    ctx.agent.inject(`Bạn đang ở bước ${n} trên tổng số ${max} của turn này. Hãy bắt đầu hội tụ: ` +
                     `hoàn thành những gì có thể và báo cáo những gì còn lại.`);
  }
  return next();
});
```

Lời cảnh báo ở mốc 80% chính là phần mang tính quyết định. Một cú dừng cứng ngắc ngay tại ngưỡng giới hạn sẽ tạo ra một turn kết thúc đột ngột giữa chừng không có lấy một dòng tóm tắt. Cảnh báo trước cho phép mô hình hạ cánh an toàn — và một agent báo cáo rằng *"Tôi đã điều tra bốn trên sáu tầng, đây là những gì tôi tìm thấy, và đây là những gì còn sót lại"* hữu ích hơn gấp bội so với một agent đột ngột lăn đùng ra tắt ngấm.

DeepSeek Harness tuyên bố rõ ràng rằng **chưa có ngân sách turn tích hợp sẵn** là một hạn chế hiện tại của vòng lặp agent. Các điểm mở rộng hiện có `agent/turn-stopping` và `agent/pre-step` chính là nơi mà một chính sách đặc thù của môi trường triển khai có thể cài đặt thêm; nó không nằm trong các preset phân quyền ngày nay.

## Làm cho nó hiển thị rõ ràng

Các guard sinh ra một loại tín hiệu mà không thứ gì khác có được. Hãy ghi log nó lại:

```typescript
interface HygieneMetrics {
  repeatCallsDetected: number;
  deadlinesExceeded: number;
  stepBudgetsExhausted: number;
  wastedToolCalls: number;      // các lần lặp giống hệt — lãng phí 100%
}
```

`wastedToolCalls` là chỉ số trung thực nhất, và nó rất đáng để đưa lên dashboard bởi vì nó *quy đổi trực tiếp ra tiền bạc*. Sự gia tăng của chỉ số này sau khi đổi mô hình hoặc sửa prompt là tín hiệu nhanh nhất báo cho bạn biết rằng có thứ gì đó vừa bị thụt lùi theo cách mà các bài test thông thường không thể nào bắt được.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness có một nhóm `guard/` nhỏ gọn với hai chính sách được xuất xưởng: lời nhắc nhở lặp công cụ và một wrapper bọc timeout `tools/execute` có tính hợp tác. Nhóm này tồn tại bởi vì mối quan tâm này hoàn toàn khác biệt với mọi thứ xung quanh nó.

Cách tiếp cận trong README của nó là thứ rất đáng học hỏi: các guard giữ cho vòng lặp **năng suất (productive)**, vốn là một nhiệm vụ hoàn toàn khác với việc giữ cho nó **chính xác (correct)**. Tính chính xác thuộc về các bài test, hệ thống kiểu dữ liệu, và khâu xử lý lỗi. Còn tính năng suất là việc nhận ra rằng một hệ thống đang chạy hoàn toàn đúng đắn nhưng lại chẳng đi tới đâu cả.

Chúng đều là các plugin. Ngưỡng nhắc nhở có thể cấu hình được; thời gian timeout đến từ định nghĩa của từng công cụ. Cơ chế phủ quyết lặp cứng và ngân sách step trên toàn bộ turn hiện chưa được triển khai.

## Cái bẫy thường gặp

Cái bẫy là cưỡng chế quá sớm.

Lý lẽ rất đầy cám dỗ: nếu hai lệnh gọi giống hệt nhau báo hiệu một vòng lặp, hãy chặn ngay lần thứ hai để tiết kiệm tiền. Thế rồi bạn bóp chết tươi một agent đang thăm dò một bài build, một agent đang thử lại một lệnh fetch chập chờn, một agent đang chờ một file mà một background job đang cặm cụi ghi. Tất cả đều là hành vi hợp lệ, nhưng giờ đây trở thành bất khả thi.

**Hãy khuyên răn trước, cưỡng chế sau cùng.** Một lời nhắc nhở ở lần thứ ba chỉ tốn vài token và bảo toàn mọi mẫu hình chính đáng. Một cú dừng cứng ở lần thứ năm mươi sẽ tóm gọn kẻ thực sự chạy trốn mất kiểm soát. Khoảng trống nằm giữa hai mốc đó chính là nơi các agent thực chiến làm công việc thực tế, và việc thu hẹp nó nhân danh sự tối ưu hiệu năng sẽ khiến bạn phải trả giá bằng những quy trình làm việc bị gãy đổ nhiều hơn rất nhiều so với số tiền token còm cõi bạn tiết kiệm được.

Cái bẫy ngược lại cũng nguy hiểm không kém: xuất xưởng sản phẩm mà không có guard bảo vệ chỉ vì thấy agent chạy có vẻ rất ổn trong các bài test. Các phiên kiểm thử của bạn thường rất ngắn. Còn các vòng lặp luẩn quẩn lại đòi hỏi độ dài, sự mơ hồ, và một tác vụ mà mô hình không thể nào giải quyết trọn vẹn — chính là chiều thứ Ba đầy giông bão trên môi trường production.

## Tiếp theo

**[Phần 26 — Bề mặt và Phân phối (Surfaces and Distribution)](/vi/blog/building-agents/surfaces-and-distribution/)**. Cùng một agent đó bắt buộc phải chạy được trên terminal, trên trình duyệt web, phía sau cổng JSON-RPC, và từ một webhook. Và rồi có ai đó hỏi làm thế nào để cài đặt nó trên một cỗ máy không hề có Node.js.
