---
title: 'Gọi công cụ bằng mã (Code Mode)'
description: 'Mười hai lệnh gọi công cụ liên tiếp là mười hai lượt round-trip, và bạn phải trả tiền cho toàn bộ cuộc hội thoại mỗi lần như vậy. Có một giao thức gọi công cụ thứ hai hiệu quả hơn.'
pubDate: 2026-09-12
tags: ['ai-agents', 'tools', 'llm']
translationKey: 'agents-07-ptc'
sidebarTitle: '7 · Chế độ Code'
order: 7
---

Hãy yêu cầu một agent đổi tên một ký hiệu (symbol) trên toàn bộ codebase: grep tìm kiếm, đọc 9 file, chỉnh sửa 9 file, chạy bộ kiểm thử test. Mười bốn step, mười bốn yêu cầu gửi đến mô hình — và bởi vì API vốn dĩ là stateless (không lưu trạng thái), mỗi yêu cầu đó đều phải cõng theo toàn bộ cuộc hội thoại từ đầu đến giờ, bao gồm toàn bộ nội dung của từng file đã đọc. Đến step 14, bạn đang gửi lại nội dung của cả tá file chỉ để hỏi một câu hỏi mà câu trả lời hiển nhiên là "hãy chạy bộ test".

Công việc này hoàn toàn mang tính máy móc. Mô hình đã biết rõ kế hoạch ngay từ step 1, nhưng phải tiêu tốn 14 lượt round-trip chỉ để thực thi một vòng lặp mà lẽ ra nó có thể tự viết thành mã.

## Giao thức thứ hai

> Function calling hỏi *"công cụ nào tiếp theo?"* từng bước một. Gọi công cụ bằng mã (Programmatic tool calling - PTC) hỏi *"hãy viết chương trình giải quyết việc đó."*

Cùng các công cụ đó, cùng pipeline đó, nhưng khác biệt ở tầng truyền tải (transport). Thay vì cung cấp JSON schema cho từng công cụ, bạn hiển thị các công cụ dưới dạng một **SDK** và trao cho mô hình một công cụ duy nhất — `run_code` — để thực thi đoạn chương trình được viết dựa trên SDK đó.

Mười bốn step rút gọn lại chỉ còn đúng một:

```typescript
// Mô hình viết đoạn mã này. Runtime của bạn thực thi nó.
const hits = await tools.grep({ pattern: 'oldName', path: 'src/' });
const files = [...new Set(hits.map((h) => h.file))];

for (const file of files) {
  const src = await tools.read({ path: file });
  await tools.write({ path: file, content: src.replaceAll('oldName', 'newName') });
}

return await tools.run_command({ command: 'npm test' });
```

Một yêu cầu gửi đi, một đoạn mã chương trình trả về, một kết quả nhận lại. Nội dung trung gian của các file không bao giờ phải đi vào ngữ cảnh cuộc hội thoại — chúng tồn tại dưới dạng các biến bên trong một tiến trình, đó chính xác là nơi chúng thuộc về.

Cơ chế này được gọi là **PTC** (programmatic tool calling), hay "code mode". Đây không phải là sự thay thế hoàn toàn cho function calling. Nó là một chế độ thứ hai song hành, và việc hiểu rõ khi nào nên dùng chế độ nào mới chính là kỹ năng thực thụ.

<figure class="dg">
  <img src="/diagrams/part07-ptc-transport.svg" alt="Function calling tiêu tốn một lượt round-trip cho mỗi lệnh gọi công cụ và gửi lại toàn bộ cuộc hội thoại mỗi lần; chương trình thực hiện một lượt round-trip duy nhất và giữ các kết quả trung gian dưới dạng biến." loading="lazy" />
  <figcaption><strong>PTC thay đổi phương thức truyền tải, chứ không thay đổi ranh giới tin cậy.</strong> Một công cụ cần được phê duyệt thì vẫn cần được phê duyệt y như vậy khi một vòng lặp do mô hình viết gọi nó bốn mươi lần.</figcaption>
</figure>

## Cái giá phải trả

Lợi ích tiết kiệm token là có thật, và cái giá đi kèm cũng rất rõ ràng. Bốn điều sau đây sẽ trở nên phức tạp hơn.

**Bạn cần một runtime thực thi.** Cần có một môi trường để chạy mã do mô hình viết với quyền truy cập vào các công cụ của bạn. DeepSeek Harness đi kèm với một runtime chạy trên worker thread với heap bộ nhớ tách biệt, môi trường trống rỗng, hỗ trợ hủy bỏ, và khả năng cưỡng chế dừng worker. Đó là sự cô lập hữu ích, nhưng tuyệt đối **không phải là một ranh giới bảo mật hoàn hảo**: chương trình vẫn có thể import các module có sẵn của Node, tiếp cận những gì tiến trình host có thể tiếp cận, sinh tiến trình con (spawn processes), và để các tiến trình đó sống sót sau khi worker đã chết. Hãy coi nó tương đương với việc thực thi mã tin cậy ngang hàng với Bash, hoặc phải đặt toàn bộ harness phía sau một sandbox cấp hệ điều hành hoặc ranh giới thực thi từ xa.

**Việc gỡ lỗi (debugging) lùi xuống một bậc sâu hơn.** Một lệnh gọi hàm (function call) thất bại có tên hàm và các đối số rõ ràng. Một chương trình thất bại sẽ ném ra một stack trace, và stack frame thú vị nhất lại nằm bên trong đoạn mã mà mô hình vừa viết ra cách đây 30 giây mà bạn chưa từng nhìn thấy trước đó. Hãy luôn luôn ghi log đoạn chương trình đó. Bắt buộc. Đó là cổ vật duy nhất giải thích chuyện gì đã xảy ra.

**Thất bại một phần (partial failure) xuất hiện.** Ở bước thứ 9 trong vòng lặp của mô hình, ngoại lệ bị ném ra. Sáu file đã bị ghi đè nội dung. Function calling mang lại cho bạn một ranh giới sạch sẽ sau mỗi lần gọi; còn một chương trình để lại bất kỳ trạng thái dở dang nào mà nó đã kịp chạm tới. Các công cụ của bạn phải an toàn khi bị áp dụng dở dang, hoặc chương trình phải được viết để có thể tiếp tục chạy lại (resumable) — và mô hình sẽ không tự làm điều đó trừ khi bạn chỉ thị rõ ràng cho nó.

**Các thông báo lỗi mang ngữ nghĩa khác biệt.** Việc `read` bị lỗi bên trong một vòng lặp sẽ xuất hiện dưới dạng một runtime exception, chứ không phải một kết quả công cụ (tool result). Bạn cần quyết định xem chương trình nên bắt lỗi và tiếp tục hay dừng lại chết luôn — và phải tuyên bố rõ điều đó trong tài liệu của SDK, bởi vì tài liệu đó chính là prompt cho mô hình.

## Các lệnh gọi lồng nhau vẫn phải đi qua pipeline

Đây là phần rất dễ làm sai một cách tai hại.

Khi chương trình của mô hình gọi `tools.run_command(...)`, đó **không** phải là một lệnh gọi hàm trực tiếp thông thường. Nó bắt buộc phải được điều phối ngược trở lại thông qua cùng một pipeline từ [Phần 3](/vi/blog/building-agents/tools-registry-schema-pipeline/) — các pre hook, phê duyệt của người dùng, sandbox kiểm soát, thời hạn timeout, ghi log, và các post hook.

> **PTC thay đổi phương thức truyền tải, chứ không thay đổi ranh giới tin cậy.** Một công cụ yêu cầu phê duyệt thì vẫn yêu cầu phê duyệt y hệt như vậy khi một chương trình do mô hình viết gọi nó trong một vòng lặp. Thậm chí còn cần nghiêm ngặt hơn.

```typescript
// Bên trong sandbox: mỗi lệnh gọi tools.* là một cầu nối, không phải hàm cục bộ.
function makeSdk(dispatch: (name: string, input: unknown) => Promise<unknown>) {
  return new Proxy({} as Record<string, Function>, {
    get: (_t, name: string) => (input: unknown) => dispatch(name, input),
  });
}
```

Hàm `dispatch` vượt qua ranh giới của sandbox và cập bến tại `invoke()` — chính là hàm mà function calling sử dụng. Nếu bạn bỏ qua nó "vì lý do hiệu năng", bạn vừa tự đục một lỗ thủng xuyên qua mọi cơ chế kiểm soát an toàn của mình, mở toang cho bất kỳ chương trình nào mà mô hình viết ra.

Hook phê duyệt trở nên rất thú vị ở điểm này, và bạn phải chủ động thiết kế cho nó: một vòng lặp qua 40 file đồng nghĩa với 40 lời nhắc xác nhận từ người dùng. Các lựa chọn bao gồm: gom nhóm câu hỏi thành lô (*"chạy `write` trên 40 file này nhé?"*), giới hạn phạm vi phê duyệt cho toàn bộ chương trình thay vì từng lệnh gọi riêng lẻ, hoặc từ chối chế độ PTC đối với các công cụ yêu cầu xác nhận theo từng lệnh gọi. Tất cả các phương án đều có lý lẽ riêng; nhưng không chọn phương án nào thì chắc chắn là sai lầm.

## Sinh mã SDK tự động

SDK được sinh ra từ chính các định nghĩa công cụ giống như các JSON schema. Một nguồn sự thật duy nhất, hai cách kết xuất khác nhau — nếu không, chế độ nào bạn ít dùng hơn sẽ bị trôi dạt (drift) và bắt đầu nói dối mô hình.

```typescript
function renderSdk(tools: ToolDefinition[]): string {
  return [
    '// Các công cụ khả dụng. Tất cả đều là async. Lỗi throw sẽ truyền về cho caller.',
    'declare const tools: {',
    ...tools.flatMap((t) => [
      `  /** ${t.description} */`,
      `  ${t.name}(input: ${tsTypeFromSchema(t.inputSchema)}): Promise<${t.returnType ?? 'string'}>;`,
    ]),
    '};',
  ].join('\n');
}
```

Hai yếu tố tạo nên sự khác biệt giữa một SDK được mô hình sử dụng mượt mà và một SDK khiến nó lúng túng:

**Kiểu trả về có định kiểu rõ ràng (Typed returns).** Trong function calling, các kết quả là chuỗi văn bản — mô hình tự đọc chúng. Trong PTC, kết quả là các *giá trị* mà chương trình có thể thao tác. Việc `grep` trả về `{file, line, text}[]` giúp mô hình viết thẳng `hits.map(h => h.file)`. Còn trả về một chuỗi văn bản đã định dạng sẽ ép nó phải tự viết regex bóc tách chuỗi mà chính nó vừa tạo ra bộ phân tích cú pháp, rất vụng về và dễ lỗi.

**Ngữ nghĩa lỗi trung thực trong doc comment.** Lệnh `read` trên một file không tồn tại sẽ throw ngoại lệ hay trả về null? Mô hình không thể thử nghiệm để biết. Dù bạn chọn cách nào, hãy nói thẳng trong comment, bởi vì comment chính là đặc tả kỹ thuật.

## Khi nào nên dùng chế độ nào?

| Tiêu chí | Function calling | PTC (Code mode) |
|---|---|---|
| Ít lệnh gọi, mỗi lệnh phụ thuộc vào kết quả trước | ✅ Tối ưu | ✗ Chi phí thừa thãi |
| Nhiều lệnh gọi, cấu trúc công việc biết trước | ✗ Quá nhiều round trip | ✅ Tối ưu vượt trội |
| Kết quả trung gian có dung lượng lớn | ✗ Toàn bộ tràn vào context | ✅ Lưu trữ trong biến |
| Cần con người phê duyệt từng lệnh gọi | ✅ Tự nhiên, dễ quản lý | ⚠️ Cần giải pháp gom lô |
| Mô hình cần suy ngẫm sau mỗi kết quả | ✅ Đúng thế mạnh | ✗ Đã cam kết kế hoạch |
| Mô hình cần biến đổi, lọc dữ liệu | ✗ Bất tiện | ✅ Đầy đủ sức mạnh ngôn ngữ |

Câu hỏi mang tính quyết định là: **mô hình có cần phải tư duy giữa các lệnh gọi hay không?** Nếu có, hãy dùng function calling — sự tư duy suy luận đó chính là giá trị cốt lõi. Nếu nó chỉ đang thực thi một kế hoạch đã có sẵn, hãy dùng PTC, lúc này các lượt round-trip chỉ là chi phí hao phí thuần túy.

Hầu hết các hệ thống hoàn chỉnh đều muốn cả hai, được lựa chọn linh hoạt theo từng yêu cầu. Cấu hình `mode: 'native' | 'ptc' | 'both'`, mặc định là native, và cung cấp PTC khi tập công cụ và tác vụ thực sự phù hợp.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness cung cấp tính năng này như một chế độ `ToolRuntime` hạng nhất, với các quyết định đã đứng vững qua thực tế vận hành:

**Một tool registry, hai cách trình bày.** Cùng một `ToolDefinition` vừa sinh ra JSON schema ở chế độ native, vừa sinh ra SDK ở chế độ PTC. Không có registry thứ hai, nên không bao giờ có độ lệch (drift).

**Sub-dispatch không phải là đường tắt.** Mọi lệnh gọi `tools.*` từ bên trong chương trình đều đi vào pipeline tiêu chuẩn. Sandbox không nắm giữ bất kỳ handle đặc quyền nào.

**Giá trị trả về có định kiểu là cải tiến có chủ đích.** Phiên bản đầu tiên trả về chuỗi văn bản thuần và nó vẫn chạy được, theo nghĩa là mô hình vẫn xoay xở được. Nhưng việc định kiểu kiểu trả về mới là thứ giúp các chương trình dứt điểm hoàn toàn việc tự viết bộ phân tích regex cho dữ liệu mà hệ thống vừa mới tuần tự hóa xong.

**Điều phối song song bên trong một chương trình.** Một chương trình thực hiện `await Promise.all([...])` qua 10 lệnh đọc file có thể chạy gối đầu các lệnh gọi thông qua một pool theo từng lượt chạy. Nó tái sử dụng cơ chế phân loại `parallel` so với `exclusive` của native và bản hợp đồng commit kết quả có thứ tự, trong khi `maxParallelSubCalls` cung cấp một giới hạn riêng biệt dành riêng cho PTC.

## Cái bẫy thường gặp

Cái bẫy là ảo tưởng rằng PTC là một bản nâng cấp toàn diện thay thế hoàn toàn function calling.

Mức tiết kiệm token là vô cùng ấn tượng trong các bản demo — tác vụ đổi tên hàng loạt, biến đổi dữ liệu hàng loạt — và người ta rất dễ vội vàng kết luận rằng function calling là một nỗ lực sơ khai lạc hậu. Hoàn toàn không phải vậy. Function calling tồn tại bởi vì **việc mô hình phản ứng linh hoạt với từng kết quả đo được thường là toàn bộ giá trị của một agent.** Một phiên gỡ lỗi debug không phải là một chương trình; nó là một chuỗi các quyết định mà mỗi quyết định đều phụ thuộc vào những gì bước trước đó vừa phát hiện ra. Ép điều đó vào PTC và bạn sẽ nhận lại một mô hình đoán mò một kế hoạch trước khi nó kịp có thông tin để lập kế hoạch.

Hãy dùng PTC ở nơi công việc mang tính cơ học. Giữ function calling ở nơi công việc đòi hỏi tư duy suy luận. Chế độ thực thi là sự lựa chọn theo từng tác vụ, không phải là một cuộc di cư một đi không trở lại.

## Tiếp theo

**[Phần 8 — Nhật ký phiên (The Session Log)](/vi/blog/building-agents/the-session-log/)**. Mọi thứ cho đến lúc này đều nằm trong một mảng có tên `messages`. Khởi động lại tiến trình và mọi thứ bốc hơi: không thể resume, không thể fork nhánh, không có bản ghi vết, không có cách nào trả lời agent đã làm gì ngày hôm qua. Đây là quyết định đắt đỏ nhất trong toàn bộ hệ thống, và thời điểm rẻ nhất để thiết kế nó là ngay bây giờ.
