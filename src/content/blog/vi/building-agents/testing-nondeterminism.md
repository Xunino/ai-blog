---
title: 'Kiểm thử một hệ thống mỗi lần trả lời một kiểu'
description: 'Cùng một đầu vào, kết quả khác nhau mỗi lần, và mỗi lần chạy đều tốn tiền. Ghi âm một lần, phát lại không cần API key — và hãy assert trên các sự kiện, không assert trên văn xuôi.'
pubDate: 2026-10-02
tags: ['ai-agents', 'testing', 'architecture']
translationKey: 'agents-27-testing'
sidebarTitle: '27 · Kiểm thử (Testing)'
order: 27
---

Hãy viết một bài kiểm thử test cho agent.

Cùng một câu prompt, nhưng mỗi lần chạy lại cho ra một cách diễn đạt hoàn toàn khác nhau. Mỗi lần chạy đều tiêu tốn tiền bạc và mất tới hai mươi giây. Assert trên chuỗi văn bản thì bài test sẽ gãy chỉ vì một từ đồng nghĩa. Không assert trên thứ gì thì bài test chẳng kiểm chứng được điều gì.

Hầu hết các đội ngũ kỹ thuật giải quyết bài toán này bằng cách chỉ test các mảnh ghép đơn lẻ — phép chiếu projection, pipeline công cụ, hộp thư đến inbox — và xuất xưởng toàn bộ hệ thống mà không hề có bài test tích hợp nào. Điều đó đồng nghĩa với việc mọi lỗi bug phát sinh từ *sự tương tác qua lại* giữa các mảnh ghép đều sẽ hiên ngang bước thẳng lên môi trường production, và đó mới chính là nơi các lỗi bug ly kỳ nhất sinh sống.

## Hãy assert trên các Sự kiện, không assert trên Văn xuôi

Con đường vượt qua nghịch lý này là thay đổi đối tượng kiểm tra:

> Lời lẽ của mô hình không phải là kết quả đầu ra của bạn. **Chuỗi các sự kiện mà hệ thống của bạn sinh ra** mới chính là kết quả đầu ra — và chuỗi đó mang tính tất định tuyệt đối khi nhận cùng các phản hồi từ mô hình.

Cùng một prompt, hai lần chạy khác nhau. Lời văn có thể khác biệt. Nhưng cấu trúc này thì không:

```text
turn/start
step/start
user/message
assistant/message      gọi công cụ: read_file
tool/call              read_file { path: "src/index.ts" }
tool/result            ok
step/end
step/start
assistant/message      văn bản trả lời
step/end
turn/end               completed
```

Đó là một bản hợp đồng mà bạn hoàn toàn có thể assert kiểm tra: nó đã đọc file trước khi trả lời, nó tiêu tốn đúng hai step, turn kết thúc với trạng thái `completed`, và không có công cụ nào gặp lỗi. Tất cả những thứ bạn thực sự quan tâm — và không có thứ nào trong số đó phụ thuộc vào việc mô hình diễn đạt câu cú ra sao.

<figure class="dg">
  <img src="/diagrams/part27-testing-nondeterminism.svg" alt="Một bộ ghi recorder tại ranh giới LLM chụp lại phản hồi thực tế một lần; mọi bài test sau đó phát lại chúng mà không cần API key và assert trên chuỗi sự kiện." loading="lazy" />
  <figcaption><strong>Bộ ghi âm cũng đồng thời là một công cụ phát hiện độ ổn định của cache.</strong> Nếu một trường biến động ép bạn phải nới rộng key, bạn vừa tìm ra một kẻ hủy diệt tiền tố cache.</figcaption>
</figure>

## Ghi âm một lần, phát lại mãi mãi

Hãy đặt một bộ ghi âm (recorder) tại [ranh giới LLM seam](/vi/blog/building-agents/the-llm-layer/) từ Phần 5. Việc ghi âm và phát lại là hai provider cùng đứng phía sau một interface duy nhất:

```typescript
export function recordingAdapter(inner: LlmAdapter, cassette: string): LlmAdapter {
  const entries: Recorded[] = [];
  return {
    provider: inner.provider,
    models: () => inner.models(),
    async *stream(req, signal) {
      const chunks: StreamChunk[] = [];
      for await (const c of inner.stream(req, signal)) { chunks.push(c); yield c; }
      entries.push({ key: requestKey(req), chunks });
      writeFileSync(cassette, JSON.stringify(entries, null, 2));
    },
  };
}

export function replayAdapter(cassette: string): LlmAdapter {
  const entries: Recorded[] = JSON.parse(readFileSync(cassette, 'utf8'));
  const used = new Set<number>();
  return {
    provider: 'replay',
    models: async () => STATIC_MODELS,
    async *stream(req) {
      const i = entries.findIndex((e, i) => !used.has(i) && e.key === requestKey(req));
      if (i === -1) throw new Error(`Không có bản ghi nào cho yêu cầu:\n${requestKey(req)}`);
      used.add(i);
      yield* entries[i].chunks;
    },
  };
}
```

Hàm `requestKey` là toàn bộ linh hồn của thiết kế. Nếu quá nghiêm ngặt — băm mã hash toàn bộ yêu cầu — thì bất kỳ một chỉnh sửa nhỏ nào trong prompt cũng sẽ vô hiệu hóa toàn bộ các cuộn băng cassette. Nếu quá lỏng lẻo thì bạn sẽ phát lại nhầm một phản hồi khác. Trong thực tế: chỉ gồm danh sách tin nhắn và tên các công cụ, loại trừ triệt để các trường hay biến động.

Bản thân danh sách loại trừ đó đã là một phát hiện quý giá. Nếu timestamp hoặc ID xuất hiện trong yêu cầu theo cách làm thay đổi key, bạn vừa phát hiện ra một [kẻ phá hủy bộ nhớ đệm cache](/vi/blog/building-agents/the-prompt-prefix/) — bộ ghi âm là một công cụ kiểm tra độ ổn định của cache mà bạn nhận được hoàn toàn miễn phí.

Khi đó, bài test sẽ trở nên bình thường, chạy cực nhanh trong vài mili-giây và hoàn toàn miễn phí:

```typescript
test('đọc file trước khi trả lời câu hỏi', async () => {
  const agent = await createAgent({ llm: replayAdapter('cassettes/read-file.json') });
  await agent.run('src/index.ts xuất khẩu những gì?');

  expect(kinds(agent.log)).toEqual([
    'turn/start', 'step/start', 'user/message', 'assistant/message',
    'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ]);
  expect(toolCalls(agent.log)).toMatchObject([{ name: 'read_file' }]);
});
```

Không cần API key, chạy trong nháy mắt, và nó chỉ thất bại khi *hệ thống* của bạn thay đổi chứ không phải do tâm trạng của mô hình thay đổi.

## Chuẩn hóa dữ liệu (Normalize), và sửa đúng chỗ

Các log thực tế luôn chứa những giá trị khác nhau sau mỗi lần chạy — session ID, timestamp, thời gian thực thi, đường dẫn tuyệt đối:

```typescript
function normalize(events: SessionEvent[]) {
  const ids = new Map<string, string>();
  const stable = (v: string) => ids.get(v) ?? (ids.set(v, `id-${ids.size + 1}`), ids.get(v)!);

  return events.map((e) => ({
    ...e, at: 0, seq: e.seq,
    ...(('sessionId' in e) ? { sessionId: stable(e.sessionId as string) } : {}),
  }));
}
```

Lưu ý rằng các ID được *đánh số lại theo thứ tự*, chứ không bị xóa bỏ. Việc xóa bỏ sẽ làm mất đi sự thật rằng hai sự kiện cùng tham chiếu tới cùng một phiên làm việc — đó chính xác là loại lỗi bug mà một bài test snapshot cần phải bắt được.

> **Hãy sửa bản mẫu fixture, tuyệt đối không sửa bộ chuẩn hóa normaliser.**

Khi một bài snapshot bị lỗi, phản xạ tự nhiên là nới rộng bộ chuẩn hóa cho đến khi bài test vượt qua. Làm điều đó hai lần và bạn đang thực chất chỉ đi kiểm thử bộ chuẩn hóa của chính mình. Nếu một giá trị không ổn định, hoặc là nó không nên xuất hiện trong đầu ra, hoặc sự không ổn định đó chính là một lỗi bug.

## Các bất biến Runtime (Runtime Invariants)

Một số đặc tính bắt buộc phải được duy trì trong *mọi* bài test, chứ không chỉ ở một bài test cụ thể:

```typescript
installInvariants({
  'hiển thị cho mô hình ⟺ đã được ghi log': (agent) => {
    const fromLog = deriveMessages(agent.log.read());
    const sent = agent.lastRequest?.messages ?? [];
    assert.deepEqual(sent, fromLog, 'yêu cầu chứa nội dung không hề có trong log');
  },
  'không có lệnh gọi công cụ mồ côi': (agent) => {
    const calls = new Set(ids(agent.log, 'tool/call'));
    for (const id of ids(agent.log, 'tool/result')) calls.delete(id);
    assert.equal(calls.size, 0, `các lệnh gọi công cụ chưa được trả lời: ${[...calls]}`);
  },
  'tĩnh lặng hoàn toàn khi teardown': (agent) => {
    assert.equal(agent.status, 'idle');
    assert.equal(liveJobs(agent).length, 0);
  },
});
```

Đăng ký một lần duy nhất, và tự động kiểm tra sau mỗi bài test. Mỗi điều trên là một quy tắc đã được nêu ở đâu đó trong loạt bài này, giờ đây được cưỡng chế bởi bất kỳ thứ gì vô tình chạm vào nó — kể cả những bài test được viết cho một tính năng hoàn toàn khác, đó chính là nơi chúng chứng minh giá trị bảo vệ.

## Những bài kiểm thử không ai chịu viết

Ba khu vực thường xuyên gãy đổ nhất trên môi trường production nhưng lại vắng bóng trong hầu hết các bộ test. Cả ba đều trở nên cực kỳ rẻ để viết một khi cơ chế phát lại replay đã tồn tại:

**Hủy bỏ giữa chừng (Cancellation).** Abort ngay ở giữa một step. Assert rằng turn đã đóng lại đàng hoàng, hàng đợi sống sót qua cờ `keepInbox: true`, và không có tiến trình con nào bị rò rỉ. Đây là nội dung của [Phần 15](/vi/blog/building-agents/who-owns-the-agent/), và nó hầu như chưa từng được kiểm thử ở bất kỳ đâu.

**Thứ tự giải phóng tài nguyên (Teardown ordering).** Dispose một agent cha trong khi agent con của nó vẫn đang chạy. Assert việc giải phóng theo thứ tự con trước cha sau và không để lại đứa con mồ côi nào.

**Tính đồng thời (Concurrency).** Hai agent chạy trong cùng một tiến trình với các [phạm vi scope](/vi/blog/building-agents/scope-and-presets/) khác nhau — assert rằng agent bị hạn chế *thực sự* bị hạn chế, bằng cách gọi đích danh công cụ bị cấm theo tên.

Các bài test chập chờn (flaky) ở đây không phải là tiếng ồn ngẫu nhiên. Một bài test thất bại một lần trong số năm mươi lần chạy đã tìm ra một race condition thực sự; xóa bài test đó đi không làm cuộc đua race condition đó biến mất. Hãy chạy bộ test với thứ tự ngẫu nhiên hóa và chạy song song, và hãy đối xử với một lần thất bại chập chờn như một bản báo cáo lỗi gửi về từ tương lai.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness chạy **cơ chế phát lại phiên đã ghi âm không cần API key thông qua chính các profile được xuất xưởng** — không phải qua một bộ khung test giả lập gần giống sản phẩm, mà chạy xuyên qua cấu hình tổ hợp thực tế. Lệnh `pnpm run test:snapshot` không cần API key; chỉ khi ghi âm lại cuộn băng mới cần đến key.

Ba quy ước rất đáng học hỏi:

**Bắt buộc phải có snapshot cho bất kỳ thay đổi nào hiển thị với mô hình hoặc người dùng.** Không phải là lời khuyến khích. Một PR làm thay đổi những gì mô hình nhìn thấy mà không cập nhật file snapshot tương ứng sẽ bị coi là chưa hoàn thành.

**Các fixture phát lại được trên cả macOS và Linux, và quy tắc được ghi rõ thành văn bản**: sửa fixture, không sửa bộ normaliser.

**Cả hai SDK cùng chiếu theo vòng lặp.** Một thay đổi đối với vòng lặp agent loop hoặc bảng ánh xạ sự kiện bắt buộc phải cập nhật đầu ra kỳ vọng của cả TypeScript *lẫn* Python trong cùng một PR — bởi vì một bề mặt âm thầm lệch pha với vòng lặp là một bề mặt đang nói dối người dùng của nó.

## Cái bẫy thường gặp

Cái bẫy là liên tục nới rộng bộ chuẩn hóa normaliser.

Nó luôn khoác lên mình chiếc áo của một công việc bảo trì nhỏ nhẹ, rất hợp lý. Một bài snapshot bị lỗi, phần diff chỉ là một con số thời gian hoặc một đường dẫn, bạn thêm một quy tắc loại trừ, bài test xanh trở lại. Không ai nỡ bảo điều đó là sai.

Nhưng hãy lặp lại điều đó trong suốt một quý và bộ normaliser sẽ xóa sạch mọi ID, mọi thời lượng, mọi thứ tự, và mọi câu chữ báo lỗi — và bài snapshot giờ đây chỉ assert một điều mơ hồ rằng *có vài sự kiện đã diễn ra, đại khái thế*. Nó không bao giờ thất bại nữa, nên không ai thèm ngó ngàng tới nó, và nó hoàn toàn không mang lại bất kỳ tín hiệu bảo vệ nào trong khi vẫn tạo ra vỏ bọc giả tạo về độ bao phủ kiểm thử (coverage).

Mỗi quy tắc chuẩn hóa bắt buộc phải có một dòng comment giải thích rõ ràng tại sao giá trị đó lại bất ổn định một cách chính đáng. Nếu bạn không thể viết nổi dòng comment đó, giá trị đó không phải là tiếng ồn vô hại. Đó là bài test vừa tìm ra một điều bất thường thực sự.

## Tiếp theo

**[Phần 28 — Đánh giá (Evals)](/vi/blog/building-agents/evals/)**. Mọi bài test snapshot đều xanh rì nhưng agent lại giải quyết được ít bài toán hơn so với tháng trước. Không có bài test nào tóm được điều đó, bởi vì không có bài test nào đặt câu hỏi liệu agent có thực sự *giỏi* hay không.
