---
title: 'Ai là chủ sở hữu của Agent?'
description: 'Đối tượng Agent công khai có thể tiếp nhận công việc và bị hủy bỏ. Đối tượng AgentHandle có quyền kết thúc toàn bộ vòng đời của nó. Sự bất đối xứng đó chính là ranh giới quyền sở hữu.'
pubDate: 2026-09-20
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-15-ownership'
sidebarTitle: '15 · Quyền sở hữu (Ownership)'
order: 15
---

Một agent đơn lẻ trong một tiến trình có thể coi việc tiến trình thoát là quá trình giải phóng tài nguyên dọn dẹp. Nhưng một máy chủ web đang chạy cùng lúc bốn mươi agent thì không thể làm như vậy.

Khi người dùng đóng tab trình duyệt, bạn cần những câu trả lời hoàn toàn chính xác. Yêu cầu hiện tại có dừng lại không? Công việc đang xếp hàng có được bảo toàn không? Ai là người chịu trách nhiệm đóng session writer? Liệu một plugin không liên quan có thể tiêu diệt một agent chỉ vì nó tình cờ biết session id của agent đó hay không?

DeepSeek Harness trả lời những câu hỏi này bằng một API bất đối xứng có chủ đích.

## Hàm disposer là một năng lực đặc quyền

```typescript
interface AgentHandle {
  readonly agent: Agent;
  dispose(): Promise<void>;
}

interface AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  get(id: SessionId): Agent | undefined;
}
```

`ctx.agents.get(id)` trả về đối tượng `Agent` công khai. Còn caller trực tiếp tạo ra hoặc khôi phục nó sẽ nhận được `AgentHandle`.

Sự khác biệt đó không phải là để tiện lợi. Đó là vấn đề về thẩm quyền (authority).

> Agent công khai có thể tiếp nhận tin nhắn và phối hợp hủy bỏ có trật tự. Chỉ có chủ thể nắm giữ handle mới có quyền kết thúc vòng đời của agent.

Việc đặt phương thức `dispose(id)` trên registry sẽ biến một định danh dễ đoán thành thẩm quyền giải phóng tài nguyên tùy tiện cho toàn cục. Việc chỉ trả về một disposer cho chủ sở hữu thực sự biến quyền kiểm soát vòng đời trở nên tường minh ngay trong hệ thống kiểu dữ liệu type system.

<figure class="dg">
  <img src="/diagrams/part15-who-owns-agent.svg" alt="Một AgentHandle sở hữu quyền giải phóng dọn dẹp cuối cùng, trong khi Agent công khai mở ra khả năng gửi tin nhắn, hủy bỏ, chờ tĩnh lặng và bảo trì." loading="lazy" />
  <figcaption><strong>Hủy bỏ (Cancellation) là một thao tác vận hành; giải phóng (Disposal) là quyền sở hữu.</strong> Chúng tuyệt đối không được là cùng một phương thức.</figcaption>
</figure>

## Vòng đời công khai chỉ có đúng hai trạng thái

DeepSeek Harness chỉ công khai hai trạng thái:

```typescript
type AgentStatus = 'idle' | 'running';
```

`running` bắt đầu một cách đồng bộ ngay khi dữ liệu đầu vào đánh thức giữ chỗ cho driver. `idle` có nghĩa là không có turn driver nào đang được lên lịch hoặc đang hoạt động. Việc giải phóng disposal sẽ loại bỏ hoàn toàn agent khỏi registry; nó không phải là trạng thái thứ ba có thể quan sát được.

Điều này triệt tiêu hoàn toàn cuộc đua microtask kinh điển. Một khi agent đang idle chấp nhận dữ liệu đầu vào đánh thức, các observer bên ngoài sẽ nhìn thấy trạng thái `running` ngay lập tức. Họ không cần thêm một bộ đếm tin nhắn đã chấp nhận thứ hai để phỏng đoán xem công việc có đang chờ để bắt đầu hay không.

Các agent con cũng không bổ sung trạng thái `waiting` vào đây. Sự cư trú, quan hệ huyết thống và việc giải quyết kết quả của con thuộc về hệ thống con subagent. Đối tượng `Agent` cốt lõi chỉ báo cáo duy nhất việc liệu driver của chính bản thân nó có đang hoạt động hay không.

## Trạng thái tĩnh lặng (Quiescence) là một Promise, không phải một nhãn trạng thái

```typescript
await agent.whenIdle();
```

`whenIdle()` chờ đợi toàn bộ hoạt động hiện tại của agent hội tụ về trạng thái tĩnh lặng hoàn toàn. Nếu công việc thay thế bắt đầu trước khi driver đang quan sát kịp nghỉ ngơi, promise sẽ tự động bám theo cả công việc thay thế đó.

Điều này mạnh mẽ hơn nhiều so với việc thăm dò (polling) thuộc tính `status`. Một caller có thể quan sát thấy trạng thái `running`, bắt đầu chờ đợi, và vẫn nhận được kết quả chính xác nếu một tín hiệu đánh thức muộn được tiếp nhận trong quá trình hội tụ hủy bỏ. Driver tự quản lý cuộc đua đó; bên tiêu thụ không cần phải tái tạo lại nó từ các sự kiện rời rạc.

`whenIdle()` không định danh việc hoàn tất của một tin nhắn cụ thể nào. Nó trả lời một câu hỏi thuần túy về vòng đời: liệu agent này hiện tại đã thực sự yên ắng hay chưa?

## Việc khởi tạo là một giao dịch có rollback bảo vệ

Vòng lặp cụ thể sẽ tạo ra một phiên làm việc riêng tư, một agent cụ thể, và một ngữ cảnh có phạm vi agent trước khi bất kỳ ID nào được công khai ra ngoài. Các bước thiết lập tùy chọn chạy bên trong thế giới riêng tư đó. Quyền ghi bền vững vào hệ thống lưu trữ được xác lập trước khi công bố.

Chỉ sau khi thiết lập thành công trọn vẹn, vòng lặp mới ghi danh vào cả hai registry, phát đi thông báo `session/created` và `agent/created`, phát sự kiện `agent/session-start`, và khởi động driver.

Nếu khâu thiết lập ném ra lỗi ngoại lệ, việc công bố bị phủ quyết, chủ sở hữu biến mất, hoặc commit thất bại, giao dịch sẽ tự động rollback mà không để lại một agent hoặc phiên làm việc bị đăng ký dở dang nửa vời.

> Việc công bố chính là ranh giới: trước ranh giới đó, thiết lập phải có khả năng đảo ngược hoàn tác 100%; sau ranh giới đó, handle được trả về sẽ nắm toàn quyền dọn dẹp giải phóng.

Factory provider đóng vai trò là chủ sở hữu cấu trúc thứ hai. Các agent phụ thuộc vào các dịch vụ do provider đó cung cấp, vì vậy việc gỡ bỏ provider (unload) sẽ dừng và rút cạn mọi handle đang hoạt động mà nó từng tạo ra. Việc disposal từ consumer và việc unload của provider cùng hội tụ về chung một con đường giải phóng dọn dẹp.

## Hủy bỏ không phải là giải phóng (Cancel is not disposal)

Đối tượng `Agent` công khai cung cấp cơ chế hủy bỏ phối hợp:

```typescript
agent.cancel({ kind: 'user' }, { keepInbox: true });
```

Việc hủy bỏ sẽ abort turn hiện tại hoặc tác vụ bảo trì đang chạy. Mặc định nó cũng sẽ xóa sạch công việc đang xếp hàng và dữ liệu điều hướng. Cờ `keepInbox: true` bảo toàn các công việc đang chờ để người dùng có thể ngắt hướng đi hiện tại mà không xóa sạch những gì đã được chấp nhận từ trước.

Hủy bỏ là một thao tác no-op vô hại khi không có gì đang hoạt động; nó không cài bẫy cho các yêu cầu trong tương lai. Nguyên nhân hủy bỏ đầu tiên sẽ giành chiến thắng cho hoạt động hiện tại.

Giải phóng (Disposal) mang tính kết thúc vĩnh viễn. Phương thức `dispose()` đã được memoize của handle sẽ abort với nguyên nhân `disposed`, chờ cho driver đạt trạng thái tĩnh lặng hoàn toàn, đóng đường dẫn ghi session, tháo gỡ scope của agent, tách rời agent, rồi sau đó tách rời session. Các rào chắn bảo vệ tách rời chính xác theo đối tượng ngăn chặn việc một disposer cũ vô tình xóa nhầm một agent mới được tái sử dụng cùng id sau này.

## Tác vụ bảo trì chiếm lĩnh giai đoạn nhàn rỗi (Maintenance)

Một số công việc thuộc về agent nhưng không phải là một turn hội thoại: sinh tiêu đề, tạo tóm tắt, hoặc các phép tính dọn dẹp nội bộ khác.

```typescript
await agent.runMaintenance(async (signal) => {
  return generateTitle(agent.session, signal);
});
```

`runMaintenance()` chiếm lĩnh một cách đồng bộ giai đoạn nhàn rỗi thực sự. Trạng thái công khai vẫn giữ nguyên là `idle`, nhưng dữ liệu đầu vào đánh thức sẽ nằm chờ trong inbox cho đến khi tác vụ bảo trì hoàn tất. Tín hiệu hủy bỏ tiếp cận tác vụ thông qua signal của nó, và `whenIdle()` theo dõi cả tác vụ bảo trì lẫn bất kỳ công việc đánh thức nào được giải phóng phía sau nó.

Cơ chế này tránh việc phải bịa ra các turn giả tạo chỉ để tuần tự hóa các công việc bảo trì với công việc hội thoại thông thường.

## Cái bẫy thường gặp

Cái bẫy là coi `dispose()` như một thao tác dọn dẹp mà bất kỳ thành phần tận tâm nào cũng có thể tiện tay gọi.

Dọn dẹp trùng lặp thường vô hại. Nhưng thẩm quyền vòng đời thì không như vậy. Nếu hai thành phần không liên quan cùng có thể tiêu diệt một agent, một nhánh xử lý lỗi ở một tính năng này có thể âm thầm chấm dứt công việc thuộc quyền sở hữu của một tính năng khác.

Hãy giữ các thao tác này hoàn toàn tách bạch:

- dùng `cancel()` để dừng hoặc chuyển hướng công việc hiện tại;
- dùng `whenIdle()` để chờ đợi trạng thái tĩnh lặng hoàn toàn;
- dùng `runMaintenance()` cho các công việc không phải dạng turn cần chạy tuần tự;
- dùng phương thức `dispose()` của handle sở hữu để kết thúc vĩnh viễn vòng đời của agent.

## Tiếp theo

**[Phần 16 — Phạm vi và Preset (Scope and Presets)](/vi/blog/building-agents/scope-and-presets/)**. Một phiên làm việc cần quyền truy cập toàn bộ; một phiên khác, trong cùng tiến trình đó, bắt buộc phải là read-only chỉ đọc. Không có một biến toàn cục (global) nào có thể diễn đạt được điều đó.
