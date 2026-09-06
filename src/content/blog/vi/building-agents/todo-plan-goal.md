---
title: 'Trạng thái công việc không thuộc về mô hình'
description: 'Mười hai bước. Đến bước thứ bảy nó đã quên mất bước thứ ba vẫn chưa hoàn thành, và bạn chỉ phát hiện ra điều đó khi nó tự tin tuyên bố đã xong việc.'
pubDate: 2026-09-29
tags: ['ai-agents', 'architecture', 'developer-experience']
translationKey: 'agents-24-work-state'
sidebarTitle: '24 · Trạng thái công việc'
order: 24
---

*"Hãy chuyển đổi module auth sang API session mới."*

Mười hai bước thực sự: kiểm toán các vị trí gọi hàm, cập nhật interface, di chuyển bốn bên tiêu thụ, sửa lại các bài test, cập nhật tài liệu hướng dẫn, và gỡ bỏ lớp shim tạm thời. Agent khởi đầu rất tốt. Đến khoảng bước thứ bảy, cuộc hội thoại đã phình to, cơ chế [thu gọn compaction](/vi/blog/building-agents/the-context-budget/) đã kích hoạt, và các turn ban đầu giờ đây chỉ còn là một đoạn văn tóm tắt ngắn ngủi.

Nó hoàn thành bước thứ mười và dõng dạc tuyên bố: **"Quá trình chuyển đổi đã hoàn tất."**

Bước ba và bước tám thực tế chưa từng được đụng tới. Không phải vì mô hình cẩu thả vô trách nhiệm — mà vì bản ghi ghi nhận sự tồn tại của chúng vốn nằm ở phần cuộc hội thoại đã bị nén lại mất rồi. Nó chỉ đang báo cáo một cách rất trung thực dựa trên trạng thái mà mắt nó có thể nhìn thấy được.

<figure class="dg">
  <img src="/diagrams/part24-todo-plan-goal.svg" alt="Một danh sách công việc chỉ nằm trong prompt sẽ bị compaction nén mất; cùng danh sách đó được ghi thêm vào log sẽ sống sót và được kết xuất lại với độ trung thực nguyên vẹn." loading="lazy" />
  <figcaption><strong>Nằm ngoài bộ não của mô hình, nằm trong file log.</strong> Cơ chế được sinh ra để sống sót qua compaction thì bản thân nó tuyệt đối không được phép bị compaction nén mất.</figcaption>
</figure>

## Nơi danh sách kiểm tra (Checklist) thực sự sinh sống

> Trạng thái công việc bắt buộc phải sống **bên ngoài ngữ cảnh của mô hình** và **nằm bên trong file log**.

Một danh sách trôi nổi trong cuộc hội thoại sẽ phải hứng chịu tất cả những gì ập đến với các cuộc hội thoại: bị nén compaction, bị trôi dạt ngữ nghĩa khi diễn giải lại (paraphrase drift), và hoàn toàn không có thời điểm nào có thứ gì kiểm tra xem nó đã làm xong hết hay chưa. Còn một danh sách nằm trong log sẽ sống sót qua cả ba kiếp nạn đó và luôn được kết xuất lại với độ chi tiết trung thực 100%.

Đó chính là sự khác biệt giữa một danh sách mà mô hình phải *cố nhớ* và một danh sách mà mô hình được *mở mắt ra đọc*.

## Danh sách công việc Todo list

```typescript
interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

registry.register({
  name: 'todo_write',
  description:
    'Ghi lại hoặc cập nhật danh sách nhiệm vụ của bạn. Hãy gọi nó khi một tác vụ cần nhiều hơn ~3 bước, ' +
    'và gọi lại mỗi khi một bước bắt đầu hoặc hoàn thành. BẮT BUỘC gửi toàn bộ danh sách ĐẦY ĐỦ mỗi lần.',
  inputSchema: { /* items: TodoItem[] */ },

  async execute({ items }, ctx) {
    ctx.log.append('todo/updated', { items });          // lưu trữ bền vững
    const done = items.filter((i) => i.status === 'completed').length;
    return `Đã cập nhật. Đã xong ${done}/${items.length} mục.`;
  },
});
```

Hai quyết định trong đó không hề hiển nhiên:

**Gửi toàn bộ danh sách, không gửi dữ liệu sai biệt delta.** Việc gửi delta đòi hỏi các ID mà mô hình phải theo dõi xuyên suốt quá trình compaction, vốn chính là bài toán bạn đang cố giải quyết. Việc thay thế toàn bộ danh sách mang tính lũy đẳng (idempotent) và tự sửa lỗi: sự kiện mới nhất chính là sự thật.

**Fold, không tích lũy dồn.** Trạng thái là `last-wins` (cái sau cùng chiến thắng) duyệt trên các sự kiện `todo/updated`. Hoàn toàn không có một mảng danh sách có thể biến đổi (mutable) nào tồn tại:

```typescript
const currentTodos = (events: SessionEvent[]): TodoItem[] =>
  events.filter((e) => e.kind === 'todo/updated').at(-1)?.items ?? [];
```

Sau đó kết xuất nó vào mọi yêu cầu gửi đến mô hình như một [section trong prompt](/vi/blog/building-agents/the-prompt-prefix/) — và hãy đặc biệt chú ý đến vị trí của nó:

```typescript
systemPrompt.section({
  name: 'todos',
  order: ORDER.POLICY + 50,             // NẰM Ở CUỐI: phần này thay đổi liên tục, tiền tố phía trên thì không được đổi
  text: (ctx) => {
    const items = currentTodos(ctx.log.read());
    if (items.length === 0) return '';
    return `## Danh sách nhiệm vụ\n\n${items.map((i) =>
      `- [${i.status === 'completed' ? 'x' : i.status === 'in_progress' ? '~' : ' '}] ${i.text}`
    ).join('\n')}`;
  },
});
```

Thứ tự ưu tiên đặt ở cuối cùng, bởi vì đoạn văn bản này thay đổi trên hầu hết các turn. Nếu bạn đặt nó lên đầu, mỗi lần cập nhật todo list sẽ vô hiệu hóa toàn bộ tiền tố cache — chính xác là sai lầm từ Phần 9, được lặp lại bởi một tính năng vốn sinh ra để giúp đỡ.

## Nó cũng chính là giao diện người dùng (UI)

Danh sách này là chỉ báo tiến độ tuyệt vời nhất mà một agent có thể có, và nó hoàn toàn không tốn thêm bất kỳ chi phí nào.

Một biểu tượng spinner quay tròn chỉ nói lên rằng *hệ thống đang chạy*. Còn một danh sách với ba mục đã tích xanh, một mục đang làm dở, và tám mục đang chờ phía trước sẽ nói rõ ràng điều gì đang diễn ra, tiến độ đã đi đến đâu, và — mang tính quyết định — **cho phép người dùng can thiệp từ sớm**. Nhìn thấy mục thứ tư ghi "viết lại toàn bộ bộ phân tích cấu hình" trong khi bạn hoàn toàn không hề mong muốn điều đó sẽ giúp bạn đưa ra lời điều chỉnh chỉ mất 5 giây thay vì mất 5 phút khắc phục hậu quả.

Đây lại là nơi [hộp thư đến (inbox)](/vi/blog/building-agents/the-inbox/) phát huy giá trị: nhìn thấy kế hoạch và điều hướng nó là cùng một tương tác, chỉ cách nhau đúng một turn.

## Chế độ lập kế hoạch (Plan Mode)

Đôi khi bạn muốn nhìn thấy kế hoạch *trước khi* có bất kỳ hành động nào diễn ra. Không phải là một danh sách kiểm tra chạy song song với công việc — mà là một cánh cổng chắn ngay trước mặt nó.

Chế độ Plan mode là một trạng thái bền vững, chứ không phải là một lời prompt:

```typescript
type PlanState =
  | { mode: 'off' }
  | { mode: 'planning'; enteredAt: number }
  | { mode: 'approved'; plan: string; approvedAt: number };
```

Trong khi đang ở trạng thái `planning`, hai thứ thay đổi đồng thời:

```typescript
// 1. Các công cụ bị giới hạn — cơ chế scope từ Phần 16.
ctx.tools.restrict(agentCtx, { deny: ['write', 'edit', 'bash', 'run_code'] });

// 2. Chỉ thị thay đổi hoàn toàn.
systemPrompt.section({
  name: 'plan-mode',
  order: ORDER.IDENTITY + 10,
  text: () => planState.mode !== 'planning' ? '' :
    'CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE). Điều tra và thiết kế. Bạn được đọc, tìm kiếm và đặt câu hỏi. ' +
    'Tuyệt đối không được sửa đổi bất cứ thứ gì. Khi kế hoạch đã sẵn sàng, hãy gọi exit_plan_mode kèm theo kế hoạch.',
});
```

Và việc rời khỏi chế độ này bắt buộc phải có sự đồng ý của con người:

```typescript
{
  name: 'exit_plan_mode',
  description: 'Trình bày kế hoạch đã hoàn thành để xin phê duyệt. Bạn không thể thực hiện thay đổi cho đến khi được duyệt.',
  async execute({ plan }, ctx) {
    const ok = await ctx.interaction.confirm({ title: 'Phê duyệt kế hoạch này?', body: plan });
    if (!ok) return 'Người dùng chưa phê duyệt. Hãy chỉnh sửa lại kế hoạch và trình bày lại.';
    ctx.log.append('plan/approved', { plan });
    ctx.tools.unrestrict(ctx.agentCtx);
    return 'Đã phê duyệt. Giờ bạn có thể bắt đầu thực hiện các thay đổi.';
  },
}
```

Sự cưỡng chế nằm ở việc giới hạn công cụ, chứ không nằm ở lời chỉ thị. Một agent *được dặn* là không được sửa đổi thì phần lớn sẽ nghe lời; nhưng một agent *về mặt cấu trúc không thể* sửa đổi thì luôn luôn 100% tuân thủ. Chỉ thị đi kèm cưỡng chế, như thường lệ — và lưu ý rằng bản kế hoạch đã duyệt được ghi vào log, vì vậy câu hỏi "chúng ta đã thống nhất với nhau điều gì?" sẽ có câu trả lời rõ ràng sau này.

## Mục tiêu (Goal) sống lâu hơn các phiên làm việc

Một danh sách todo list gắn liền với từng phiên làm việc cụ thể. Nhưng một số mục tiêu thì không như vậy: *"làm cho toàn bộ bộ test chuyển sang màu xanh"* có thể kéo dài qua nhiều ngày, nhiều lần khởi động lại, và nhiều nhánh fork.

```typescript
interface Goal {
  id: string;
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  rounds: number;
  maxGoalRounds: number;
}
```

Cùng một cơ chế fold dữ liệu, với một điểm khác biệt mang tính sống còn: một goal sống sót qua **các lần fork nhánh**. Tách nhánh một phiên làm việc và cả hai nhánh đều thừa hưởng chung một mục tiêu đó, bởi vì mục tiêu thuộc về công việc chứ không thuộc về cuộc hội thoại.

Kịch bản lỗi khi không có khái niệm goal: một phiên làm việc được khôi phục resume nơi mô hình phải đọc lại toàn bộ transcript, tự suy đoán xem trước đó mình định làm cái gì, và suy đoán sai bét.

## Lời nhắc hẹn giờ (Reminders)

Mảnh ghép nhỏ cuối cùng. *"Kiểm tra lại bản deploy sau mười phút nữa."*

Cách triển khai ngây thơ là đặt một bộ đếm timer để tự động gọi mô hình. Cách triển khai chuẩn mực hơn là gửi một tin nhắn:

```typescript
scheduler.at(dueAt, () => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: frameAsUntrustedReminder(id, text) }],
    source: { kind: 'plugin', plugin: 'schedule' },
  }));
});
```

Một lời nhắc đến hạn chỉ đơn giản là một mục nữa đi vào [hộp thư đến (inbox)](/vi/blog/building-agents/the-inbox/). Không có luồng điều khiển thứ hai, không có thứ tự đảo lộn, và transcript ghi lại chính xác thời điểm nó xuất hiện — đó là lý do Phần 4 kiên quyết đòi hỏi một hàng đợi duy nhất.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness duy trì những điều này dưới dạng bốn nhóm package nhỏ gọn — `todo`, `plan`, `goal`, `schedule` — và sự tách bạch giữa chúng chính là bản thiết kế. Chúng khác nhau về mặt ngữ nghĩa: todo list là một snapshot toàn bộ danh sách trong phiên; plan mode là sự định hướng bền vững chứ không phải cưỡng chế công cụ cứng nhắc; một goal theo dõi một mục tiêu bền vững và các vòng tự trị có giới hạn; lịch trình schedule chuyển giao các lời nhắc dùng một lần hoặc định kỳ vào một phiên đang sống.

Một phiên làm việc nguội không tự đánh thức chính nó. Lời nhắc của nó sẽ nằm ở trạng thái quá hạn cho đến khi một agent gốc đang sống khôi phục lại phiên, và các khoảng thời gian định kỳ chỉ chuyển giao lần xuất hiện bị lỡ gần nhất chứ không phát lại một đống tồn đọng backlog.

Những gì chúng chia sẻ dùng chung chính là cơ chế: các sự kiện bền vững, được fold thành trạng thái, kết xuất vào trong prompt, và cưỡng chế qua phạm vi scope. Một mẫu hình duy nhất, phục vụ bốn vòng đời khác nhau.

Plan mode được mô tả ở đó như *"chế độ lập kế hoạch dưới dạng trạng thái được ghi log"* — đó là toàn bộ triết lý gói gọn trong vài từ. Không phải một biến cờ, không phải một lời prompt, không phải một chế độ giao diện UI. Một sự thật nằm trong file log với một cánh cổng chắn ngay trên đường đi ra.

## Cái bẫy thường gặp

Cái bẫy là để cho danh sách kiểm tra chỉ sống duy nhất bên trong prompt.

Nó tạo cảm giác quá đỗi chuẩn xác. Bạn kết xuất danh sách, mô hình nhìn thấy nó, nó hoạt động hoàn hảo — đối với các phiên làm việc ngắn. Thế rồi phiên làm việc dài ra, cơ chế compaction kích hoạt, và chính cơ chế bạn xây dựng để sống sót qua compaction lại bị nén sạch bách, bởi vì nó chưa bao giờ được lưu trữ ở bất kỳ nơi nào khác.

Bài kiểm tra chỉ tóm gọn trong một câu hỏi: **bạn có thể dựng lại danh sách nhiệm vụ hiện tại chỉ từ riêng file log, mà hoàn toàn không cần sự tham gia của bất kỳ mô hình nào không?** Nếu không, danh sách đó chỉ là một hình ảnh phản chiếu từ trí nhớ của mô hình, và nó chắc chắn sẽ bị đánh mất chính xác trong những phiên làm việc mà bạn cần đến nó nhất.

## Tiếp theo

**[Phần 25 — Khi mô hình chính là một con Bug (Loop Hygiene)](/vi/blog/building-agents/when-the-model-is-the-bug/)**. Nó vừa gọi cùng một lệnh `grep` tới chín lần liên tiếp. Không có lỗi nào bắn ra cả. Hệ thống vẫn đang chạy mượt mà hoàn hảo và đang đốt tiền một cách hoàn hảo.
