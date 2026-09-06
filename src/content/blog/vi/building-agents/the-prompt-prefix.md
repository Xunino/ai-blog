---
title: 'Prompt là một tiền tố, không phải một chuỗi văn bản'
description: 'Hóa đơn tiền điện toán tăng gấp ba, độ trễ tăng gấp đôi trong khi lưu lượng sử dụng không đổi. Thủ phạm chỉ là một dòng: một timestamp ngày giờ ở ngay đầu system prompt.'
pubDate: 2026-09-14
tags: ['ai-agents', 'llm', 'performance']
translationKey: 'agents-09-prompt-prefix'
sidebarTitle: '9 · Prompt & Cache'
order: 9
---

Ai đó vừa thêm một dòng có vẻ rất hữu ích vào system prompt:

```typescript
const system = `You are a coding assistant.
Current time: ${new Date().toISOString()}
Working directory: ${cwd}

${TOOL_GUIDANCE}
${PROJECT_INSTRUCTIONS}
...`;
```

Rất hợp lý. Mô hình hiển nhiên cần biết bây giờ là mấy giờ.

Ba tuần sau, hóa đơn tiền API tăng gấp ba, độ trễ p50 tăng gần gấp đôi, trong khi lưu lượng truy cập thì đi ngang. Không ai liên kết hai sự việc đó với nhau, bởi vì thay đổi mã nguồn chỉ vỏn vẹn một dòng và nó làm chính xác những gì nó mô tả.

Và đây là những gì dòng code đó thực sự gây ra:

> Bộ nhớ đệm prompt (Prompt caching) hoạt động theo cơ chế **khớp tiền tố (prefix match)**. Bất kỳ một byte nào bị thay đổi ở bất kỳ vị trí nào trong tiền tố đều sẽ vô hiệu hóa toàn bộ mọi thứ đứng sau nó.

Một timestamp ở ngay đầu system prompt sẽ thay đổi trên từng yêu cầu gửi đi. Do đó, tiền tố hoàn toàn khác nhau trên mọi yêu cầu. Kéo theo việc không có bất kỳ thứ gì đứng sau nó có thể được tái sử dụng trong cache — từ schema công cụ, hướng dẫn dự án, cho đến từng token của lịch sử cuộc trò chuyện. Bạn đang phải trả nguyên giá 100% cho toàn bộ ngữ cảnh khổng lồ đó, trên từng turn một, trong suốt phần đời còn lại của phiên làm việc.

## Thứ tự kết xuất (Render order) chính là bản thiết kế kiến trúc

Mọi thứ đứng trước điểm ngắt cache (cache breakpoint) cuối cùng đều được tái sử dụng nếu nó giống hệt từng byte so với yêu cầu trước đó. Vì vậy, câu hỏi bố cục không phải là "prompt nên nói những gì" mà là **"những gì sẽ thay đổi, và tần suất thay đổi là bao lâu?"** — và các nội dung hay biến động thuộc về vị trí phía sau điểm ngắt cache, nằm trong các tin nhắn `messages`, nơi mô hình vẫn đọc hiểu tốt y như vậy.

Sửa chữa ví dụ mở đầu chỉ là một thao tác di chuyển vị trí, chứ không cần viết lại từ đầu:

```typescript
// System: bất biến (frozen). Có thể lưu cache.
system: [{ type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } }],

// Các sự thật dễ biến động sẽ đi kèm với turn.
messages: [
  ...history,
  { role: 'user', content: [
    { type: 'text', text: `<context>time: ${now} · cwd: ${cwd}</context>` },
    { type: 'text', text: userInput },
  ]},
],
```

Cùng một thông tin đó vẫn đến được với mô hình. Nhưng tiền tố thì đã dừng việc xê dịch.

<figure class="dg">
  <img src="/diagrams/part09-prompt-prefix-cache.svg" alt="Thứ tự kết xuất là tools, sau đó đến system, rồi đến messages; điểm ngắt cache đặt sau phần ổn định, nên nội dung biến động phải nằm trong messages." loading="lazy" />
  <figcaption><strong>Chỉ một dòng code được di chuyển, toàn bộ hóa đơn thay đổi.</strong> Mô hình đọc timestamp từ messages cũng tốt y hệt — và tiền tố thì dừng việc rung lắc liên tục.</figcaption>
</figure>

## Chia thành các Section để thứ tự không còn là sự ngẫu nhiên

Nếu system prompt chỉ là một chuỗi nối template literal thông thường, việc bổ sung nội dung đồng nghĩa với việc sửa một chuỗi văn bản, và ai là người chỉnh sửa sau cùng sẽ quyết định thứ tự của nó. Cách đó ổn khi chỉ có một file duy nhất, nhưng sẽ trở thành thảm họa không thể kiểm soát khi có các plugin cùng tham gia đóng góp nội dung.

Hãy biến các section thành các đối tượng hạng nhất:

```typescript
interface PromptSection {
  name: string;
  order: number;
  /** Được gọi trên mỗi yêu cầu. BẮT BUỘC phải ổn định trừ khi có thứ gì thực sự thay đổi. */
  text(ctx: RequestContext): string;
}

class SystemPrompt {
  private sections = new Map<string, PromptSection>();

  section(s: PromptSection): () => void {
    this.sections.set(s.name, s);
    return () => this.sections.delete(s.name);
  }

  render(ctx: RequestContext): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((s) => s.text(ctx))
      .filter((t) => t.length > 0)     // các section rỗng sẽ biến mất hoàn toàn
      .join('\n\n');
  }
}
```

Ba chi tiết sau đây có sức ảnh hưởng lớn hơn nhiều so với vẻ ngoài của chúng:

**Sắp xếp theo `order`, phân xử hòa bằng `name`.** Thứ tự lặp của JavaScript Map là thứ tự chèn (insertion order), mà thứ tự chèn lại là thứ tự nạp của plugin, vốn có thể thay đổi chỉ vì ai đó đổi dòng trong file cấu hình. Điều đó sẽ âm thầm vô hiệu hóa mọi bộ nhớ đệm cache trong toàn hệ thống. Một phép sắp xếp tất định (deterministic sort) biến prompt được kết xuất thành một hàm thuần túy theo *nội dung*, chứ không phụ thuộc vào trình tự khởi động.

**Các section rỗng biến mất hoàn toàn.** Một section không có gì để nói sẽ trả về chuỗi `''` và không đóng góp gì cả — thậm chí không để lại một dòng trống nào. Nếu không, một tính năng bật tắt qua lại sẽ làm dịch chuyển từng byte của tất cả các phần phía sau nó.

**`section()` trả về một disposer.** Cùng một pattern với tool registry. Các thành phần đóng góp biết cách tự gỡ bỏ chính mình; đó chính là tinh thần của [Phần 13](/vi/blog/building-agents/plugins-and-capability-seams/).

Giờ đây, thứ tự là một thuộc tính được khai báo rõ ràng:

```typescript
const ORDER = { IDENTITY: 100, ENVIRONMENT: 200, TOOL_GUIDANCE: 300, PROJECT: 400, POLICY: 900 };
```

## Hãy đo lường, nếu không bạn chỉ đang đoán mò

Mỗi phản hồi từ nhà cung cấp đều cho bạn biết rõ liệu việc cache có thành công hay không. Không có lý do gì để phải suy đoán:

```typescript
const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = response.usage;
const total = input_tokens + cache_read_input_tokens;
const hitRate = total === 0 ? 0 : cache_read_input_tokens / total;
console.log(`cache ${(hitRate * 100).toFixed(1)}%  (read ${cache_read_input_tokens}, fresh ${input_tokens})`);
```

Hãy ghi log thông số này trên mọi yêu cầu. Bắn cảnh báo alert khi tỷ lệ trung bình của phiên sụt giảm. Con số duy nhất này là sự khác biệt giữa việc phát hiện ra một sự thụt lùi về cache trong một buổi chiều và việc phát hiện ra nó trên hóa đơn tài chính cuối quý.

Hình thái kỳ vọng: **yêu cầu đầu tiên trong phiên ~0%**, mọi yêu cầu sau đó **80–95%**. Nếu đến turn thứ 12 mà tỷ lệ chỉ đạt 20%, chắc chắn có thứ gì đó trong tiền tố của bạn đang bị dịch chuyển liên tục.

Các nghi phạm quen thuộc, xếp theo thứ tự ưu tiên kiểm tra:

| Triệu chứng | Nguyên nhân |
|---|---|
| Luôn luôn 0% | Tiền tố ngắn hơn độ dài tối thiểu để cache, hoặc chưa đặt breakpoint |
| Bất ngờ tụt về 0% ở một số turn | Tuần tự hóa không tất định — các key của object không được sắp xếp, duyệt một `Set` thành JSON |
| Suy giảm từ từ xuyên suốt phiên | Một section có nội dung dài thêm sau mỗi turn (ví dụ: đoạn tóm tắt lũy tiến nhét trong system prompt) |
| Về 0% sau khi bật/tắt một công cụ | Tập hợp công cụ thay đổi — các máy chủ [MCP](/vi/blog/building-agents/tools-from-outside-mcp/) kết nối hoặc ngắt kết nối giữa chừng |
| Chỉ bị 0% trên môi trường production | Một giá trị phụ thuộc môi trường lọt vào tiền tố: hostname, pod name, request id |

## Prompt thực sự được cấu thành từ những gì?

Rất đáng để kiểm toán lại điều này, bởi vì người ta hay chăm chút tối ưu phần mình tự viết mà bỏ quên phần to lớn hơn nhiều.

System prompt do bạn tự tay gõ thường **không** phải là chi phí cố định lớn nhất. Trong một agent thực tế, phần mở đầu của yêu cầu bị chi phối áp đảo bởi **schema của các công cụ** — 20 công cụ với đầy đủ phần mô tả và tài liệu tham số có thể dễ dàng ngốn vài nghìn token, và nó xuất hiện trên từng yêu cầu. Đó là lý do [Phần 3](/vi/blog/building-agents/tools-registry-schema-pipeline/) khẳng định rằng *mô tả công cụ chính là code*: nó là một mục chi phí vĩnh viễn trên hóa đơn.

Điều đó biến số lượng công cụ trở thành một quyết định thiết kế prompt. Hai công cụ làm những việc gần như tương tự nhau sẽ khiến bạn phải trả chi phí schema cộng dồn của cả hai mãi mãi, *đồng thời* khiến mô hình do dự phân vân giữa chúng. Việc gộp chúng lại vừa giúp tiết kiệm token, vừa nâng cao độ chính xác của mô hình ngay tức thì.

## Chỉ thị ở giữa cuộc hội thoại (Mid-conversation instructions)

Đến một lúc nào đó, bạn sẽ muốn thay đổi quy tắc ở giữa phiên làm việc — chuyển sang chế độ hạn chế (restricted mode), thêm một chỉ thị từ người vận hành (operator), hoặc thông báo rằng người dùng đã chuyển dự án.

Hành động theo phản xạ tự nhiên là chỉnh sửa lại chuỗi `system` và gửi lại. Điều đó sẽ vô hiệu hóa toàn bộ tiền tố cache, đúng vào turn đắt đỏ nhất có thể, bởi vì lúc này lịch sử cuộc hội thoại đã rất dài.

Trên các mô hình có hỗ trợ, hãy chèn thêm một tin nhắn có vai trò `system` vào mảng `messages`:

```typescript
messages: [
  ...history,
  { role: 'user', content: userInput },
  { role: 'system', content: 'Chế độ Read-only: đề xuất thay đổi, không được ghi file.' },
],
```

Nó sẽ nằm ở cuối tiền tố, vì vậy mọi thứ trước nó vẫn được giữ nguyên trong cache. Nó mang thẩm quyền của người vận hành thay vì đến dưới dạng văn bản của người dùng — điều này cực kỳ quan trọng đối với [Phần 23](/vi/blog/building-agents/what-it-reads-is-not-an-order/), nơi sự phân biệt giữa *chỉ thị (instruction)* và *nội dung dữ liệu (content)* là toàn bộ mô hình bảo mật.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness lắp ráp prompt thông qua một cơ chế waterfall mà các plugin có thể hook vào, và có hai quy ước rất đáng để học hỏi ngay:

**Các hằng số thứ tự được đặt tên và chia sẻ dùng chung.** Dùng `getSectionOrder('TOOL_SUBAGENT')` thay vì một con số bí ẩn (magic number), để một plugin có thể tự định vị vị trí của mình tương quan với các plugin khác mà không cần biết nội bộ bên trong của chúng.

**Mỗi package README đều bắt buộc phải ghi rõ "Hiệu ứng KV Cache".** Một mục bắt buộc phải có nằm ngay cạnh phần mô tả tính năng, nêu rõ bằng ngôn ngữ bình dân tính năng đó gây tốn kém gì cho bộ nhớ đệm cache: *tiền tố ổn định, ghi một lần* hoặc *ghi thêm nối tiếp theo turn* hoặc *vô hiệu hóa cache khi bật/tắt*.

Quy ước thứ hai là thứ tôi khuyên bạn nên áp dụng đầu tiên. Nó biến tác động bộ nhớ đệm thành một thứ bạn phải tuyên bố ngay từ khâu thiết kế thay vì chỉ tình cờ phát hiện ra qua một biểu đồ số liệu, và nó giúp một reviewer có thể phát hiện sự thụt lùi về cache chỉ bằng cách đọc một đoạn văn ngắn.

## Cái bẫy thường gặp

Cái bẫy là nghĩ rằng caching là việc của nhà cung cấp LLM.

Nó có vỏ bọc của một tính năng hạ tầng — một thứ diễn ra ở phía bên kia đầu cầu mạng, nơi bạn chỉ việc bật lên rồi quên nó đi. Không hề. Nó là **một đặc tính thuộc về bố cục byte dữ liệu mà chính bạn gửi đi**, và bạn kiểm soát bố cục đó 100%. Nhà cung cấp chỉ làm một việc đơn giản là so khớp tiền tố byte trên những gì bạn đưa cho họ.

Điều đó đồng nghĩa với việc toàn bộ bề mặt tối ưu hóa nằm hoàn toàn trong mã nguồn của bạn: những gì đưa vào prompt, theo thứ tự nào, và tần suất thay đổi của từng phần ra sao. Một đội ngũ kỹ thuật coi caching là chuyện của hạ tầng sẽ liên tục nhét các giá trị biến động vào đầu prompt, và từng giá trị đó sẽ bắt bạn phải trả giá bằng toàn bộ cuộc hội thoại.

## Tiếp theo

**[Phần 10 — Ngân sách ngữ cảnh (The Context Budget)](/vi/blog/building-agents/the-context-budget/)**. Một lệnh `grep` trả về 200KB và cuộc hội thoại đột ngột lăn ra chết. Ngữ cảnh bị tiêu thụ bởi *kết quả của công cụ*, chứ không phải bởi những lời lẽ do mô hình tự sinh ra — điều đó có nghĩa là nơi quản lý nó phải là nơi các kết quả được sinh ra, chứ không phải nơi cửa sổ ngữ cảnh sắp sửa cạn kiệt.
