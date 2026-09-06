---
title: 'Bản chất của AI Agent là một vòng lặp While'
description: 'Bóc tách một agent về cơ chế chịu tải cốt lõi: gửi yêu cầu đến mô hình, thực thi các lệnh gọi công cụ, trả về kết quả quan sát và lặp lại.'
pubDate: 2026-09-06
tags: ['ai-agents', 'llm', 'architecture']
translationKey: 'agents-01-while-loop'
sidebarTitle: '1 · Vòng lặp While'
order: 1
---

Các sơ đồ về Agent thường bắt đầu bằng các ô vuông dán nhãn **Planning** (Lập kế hoạch), **Memory** (Bộ nhớ), và **Reflection** (Phản tư). Những chiếc hộp đó mô tả các hành vi hữu ích, nhưng chúng che giấu cơ chế nền tảng giúp tất cả những điều đó có thể hoạt động được.

Ở tầng thực thi, một agent nhỏ gọn hơn nhiều:

> Một agent hỏi mô hình xem cần làm gì tiếp theo, thực thi các tác động (effects) được yêu cầu, trả lại các kết quả quan sát (observations), và lặp lại cho đến khi mô hình dừng yêu cầu tác động.

DeepSeek Harness có hàng nghìn dòng code bao quanh vòng lặp đó, bởi vì các hệ thống production cần tính bền vững (durability), khả năng hủy bỏ (cancellation), chính sách kiểm soát (policy), xử lý luồng dữ liệu (streaming), phân định phạm vi (scoping) và phục hồi sự cố (recovery). Nhưng chuyển động trung tâm thì vẫn hoàn toàn nhận diện được.

## Một DeepSeek agent tinh gọn có chủ đích

Chương trình sau đây sử dụng API chat-completions tương thích OpenAI của DeepSeek. Đây là một ví dụ mang tính giảng dạy, không phải là một shell agent an toàn: `run_command` có thể thực thi bất cứ điều gì mà mô hình yêu cầu, với toàn bộ quyền hạn của tiến trình hiện tại.

```bash
npm install openai
```

```typescript
import OpenAI from 'openai';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
});

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Đọc nội dung một file UTF-8.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Chạy một lệnh shell trong workspace hiện tại.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

async function execute(name: string, raw: string): Promise<string> {
  const args = JSON.parse(raw) as Record<string, string>;
  if (name === 'read_file') return readFile(args.path, 'utf8');
  if (name === 'run_command') {
    const { stdout, stderr } = await execAsync(args.command);
    return stdout + stderr;
  }
  throw new Error(`unknown tool: ${name}`);
}

async function run(task: string) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: task },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      tools,
    });
    const assistant = response.choices[0]?.message;
    if (!assistant) throw new Error('model returned no message');

    messages.push(assistant);
    if (!assistant.tool_calls?.length) break;

    for (const call of assistant.tool_calls) {
      let content: string;
      try {
        content = await execute(call.function.name, call.function.arguments);
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  console.log(messages.at(-1)?.content);
}

await run(process.argv.slice(2).join(' '));
```

<figure class="dg">
  <img src="/diagrams/part01-while-loop-vi.svg" alt="Vòng lặp agent cốt lõi: yêu cầu mô hình, các lệnh gọi công cụ, thực thi công cụ, kết quả quan sát, sau đó tiếp tục yêu cầu hoặc dừng lại." loading="lazy" />
  <figcaption><strong>Vòng lặp tối giản không thể rút gọn thêm.</strong> Mọi thứ khác trong loạt bài này hoặc là để bảo vệ chu trình này, cung cấp ngữ cảnh tốt hơn cho nó, hoặc làm cho các tác động của nó có thể quan sát được.</figcaption>
</figure>

## Bốn sự thật mà vòng lặp bắt buộc phải bảo toàn

Ví dụ trên rất ngắn gọn, nhưng bốn quyết định trong đó đã mang tính chịu lực cốt lõi.

| Sự thật (Fact) | Điều gì sẽ hỏng nếu bị mất đi |
|---|---|
| Tin nhắn phản hồi đầy đủ của assistant | Nội dung suy luận (reasoning content) và danh tính lệnh gọi công cụ có thể biến mất trong yêu cầu tiếp theo. |
| Mọi ID của lệnh gọi công cụ | Kết quả sẽ không còn đối chiếu được với lệnh gọi tương ứng đã yêu cầu nó. |
| Thứ tự do mô hình trả về | Việc thực thi song song có thể làm kết quả quan sát trả về sai thứ tự so với các lệnh gọi. |
| Thất bại cũng là một quan sát | Một câu lệnh lỗi sẽ làm sập toàn bộ agent thay vì cung cấp bằng chứng để mô hình phản ứng và điều chỉnh. |

DeepSeek Harness biến những yếu tố này thành cấu trúc kiến trúc thay vì chỉ dựa vào quy ước. Phản hồi của assistant trở thành các khối nội dung chuẩn hoá (canonical content blocks); các lệnh gọi công cụ và kết quả được ghép cặp bằng các ID bền vững; các lệnh gọi an toàn song song có thể chạy đan xen nhưng kết quả luôn được ghi nhận theo đúng thứ tự của mô hình; và các lỗi công cụ dự kiến sẽ trả về kết quả `isError` thay vì thoát văng khỏi vòng lặp.

Sự phân biệt giữa **lỗi tác động (effect failure)** và **lỗi khung điều khiển (harness failure)** là tối quan trọng. Một câu lệnh thoát với mã lỗi khác 0 thường là một quan sát để mô hình tiếp nhận. Còn một session log bị hỏng hay một plugin chính sách bị lỗi lại là sự cố hạ tầng và phải đóng lượt tương tác một cách dứt khoát kèm cảnh báo rõ ràng. Coi cả hai đều là chuỗi văn bản thông thường sẽ che giấu sự cố; coi cả hai đều là ngoại lệ (exception) sẽ làm agent trở nên mong manh dễ vỡ.

## Một agent là gì — và không phải là gì

Một định nghĩa vận hành hữu ích là:

> Một agent bao gồm một mô hình (model), một vòng lặp điều khiển (control loop), và thẩm quyền tạo ra các tác động (effects).

- Một mô hình không có vòng lặp chỉ là một trợ lý hỏi-đáp đơn lẻ (one-shot assistant).
- Một vòng lặp không có tác động có thể suy luận và sinh văn bản, nhưng không thể thay đổi môi trường xung quanh.
- Các tác động không có vòng lặp do mô hình điều hướng chỉ là tự động hóa thông thường.

Planning, memory, reflection, retrieval, và delegation không hề vắng mặt trong định nghĩa này. Chúng là các cơ chế cấp cao hơn nhằm thay đổi những gì yêu cầu tiếp theo nhìn thấy hoặc những tác động nào vòng lặp có thể chọn.

## Nơi mà vòng lặp nhỏ bé này sụp đổ

Đoạn mã ví dụ sẽ thất bại gần như ngay lập tức trong môi trường thực tế:

1. `messages` biến mất khi tiến trình kết thúc, và một luồng dữ liệu stream bị đứt quãng có thể không để lại bản ghi đáng tin cậy nào về những gì người dùng đã thấy.
2. Kết quả trả về quá lớn từ một lệnh có thể nuốt trọn toàn bộ cửa sổ ngữ cảnh còn lại.
3. Dữ liệu đầu vào mới không thể điều hướng an toàn cho một yêu cầu đang xử lý dở.
4. Không có ranh giới chính sách nào giữa một tác động được yêu cầu và quá trình thực thi nó.
5. Mô hình có thể lặp đi lặp lại một hành động hợp lệ nhưng hoàn toàn vô ích mãi mãi.
6. Các lệnh gọi hệ thống tệp và tiến trình bị gắn chặt vào máy cục bộ.

<figure class="dg">
  <img src="/diagrams/part01-failure-points-vi.svg" alt="Các điểm lỗi xung quanh vòng lặp agent cốt lõi: lưu trữ bền vững, ngữ cảnh, điều hướng, quyền hạn, lặp vô tận, cô lập thực thi và phục hồi." loading="lazy" />
  <figcaption><strong>Kỹ thuật cấp production bao bọc lấy vòng lặp.</strong> Nó không được phép làm lu mờ bất biến mà mỗi tầng đang bảo vệ.</figcaption>
</figure>

## Những gì DeepSeek Harness gìn giữ

DeepSeek Harness không thay thế vòng lặp bằng một bộ lập kế hoạch (planner). `ReactLoopAgent` cụ thể của nó vẫn thực hiện cùng một chu trình:

1. claim (nhận quyền xử lý) đầu vào tại ranh giới turn hoặc step;
2. lắp ráp các phần prompt và schema của các công cụ khả dụng;
3. trích xuất lịch sử mô hình từ session log;
4. stream một yêu cầu mô hình thành các canonical blocks;
5. ghi thêm tin nhắn của assistant vào log;
6. thực thi các công cụ được yêu cầu thông qua pipeline dùng chung;
7. ghi thêm các kết quả đã được sắp xếp thứ tự và tiếp tục yêu cầu mô hình hoặc đóng turn.

Sự khác biệt ở cấp production là mọi ranh giới đều tường minh và có thể quan sát được.

<figure class="dg">
  <img src="/diagrams/part01-grownup-loop-vi.svg" alt="Vòng lặp nhỏ giữa mô hình và công cụ được bao quanh bởi inbox, session log, lắp ráp prompt, chính sách và các adapter streaming." loading="lazy" />
  <figcaption><strong>Vòng lặp được bao bọc, chứ không bị loại bỏ.</strong> Các tầng bao bọc biến một đoạn script thú vị thành một hệ thống có thể phục hồi và quản trị được.</figcaption>
</figure>

## Tiếp theo

**[Phần 2 — Turn và Step: Khi nào agent thực sự xong việc?](/vi/blog/building-agents/turn-and-step/)** Việc mô hình hoàn thành một phản hồi không đồng nghĩa với việc hệ thống đã hết việc cần làm.
