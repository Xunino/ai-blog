---
title: 'Phạm vi: Một tiến trình, nhiều quyền năng'
description: 'Một phiên làm việc cần toàn quyền truy cập. Một phiên khác, trong cùng tiến trình đó, bắt buộc phải là read-only chỉ đọc. Một công cụ bị ẩn đi mà mô hình vẫn có thể gọi được là một lỗ hổng, chứ không phải một chính sách.'
pubDate: 2026-09-21
tags: ['ai-agents', 'architecture', 'security']
translationKey: 'agents-16-scope'
sidebarTitle: '16 · Phạm vi (Scope)'
order: 16
---

Hai phiên làm việc, chạy chung trong một tiến trình duy nhất.

Phiên A là chính bạn, đang làm việc trong repository của mình, với mọi quyền năng được bật. Phiên B được khởi chạy tự động bởi một webhook từ pull request của một bản fork bên ngoài gửi về — nó chỉ nên đọc mã, phân tích, để lại bình luận và tuyệt đối không được chạm vào bất cứ thứ gì khác.

Mọi registry chúng ta xây dựng từ đầu đến giờ đều mang tính toàn cục. `registry.register(bashTool)` đưa `bash` vào *bộ đăng ký duy nhất* của hệ thống. Và Phiên B hoàn toàn có thể gọi được nó.

Phản xạ tự nhiên là nhét thêm một câu kiểm tra điều kiện vào bên trong công cụ:

```typescript
execute(input, ctx) {
  if (ctx.session.readOnly) throw new Error('phiên làm việc chỉ đọc (read-only)');
  return shell.run(input.command);
}
```

Cách làm này sai lầm theo một hướng rất đáng để mổ xẻ chính xác, bởi vì thoạt nhìn nó có vẻ hoạt động tốt.

## Hai dạng hiển thị, một lỗ hổng bảo mật

Khi đặt điều kiện kiểm tra bên trong công cụ, `bash` **vẫn tiếp tục nằm trong prompt** của Phiên B. Mô hình nhìn thấy nó, tin rằng mình có thể chạy lệnh, vạch ra một kế hoạch hành động bao gồm việc chạy lệnh, gọi nó, và rồi nhận về một thông báo lỗi. Sau đó nó lại thử lại với các đối số khác, bởi vì một lời từ chối trông giống như một lệnh gọi bị sai cú pháp chứ không phải là một cánh cửa đã bị khóa chặt.

Bạn chưa hề xây dựng một chính sách. Bạn vừa tạo ra một agent lãng phí hàng tá turn chỉ để tự khám phá giới hạn của chính mình qua từng lần bị từ chối.

> Một công cụ bị giới hạn bắt buộc phải **biến mất hoàn toàn khỏi prompt và từ chối thực thi**. Duy nhất một góc nhìn hiển thị (visibility). Bất kỳ điều gì khác hoặc là một lời nói dối với mô hình, hoặc là một lỗ hổng trong chính sách.

Hai nửa của vấn đề này thất bại theo hai cách khác nhau và cả hai đều rất tai hại:

- **Bị ẩn nhưng vẫn gọi được (Hidden but callable).** Mô hình không thấy nó trong danh sách schema — nhưng vẫn có thể gọi tên nó, vì tên công cụ rất dễ đoán và có thể đã xuất hiện trong các bản ghi lịch sử trước đó. Một lệnh `bash` vẫn chạy khi bị gọi trực tiếp thì không thể coi là đã bị hạn chế.
- **Hiển thị nhưng từ chối chạy (Visible but refusing).** Không tạo ra lỗ hổng bảo mật, nhưng khiến mô hình đốt cháy các turn và đưa ra những kế hoạch tồi tệ hơn, vì nó vừa suy luận dựa trên những năng lực mà thực tế nó không hề có.

<figure class="dg">
  <img src="/diagrams/part16-scope-presets.svg" alt="Khâu lắp ráp prompt và khâu thực thi đều phân giải qua một góc nhìn đã lọc duy nhất, nên một công cụ bị giới hạn không thể hiển thị ở nơi này nhưng lại gọi được ở nơi khác." loading="lazy" />
  <figcaption><strong>Duy nhất một góc nhìn hiển thị.</strong> Bị ẩn nhưng vẫn gọi được là một lỗ hổng; hiển thị nhưng từ chối chạy làm lãng phí turn. Cả hai nửa đều phải bắt nguồn từ cùng một hàm phân giải duy nhất.</figcaption>
</figure>

## Các bộ đăng ký có phân định phạm vi (Scoped Registries)

Cách giải quyết đúng đắn là việc tra cứu phải phụ thuộc vào việc ai là người đang hỏi:

```typescript
interface ToolRestriction {
  allow?: string[];    // chỉ cho phép những công cụ này
  deny?: string[];     // cho phép tất cả ngoại trừ những công cụ này
}

class ToolRegistry {
  private global = new Map<string, ToolDefinition>();
  private scoped = new WeakMap<Context, Map<string, ToolDefinition>>();
  private restrictions = new WeakMap<Context, ToolRestriction>();

  /** Đăng ký sẽ thuộc về phạm vi scope mà bạn thực hiện đăng ký. */
  register(tool: ToolDefinition, scope?: Context): Disposer {
    const target = scope ? this.scopedMap(scope) : this.global;
    if (target.has(tool.name)) throw new Error(`công cụ trùng lặp: ${tool.name}`);
    target.set(tool.name, tool);
    return () => target.delete(tool.name);
  }

  /** MỘT con đường phân giải duy nhất. Cả sinh schema lẫn thực thi đều gọi hàm này. */
  visible(scope: Context): ToolDefinition[] {
    const merged = new Map([...this.global, ...(this.scoped.get(scope) ?? [])]);
    const r = this.restrictions.get(scope);
    return [...merged.values()].filter((t) => {
      if (r?.allow && !r.allow.includes(t.name)) return false;
      if (r?.deny?.includes(t.name)) return false;
      return true;
    });
  }

  get(name: string, scope: Context): ToolDefinition | undefined {
    return this.visible(scope).find((t) => t.name === name);
  }
}
```

Bản thiết kế này tóm gọn trong một dòng: **`get` được cài đặt dựa trên chính `visible`.** Cả khâu lắp ráp prompt lẫn khâu thực thi đều đi qua cùng một bộ lọc duy nhất, vì vậy chúng không bao giờ có thể mâu thuẫn nhau. Một hàm `has()` riêng lẻ nếu lỡ bỏ qua bước kiểm tra giới hạn sẽ mở lại lỗ hổng bảo mật chỉ trong đúng một commit.

Và hàm `restrict` sẽ xác thực một cách chủ động và nghiêm ngặt ngay từ đầu:

```typescript
restrict(scope: Context, r: ToolRestriction): Disposer {
  const known = new Set([...this.global.keys(), ...(this.scoped.get(scope)?.keys() ?? [])]);
  for (const name of [...(r.allow ?? []), ...(r.deny ?? [])]) {
    if (!known.has(name)) throw new Error(`restrict: không tồn tại công cụ "${name}"`);
  }
  this.restrictions.set(scope, r);
  return () => this.restrictions.delete(scope);
}
```

Một lỗi chính tả trong danh sách cấm deny list bắt buộc phải báo lỗi ngay tại thời điểm cấu hình tổ hợp. Việc âm thầm bỏ qua một cấu hình gõ nhầm như `denny: ['bash']` sẽ tạo ra một phiên làm việc tự tưởng rằng mình đã được thắt chặt an toàn nhưng thực tế thì không — đó là kịch bản tồi tệ nhất có thể xảy ra, và là toàn bộ chủ đề của [Phần 17](/vi/blog/building-agents/configuration-must-fail-loudly/).

## Phạm vi (Scope) bắt nguồn từ đâu?

Đối tượng `agentCtx` từ [Phần 15](/vi/blog/building-agents/who-owns-the-agent/) chính là scope. Nó tồn tại riêng biệt cho từng agent, và nó sẽ được dọn dẹp giải phóng khi agent bị dispose — điều đó đồng nghĩa với việc các đăng ký theo phạm vi sẽ tự động được dọn sạch hoàn toàn miễn phí:

```typescript
await agents.create({
  sessionId,
  async setup(agentCtx) {
    if (untrusted) {
      ctx.tools.restrict(agentCtx, { deny: ['bash', 'write', 'edit', 'run_code'] });
    }
    ctx.tools.register(reviewCommentTool, agentCtx);   // chỉ dành riêng cho phiên này
  },
});
```

Hàm `setup` chạy **trước khi công bố agent**, vì vậy giới hạn đã được áp đặt vững chắc trước khi prompt đầu tiên được lắp ráp. Hoàn toàn không có bất kỳ khoảng trống thời gian nào để một schema không bị giới hạn có thể kịp sinh ra. Trình tự đó không phải là sự ngẫu nhiên — nó chính là lý do tại sao việc khởi tạo agent bắt buộc phải là một giao dịch transaction.

## Persona phủ bóng (shadow), không nối đuôi (append)

Cùng một cơ chế đó áp dụng cho nội dung của prompt. Một agent con chịu trách nhiệm review mã nguồn cần những chỉ thị hoàn toàn khác biệt, chứ không phải là những chỉ thị bổ sung được hàn chết vào đuôi:

```typescript
systemPrompt.section({
  name: 'deployment:persona',
  order: ORDER.IDENTITY,
  text: () => 'Bạn là một chuyên gia đánh giá mã nguồn cẩn trọng. Chỉ đọc và nhận xét; tuyệt đối không sửa đổi.',
}, agentCtx);   // có scope — phủ bóng section toàn cục có cùng tên
```

Cùng một `name`, nhưng có phạm vi hẹp hơn, vì vậy nó **thay thế hoàn toàn** thay vì nối thêm vào. Điều đó cực kỳ quan trọng: việc nối thêm sẽ tạo ra một agent bị dặn dò hai điều trái ngược nhau, và các mô hình xử lý mâu thuẫn một cách rất khó lường. Phủ bóng mang lại cho nó một danh tính duy nhất, rõ ràng.

Quy tắc này rất đáng ghi nhớ vì rất dễ bị làm ngược: đối với **công cụ**, các đăng ký theo scope sẽ *hợp nhất (merge)* với công cụ toàn cục (một phiên làm việc có thể bổ sung thêm năng lực). Đối với **các phần của prompt**, các đăng ký theo scope sẽ *phủ bóng (shadow)* theo tên (một phiên làm việc có thể thay thế hoàn toàn chỉ thị). Hợp nhất cho năng lực, phủ bóng cho danh tính.

## Presets (Các cấu hình sẵn)

Việc sao chép các cấu hình tổ hợp agent vào từng host sẽ dẫn đến sự trôi dạt (drift). DeepSeek Harness cấp cho mỗi phiên một thư mục preset được đặt tên cụ thể, trong đó file `agent.cordis.yml` liệt kê toàn bộ các plugin mà phiên đó sẽ chạy:

```yaml
presets:
  standard:  # cấu hình agent đầy đủ tiêu chuẩn xuất xưởng
  ptc:       # cấu hình đi kèm khả năng gọi công cụ bằng mã (programmatic tool calling)
  minimal:   # tập hợp năng lực được thu nhỏ có chủ đích
  cordis:    # cấu hình phát triển plugin và các kỹ năng chuyên biệt
```

Danh sách xuất xưởng không phải là một chiếc thang phân quyền. Một preset có thể chứa các công cụ, các section prompt, các kỹ năng, và các plugin khác, và một preset do người dùng tự viết cũng đáng tin cậy ngang với chính các plugin mà nó liệt kê.

Đừng nhầm lẫn giữa preset của agent với **preset phân quyền (permission presets)** riêng biệt ở [Phần 22](/vi/blog/building-agents/approval-and-permissions/). Preset của agent cấu hình nên thế giới plugin của một phiên làm việc. Còn preset phân quyền chỉ gói gọn chế độ sandbox và chính sách phê duyệt. Việc giữ hai khái niệm này tách bạch sẽ ngăn việc một nhãn giao diện thân thiện vô tình trở thành một tuyên bố quyền lực ngoài tầm kiểm soát.

## Khả năng hiển thị không phải là thẩm quyền (Visibility is not authority)

Rất đáng để tuyên bố điều này một cách dứt khoát, bởi vì đây là sai lầm vẫn thường sống sót qua tất cả những điều đã nói ở trên.

> Việc loại bỏ một công cụ khỏi tầm nhìn của mô hình chỉ là một **lời gợi ý (hint)**. Còn việc từ chối thực thi nó mới là **sự cưỡng chế (enforcement)**. Bạn bắt buộc phải cần cả hai, và chỉ có vế thứ hai mới thực sự mang tính chịu lực an toàn.

Mô hình hoàn toàn có thể gọi tên một công cụ mà nó không nhìn thấy — từ một bản ghi lịch sử cũ, từ một bản tóm tắt compaction, hoặc từ một người dùng buột miệng nhắc tới nó. Nếu tuyến phòng thủ duy nhất của bạn chỉ là sự vắng mặt của nó trong danh sách schema, thì phỏng đoán đó của mô hình sẽ thành công.

Cùng một nguyên lý đó khi đi sâu xuống một bậc: việc giấu một *đường dẫn* khỏi công cụ liệt kê file không phải là kiểm soát truy cập. Phép kiểm tra an toàn bắt buộc phải thuộc về điểm nối hệ thống tệp (filesystem seam), nơi mọi bên tiêu thụ đều bắt buộc phải đi qua. Đây cũng chính là lập luận ủng hộ việc đưa sandbox xuống tầng tiến trình con subprocess thay vì làm trên từng công cụ đơn lẻ — xem [Phần 18](/vi/blog/building-agents/the-execution-world/).

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness biến phạm vi (scope) thành một khái niệm nguyên thủy — một package nhỏ gọn mà các package khác xây dựng dựa trên nó, thay vì chỉ là một tính năng phụ của tool registry. Mọi thứ có nhận thức về phạm vi đều sử dụng cùng một cơ chế, vì vậy chỉ có một câu trả lời duy nhất cho câu hỏi "ai có thể nhìn thấy thứ này".

Hai điểm rất đáng học hỏi:

**Các giới hạn được xác thực nghiêm ngặt ngay tại khâu cấu hình tổ hợp.** Một cái tên lạ chưa được đăng ký sẽ bắn lỗi ngay khi mount plugin, chứ không âm thầm trôi qua thành một no-op vô hại lúc runtime.

**Presets là các cấu hình `agent.cordis.yml`, không phải các nhánh rẽ trong mã nguồn.** Một preset có thể thêm plugin, thêm section prompt, thêm công cụ và kỹ năng. DeepSeek phát hành sẵn `standard`, `ptc`, `minimal`, và `cordis`; các preset của người dùng được tạo ra đơn giản bằng cách sao chép một preset có sẵn vào một thư mục gốc đáng tin cậy của người dùng.

## Cái bẫy thường gặp

Cái bẫy là chỉ giấu công cụ đi rồi tự mãn tuyên bố rằng công việc đã hoàn thành.

Nó thực sự rất thuyết phục: bạn lọc danh sách schema, mô hình không còn dùng công cụ đó nữa, bài unit test của bạn xanh rì. Lỗ hổng nằm ở chỗ bài test chỉ khẳng định hành vi điển hình thông thường, trong khi sự cố lại đòi hỏi một prompt không bình thường — một người dùng chủ động gọi tên công cụ, một bản tóm tắt có nhắc tới nó, hoặc một mô hình tự nhớ lại nó từ đầu phiên làm việc.

Hãy kiểm thử sự cưỡng chế một cách trực tiếp. Gọi đích danh công cụ bị hạn chế, từ bên trong một phạm vi bị giới hạn, ngay trong bài unit test. Nếu nó vẫn chạy được, bạn chỉ mới viết tài liệu hướng dẫn, chứ chưa hề có một chính sách an toàn nào cả.

## Tiếp theo

**[Phần 17 — Cấu hình phải báo lỗi lớn (Configuration Must Fail Loudly)](/vi/blog/building-agents/configuration-must-fail-loudly/)**. Một file cấu hình tổ hợp có một biểu thức đặt sai chỗ. Toàn bộ các công cụ hệ thống tệp biến mất không dấu vết. Không có lỗi nào bắn ra. Agent chỉ âm thầm trở nên vô dụng một cách lặng lẽ, và bạn phải mất cả tuần trời mới tìm ra nguyên nhân tại sao.
