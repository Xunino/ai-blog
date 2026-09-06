---
title: 'Sự kiện và Waterfalls'
description: 'Compaction nên chạy ngay trước khi yêu cầu được dựng — mà không để compaction biết về vòng lặp, hoặc vòng lặp biết về compaction.'
pubDate: 2026-09-19
tags: ['ai-agents', 'architecture', 'plugins']
translationKey: 'agents-14-events'
sidebarTitle: '14 · Sự kiện (Events)'
order: 14
---

[Phần 10](/vi/blog/building-agents/the-context-budget/) yêu cầu cơ chế thu gọn compaction phải chạy vào một thời điểm chính xác: sau khi dữ liệu đầu vào đã được claim, và trước khi yêu cầu mô hình được lắp ráp. [Phần 13](/vi/blog/building-agents/plugins-and-capability-seams/) lại chỉ ra rằng compaction nên là một plugin độc lập.

Đặt hai yêu cầu đó lại cạnh nhau và bạn sẽ thấy xuất hiện một khoảng trống. `ctx.provide('shell', …)` hoạt động trơn tru vì shell là *thứ mà vòng lặp chủ động yêu cầu*. Còn compaction không phải là thứ có ai chủ động đòi hỏi — nó là một việc cần phải xảy ra vào một khoảnh khắc nhất định trong luồng điều khiển của người khác. Hoàn toàn không có dịch vụ nào để cung cấp ở đây cả.

Bạn cần một điểm mở rộng (extension point): một thời điểm được đặt tên rõ ràng nơi vòng lặp thông báo nó chuẩn bị làm gì, và bất kỳ thành phần nào đang lắng nghe đều có quyền quan sát nó, thay đổi nó, hoặc ngăn chặn nó lại.

## Ba họ sự kiện, và chọn sai là một lỗi thiết kế

Trước khi bàn về cơ chế, hãy nói về hệ thống phân loại — bởi vì hầu hết các sai lầm ở đây đều bắt nguồn từ việc chọn sai loại sự kiện, và không có kỹ thuật triển khai tài tình nào có thể cứu vãn nổi điều đó.

**Sự kiện bền vững (Durable events)** là các sự thật được ghi nối tiếp vào file log. `turn/start`, `assistant/message`, `tool/result`. Chúng sống sót qua các lần tải lại reload, chúng tạo nên bản ghi lịch sử cuộc hội thoại, và việc bổ sung thêm một sự kiện bền vững đồng nghĩa với việc thay đổi định dạng phiên làm việc. Hãy dùng loại này khi *sự thật đó bắt buộc phải sống lâu hơn tiến trình*.

**Sự kiện trực tiếp (Live events)** mang theo tham chiếu đến một đối tượng đang chạy thực tế. `agent/pre-step`, `agent/status`, `agent/inbox/claimed`. Chúng biến mất khi tiến trình kết thúc và không thể phát lại được, bởi vì đối tượng mà chúng trỏ tới không còn tồn tại nữa. Hãy dùng loại này để *quan sát hoặc can thiệp đánh chặn công việc đang thực thi*.

**Sự kiện năng lực (Capability events)** gắn kết chính sách vào một điểm nối seam. `fs/write-intent`, `tools/pre-execute`. Chúng thuộc về một năng lực cụ thể thay vì thuộc về vòng lặp, và chúng tồn tại để một plugin chính sách có thể can thiệp vào hệ thống tệp mà không cần phải import class agent. Hãy dùng loại này khi *mối quan tâm thuộc về bản thân năng lực đó, chứ không thuộc về vòng lặp*.

> Chọn sai họ sự kiện là một lỗi thiết kế kiến trúc, không phải là một lỗi mã nguồn thông thường.

Hai dạng lỗi này mang tính đối xứng và đều cực kỳ đắt giá. Biến một thứ đáng lẽ là trực tiếp thành bền vững, và bạn vừa ghi một con trỏ `Agent` đang sống vào một file log mà sau này sẽ được đọc khi agent đó đã chết từ lâu. Biến một thứ đáng lẽ là bền vững thành trực tiếp, và sự thật đó sẽ biến mất không dấu vết khi khởi động lại — đó chính là cách bạn tạo ra một bản ghi lịch sử không thể tự giải thích nổi nội dung của chính nó.

<figure class="dg">
  <img src="/diagrams/part14-events-waterfalls.svg" alt="Mỗi listener trong waterfall có thể quan sát, sửa đổi dữ liệu đi vào, sửa đổi dữ liệu đi ra, hoặc ngắn mạch toàn bộ chuỗi còn lại." loading="lazy" />
  <figcaption><strong>Listener quyết định xem phần còn lại của chuỗi có được chạy hay không.</strong> Đó là lý do tại sao đây không chỉ là một mảng middleware đơn giản — và việc quên gọi <code>next()</code> chính là cái bẫy chết người.</figcaption>
</figure>

## Waterfall: Listener nắm giữ chiếc chìa khóa của chuỗi

Để can thiệp đánh chặn, cơ chế phát-rồi-quên (emit-and-forget) thông thường là không đủ. Một listener cần nhìn thấy giá trị được đề xuất, sửa đổi nó, chuyển tiếp nó đi — hoặc thẳng thừng từ chối.

Hình thái thác nước (waterfall) rất đáng để hiểu tường tận bởi vì nó đảo ngược luồng điều khiển thông thường:

```typescript
type Waterfall<T> = (value: T, next: (v?: T) => Promise<T>) => Promise<T>;

class Events {
  private hooks = new Map<string, Waterfall<any>[]>();

  on<T>(name: string, hook: Waterfall<T>): Disposer {
    const list = this.hooks.get(name) ?? [];
    list.push(hook);
    this.hooks.set(name, list);
    return () => { /* remove */ };
  }

  async waterfall<T>(name: string, initial: T): Promise<T> {
    const chain = this.hooks.get(name) ?? [];
    const step = async (i: number, value: T): Promise<T> =>
      i >= chain.length ? value : chain[i](value, (v) => step(i + 1, v ?? value));
    return step(0, initial);
  }
}
```

Dòng code quan trọng nhất là `next: (v?: T) => Promise<T>`. **Listener toàn quyền quyết định liệu phần còn lại của chuỗi có được chạy tiếp hay không, và chúng sẽ nhìn thấy dữ liệu gì.** Điều này mang lại cho nó bốn lựa chọn trung thực:

```typescript
// 1. Quan sát — chỉ nhìn, không thay đổi gì
events.on('agent/pre-step', async (decision, next) => {
  metrics.count('steps');
  return next();
});

// 2. Sửa đổi trên đường đi vào
events.on('agent/pre-step', async (decision, next) => {
  return next({ ...decision, messages: withTimestamp(decision.messages) });
});

// 3. Sửa đổi trên đường đi ra
events.on('agent/pre-step', async (decision, next) => {
  const result = await next();
  return result.kind === 'enter' ? { ...result, messages: trim(result.messages) } : result;
});

// 4. Ngắn mạch (Short-circuit) — từ chối, và không có gì phía sau được chạy
events.on('agent/pre-step', async (decision, next) => {
  if (overBudget()) return { kind: 'reject', reason: 'Token budget exhausted.' };
  return next();
});
```

Lựa chọn số 4 là lý do tại sao đây không đơn thuần là một mảng middleware. Một listener có thể chấm dứt toàn bộ chuỗi ngay lập tức, và vòng lặp sẽ tôn trọng quyết định đó.

**Sự kiện tuần tự (Serial events)** là người anh em đơn giản hơn: mọi listener đều được chạy tuần tự theo thứ tự, không ai có thể ngăn cản ai, và không hề có hàm `next()`. Hãy dùng chúng cho các điểm kiểm tra kết thúc (terminal checkpoints) — sự kiện `agent/turn-stopping` là tuần tự bởi vì "turn chuẩn bị kết thúc" không phải là một quyết định mà ai đó có quyền phủ quyết, nó chỉ là một cơ hội cuối cùng để hành động.

## Kiểu dữ liệu của quyết định (Decision Type)

Sự kiện `agent/pre-step` mang theo payload thú vị nhất trong toàn hệ thống, và cấu trúc của nó rất đáng để học hỏi:

```typescript
type StepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true };
```

Một quyết định từ chối `reject` sẽ đóng turn lại với trạng thái **bị chặn mà không tiêu tốn step nào (blocked with zero steps spent)** — tình huống từ [Phần 2](/vi/blog/building-agents/turn-and-step/) vốn chỉ tồn tại được vì turn và step được phân tách rõ ràng. Bản thân quyết định pre-step không chứa lý do dạng tự do.

Một quyết định tiếp nhận `enter` mang theo các tin nhắn sẽ trở thành yêu cầu gửi đến mô hình. Đây chính là chiếc ghế dành cho compaction:

```typescript
events.on('agent/pre-step', async (decision, next) => {
  const result = await next();
  if (result.kind !== 'enter') return result;
  if (!overThreshold(log)) return result;
  await compact(log);
  return { ...result, messages: deriveMessages(log.read()) };
});
```

Compaction không cần biết bất kỳ điều gì về vòng lặp. Vòng lặp cũng không cần biết bất kỳ điều gì về compaction. Việc xóa bỏ plugin sẽ loại bỏ hoàn toàn hành vi này mà không để lại bất kỳ vết tích nào ở nơi khác.

## Hãy bảo tồn những gì bạn không có ý định thay đổi

Một quy ước duy nhất giúp ngăn chặn cả một lớp lỗi bug gần như vô hình.

Một listener khi bọc quanh `next()` sẽ nhận được một quyết định đã được xây dựng bởi mọi thành phần ở hạ lưu. Nếu nó tự ý tạo ra một đối tượng thay thế mới toanh từ đầu, nó sẽ âm thầm vứt bỏ toàn bộ công sức của các thành phần đó:

```typescript
// Sai — làm rơi mất trường startsRequestSeries và bất kỳ trường nào được bổ sung sau này
const result = await next();
return { kind: 'enter', messages: myMessages };

// Đúng — dùng toán tử spread, sau đó chỉ ghi đè những gì thuộc quyền sở hữu của mình
const result = await next();
return { ...result, messages: myMessages };
```

Phiên bản đầu tiên trông không hề có vẻ sai khi bạn vừa gõ xong, và trường dữ liệu bị làm rơi đó có lẽ được thêm vào bởi một plugin được nạp sau plugin của bạn. Triệu chứng: một tính năng chạy ngon lành khi đứng một mình nhưng lăn ra hỏng ngay khi một plugin khác được bật lên. Không có lỗi nào bắn ra, không có dòng log nào cảnh báo, và quá trình gỡ lỗi bằng bisect cực kỳ đau đớn vì thủ phạm lại chính là plugin *vẫn đang hoạt động bình thường*.

## Cầu nối tới các tiến trình khác

Người dùng cũng muốn có các hook của riêng họ — một lệnh shell chạy trên mọi lệnh gọi công cụ, một đoạn script phủ quyết việc ghi đè vào nhánh `main`. Cùng một cơ chế waterfall đó, chỉ khác là vượt qua ranh giới tiến trình:

```typescript
events.on('tools/pre-execute', async (call, next) => {
  const hook = config.hooks?.[call.tool.name];
  if (!hook) return next();

  const proc = await execFile(hook.command, { input: JSON.stringify(call), timeout: 5_000 });
  const verdict = JSON.parse(proc.stdout) as { allow: boolean; reason?: string };

  return verdict.allow
    ? next()
    : { kind: 'reject', reason: verdict.reason ?? 'Bị chặn bởi hook.' };
});
```

Bản hợp đồng waterfall sống sót hoàn hảo qua quá trình tuần tự hóa, đó chính là lý do tại sao nó hoạt động được: quan sát, sửa đổi, từ chối đều có thể biểu diễn trọn vẹn dưới dạng JSON đầu vào và JSON đầu ra. Có hai chi tiết tuyệt đối không được bỏ qua — một **khoảng thời gian chờ timeout**, vì nếu không một hook bị treo sẽ làm treo cứng toàn bộ agent, và một quy tắc rõ ràng cho việc **khi hook bị sập** thì có nghĩa là gì. Fail-open đồng nghĩa với việc một hook bị hỏng sẽ âm thầm vô hiệu hóa toàn bộ chính sách bảo vệ; fail-closed đồng nghĩa với việc một lỗi chính tả nhỏ sẽ làm tê liệt agent. Hãy lựa chọn có chủ đích và viết nó ra tài liệu.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness đặt tên cho tất cả các điểm mở rộng của nó và tự động sinh ra một catalog chi tiết về chúng — từng sự kiện, thuộc họ nào, payload ra sao, bên nào sản xuất và bên nào tiêu thụ. Bản catalog này được sinh ra từ chính mã nguồn và được kiểm tra nghiêm ngặt trong CI, vì vậy một sự kiện mới được thêm vào mà thiếu tài liệu sẽ lập tức làm rớt bài build.

Điều đó nghe có vẻ rườm rà về quy trình. Nhưng nó tạo nên sự khác biệt giữa một bề mặt mở rộng thực thụ và một mớ hook do ai đó tiện tay thêm vào: tác giả một plugin có thể đọc đúng một trang tài liệu duy nhất và biết rõ mọi thời điểm mình có thể gắn vào, mà không cần phải đọc từng dòng code trong vòng lặp.

Luồng xử lý một turn từ Phần 2, được chú thích rõ họ sự kiện:

```text
turn/start                          durable (bền vững)
  agent/inbox/claimed               live (trực tiếp)
  agent/pre-step         waterfall  live              ← reject | enter
  step/start                        durable
  agent/request          waterfall  live              ← viết lại yêu cầu gửi đi
  llm/stream             waterfall  live              ← bọc quanh luồng stream
  assistant/chunk*                  durable
  tools/pre-execute      waterfall  capability (năng lực)
  tools/post-execute     waterfall  capability
  tool/result*                      durable
  step/end                          durable
  agent/turn-stopping    serial     live              ← điểm kiểm tra kết thúc
turn/end                            durable
```

Các sự kiện bền vững tạo nên bản ghi lịch sử transcript. Waterfall là nơi hành vi được gắn kết vào. Và một điểm kiểm tra tuần tự duy nhất ở cuối cùng.

## Cái bẫy thường gặp

Cái bẫy là một listener quên không gọi `next()`.

```typescript
events.on('agent/pre-step', async (decision, next) => {
  if (shouldLog(decision)) logger.info('step', decision);
  return decision;                              // ← lẽ ra phải là return next()
});
```

Đó chỉ là một hook để ghi log. Nhưng nó cũng đồng thời âm thầm vô hiệu hóa compaction, việc cưỡng chế ngân sách, và mọi listener khác được đăng ký phía sau nó. Không có lỗi nào xảy ra. Không có cảnh báo nào xuất hiện. Một tính năng đơn giản là biến mất khỏi cuộc đời, và plugin gây ra tội ác đó lại chính là plugin trông có vẻ vô hại nhất.

Các hàng rào phòng thủ, xếp theo mức độ hữu ích: biến `next()` thành cách duy nhất để tạo ra giá trị trả về trong hệ thống kiểu dữ liệu nếu ngôn ngữ cho phép; ghi một log cảnh báo trong môi trường development khi một chuỗi trả về mà phần đuôi phía sau không hề được chạy; và trong khâu review mã nguồn, hãy đối xử với *bất kỳ* listener nào trả về mà không gọi `next()` như một hành vi ngắn mạch có chủ đích bắt buộc phải giải trình rõ ràng trong comment.

## Tiếp theo

**[Phần 15 — Ai là chủ sở hữu của Agent?](/vi/blog/building-agents/who-owns-the-agent/)**. Người dùng đóng tab trình duyệt lại. Thứ gì sẽ dừng lại? Còn công cụ đang chạy dở giữa chừng, và tiến trình con subprocess mà nó vừa sinh ra thì sao? Và ai thực sự có *quyền* ra lệnh dừng?
