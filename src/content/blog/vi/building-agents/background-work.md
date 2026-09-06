---
title: 'Khi một công cụ sống lâu hơn Step của nó'
description: 'Lệnh build chạy mất tám phút. Mô hình không nên ngồi đợi, và tuyệt đối không được quên nhiệm vụ. Và nếu phiên làm việc đóng lại trong khi lệnh vẫn đang chạy?'
pubDate: 2026-09-25
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-20-jobs'
sidebarTitle: '20 · Tác vụ ngầm (Jobs)'
order: 20
---

```text
> npm run build
[ ...8 phút trôi qua... ]
```

Mọi thứ bị tắc nghẽn hoàn toàn. Mô hình đang giữ cho một step mở toang, turn không thể kết thúc, các tin nhắn của người dùng bị dồn ứ xếp hàng phía sau, và cả hệ thống đang phải dài cổ chờ đợi một tiến trình con subprocess vốn dĩ không cần bất kỳ sự giám sát nào.

Các giải pháp ngây thơ đều rất tồi tệ. Spawn tiến trình chạy tách rời (detached) rồi trả về ngay lập tức đồng nghĩa với việc kết quả đầu ra không biết đi đâu về đâu và không ai nhận biết được khi nào nó bị lỗi. Tăng thời gian timeout chỉ là lặp lại cùng một vấn đề với một con số to hơn.

Thứ bạn thực sự cần là: công việc rời khỏi step hiện tại nhưng vẫn nằm trong tầm kiểm soát trách nhiệm.

<figure class="dg">
  <img src="/diagrams/part20-background-work.svg" alt="Một background job rời khỏi step ngay lập tức, và done promise của nó chỉ resolve sau khi producer đã giải phóng toàn bộ tài nguyên nó nắm giữ." loading="lazy" />
  <figcaption><strong>Resolve dựa trên bản hợp đồng, chứ không dựa trên công việc nhìn thấy bằng mắt.</strong> Nếu không, khâu teardown sẽ chạy đua với khâu cleanup và một test worker sẽ chiếm dụng cổng mạng mà lần chạy tiếp theo của bạn đang rất cần.</figcaption>
</figure>

## Sự phân tách trách nhiệm

> Hãy phân tách rạch ròi giữa **danh tính và vòng đời (identity & lifecycle)** — do runtime sở hữu — khỏi **tài nguyên thực thi (execution resources)** — do producer sở hữu.

Runtime biết rằng đang có một tác vụ ngầm tên là `bash-3`, ai là chủ sở hữu của nó, nó có đang chạy hay không, và làm cách nào để yêu cầu nó dừng lại. Runtime không cần biết nó có phải là một subprocess hay không. Còn producer thì biết về subprocess, các đường ống pipe dữ liệu, và process group của nó. Producer không cần quan tâm đến ID hệ thống hay cơ chế kiểm soát truy cập.

```typescript
type JobId = string;                    // `${kind}-${n}` — đọc hiểu được trong transcript
type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

interface JobStart {
  kind: string;                         // 'bash' | 'subagent' | ... — cũng là tiền tố của id
  label: string;                        // một dòng mô tả hướng về mô hình: câu lệnh, tác vụ
  owner?: Agent;                        // bỏ qua nếu là unowned job không có chủ
  outputLimitBytes?: number;
  /** Được gọi đúng một lần, SAU KHI preflight hoàn tất. Trả về hooks; không được throw sau khi bắt đầu việc. */
  run(): JobHooks;
}

interface JobHooks {
  /** Chỉ resolve SAU KHI producer đã GIẢI PHÓNG TOÀN BỘ TÀI NGUYÊN — không phải lúc công việc vừa xong. */
  done: Promise<JobOutcome>;
  cancel(reason: string): void;
  /** Chỉ hiện diện đối với các job có đầu ra có thể đọc lũy tiến từng phần. */
  readOutput?(opts: { since?: number }): Promise<string>;
}
```

Hai bản hợp đồng trong cấu trúc trên là toàn bộ nội hàm cốt lõi của bài viết này.

## `done` có nghĩa là đã giải phóng xong, không phải là vừa chạy xong

```typescript
// Sai: resolve ngay khi tiến trình vừa thoát.
done: new Promise((r) => child.on('exit', r));

// Đúng: chỉ resolve khi mọi thứ mà job này chiếm giữ đều đã biến mất hoàn toàn.
done: (async () => {
  const [code] = await once(child, 'exit');
  await drainStreams(child);        // stdout/stderr đã được tiêu thụ trọn vẹn
  await killProcessGroup(child);    // các tiến trình cháu chắt mồ côi đã được dọn sạch
  await tmp.cleanup();              // các file nháp tạm thời đã bị xóa
  return { status: code === 0 ? 'completed' : 'failed', exitCode: code };
})();
```

Nếu làm sai điều này, khâu giải phóng dọn dẹp (teardown) sẽ chạy đua với khâu thu hồi tài nguyên (cleanup). Agent đã bị giải phóng, `done` đã resolve, mọi thứ trông có vẻ đã tĩnh lặng hoàn toàn — nhưng một tiến trình worker của `vitest` do bài build sinh ra vẫn đang âm thầm chiếm giữ cổng 5173, vốn là cổng mà phiên làm việc tiếp theo đang chuẩn bị sử dụng.

Cùng một hình thái với [ranh giới công bố (publication boundary)](/vi/blog/building-agents/who-owns-the-agent/) trong Phần 15: promise chỉ được phép resolve khi *bản hợp đồng* đã hoàn tất trọn vẹn, chứ không phải khi công việc nhìn thấy bằng mắt vừa dừng lại.

## Kiểm tra trước (Preflight) rồi mới Commit

Registry bắt buộc phải hoàn thành tất cả những gì có thể thất bại **trước khi** gọi hàm `run()`:

```typescript
async function start(spec: JobStart): Promise<JobId> {
  // Mọi thứ có thể gây lỗi đều diễn ra ở đây — trước khi bất kỳ tài nguyên nào được tạo ra.
  const id = allocateId(spec.kind);
  assertCanStart(spec.owner);
  const record = { id, kind: spec.kind, label: spec.label, owner: spec.owner?.id };

  // Commit. run() được gọi một lần duy nhất và các hook của nó được giữ lại.
  const hooks = spec.run();          // nếu ném lỗi throw → chưa có thứ gì bị đăng ký
  jobs.set(id, { ...record, hooks, status: 'running' });

  void hooks.done.then((o) => finalize(id, o), (e) => finalize(id, { status: 'failed', error: e }));
  return id;
}
```

Nếu `run()` ném ra ngoại lệ, không có thứ gì được đăng ký và producer chịu trách nhiệm dọn dẹp bất kỳ thứ gì nó đã lỡ khởi tạo dở dang. Nếu nó trả về bình thường, job chính thức tồn tại và runtime nắm toàn quyền quản lý vòng đời của nó. Tuyệt đối không có bước nào có khả năng gây lỗi diễn ra *sau* khi commit — nếu không, bạn sẽ có một job đã được đăng ký nhưng tài nguyên thực tế chưa từng được tạo ra, và không có thứ gì có thể kết thúc nổi nó.

## Hàng rào kiểm soát quyền sở hữu (Owner Fencing)

Mỗi job đều có một chủ sở hữu, và quyền truy cập được kiểm tra đối chiếu trực tiếp với chủ sở hữu đó:

```typescript
function authorize(id: JobId, caller: Agent): JobRecord {
  const job = jobs.get(id);
  if (!job) throw new JobError(`không tồn tại job: ${id}`);
  if (job.owner !== undefined && job.owner !== caller.id) {
    throw new JobError(`job ${id} thuộc về một agent khác`);
  }
  return job;
}
```

> Quyền truy cập được rào chắn bởi **chủ sở hữu (owner)**, chứ không dựa vào sự bí mật của ID.

Các ID có dạng như `bash-3`. Chúng xuất hiện công khai trong transcript, trong log, trong ngữ cảnh của mô hình. Chúng rất dễ đoán theo thiết kế, vì vậy chúng không thể nào là ranh giới bảo mật được. Đây là cùng một bài học với việc [hàm disposer là một capability](/vi/blog/building-agents/who-owns-the-agent/) — thẩm quyền bắt nguồn từ một mối quan hệ có thể kiểm chứng được, không bao giờ bắt nguồn từ việc biết một cái tên.

Một job **không có chủ sở hữu (unowned)** được cố tình cung cấp: ví dụ như một tác vụ khởi động làm ấm máy trước khi bất kỳ agent nào được tạo ra. Unowned có nghĩa là bất kỳ ai cũng có quyền điều khiển nó, đó là một lựa chọn thực sự và cần được biểu đạt rõ ràng tại điểm gọi lệnh.

Và mối liên kết giúp ngăn chặn rò rỉ: **giải phóng một agent sẽ tự động hủy bỏ và chờ đợi toàn bộ các job của nó hoàn tất.** Nó nằm trong quy trình teardown từ Phần 15, ngay trước `whenIdle`.

## Góc nhìn hướng về phía mô hình

Ba công cụ, và cấu trúc của công cụ đầu tiên chính là mấu chốt:

```typescript
{
  name: 'bash',
  inputSchema: { /* command, run_in_background?: boolean */ },
  async execute({ command, run_in_background }, ctx) {
    if (!run_in_background) return shell.run({ command });   // luồng chạy tiền cảnh thông thường

    const id = await ctx.jobs.start({
      kind: 'bash',
      label: command,
      owner: ctx.agent,
      outputLimitBytes: 20_000,
      run: () => spawnBackgroundShell(command),
    });
    return `Đã bắt đầu background job ${id}. Thu thập kết quả bằng job_output({ id }), dừng lại bằng job_kill({ id }).`;
  },
}
```

Chạy tiền cảnh (Foreground) luôn là mặc định. Chạy ngầm (Background) là một cờ tùy chọn, và kết quả trả về là một ID đi kèm hướng dẫn chi tiết — mô hình cần được chỉ dẫn cách quay lại kiểm tra tác vụ, ngay trong phần kết quả, trên từng lần gọi.

`job_output` trả về dữ liệu đầu ra có giới hạn kèm theo dấu hiệu khi bị cắt bớt (lại là [kỷ luật tràn dữ liệu spill](/vi/blog/building-agents/the-context-budget/): một lệnh build 8 phút sinh ra hàng megabyte log, và việc đổ ào toàn bộ đống đó ra sẽ phá hỏng hoàn toàn mục tiêu đưa công việc ra ngoài step). `job_kill` gửi yêu cầu dừng và trả về ngay khi yêu cầu được chấp nhận, chứ không đợi đến khi tiến trình thực sự biến mất.

## Thông báo cho mô hình khi công việc hoàn tất

Một job hoàn thành trong lúc agent đang nhàn rỗi (idle) cần phải tìm cách tiếp cận được agent. Hãy sử dụng [hộp thư đến (inbox)](/vi/blog/building-agents/the-inbox/) — đây chính xác là tình huống mà inbox được sinh ra để phục vụ:

```typescript
function onJobSettled(job: JobRecord, outcome: JobOutcome) {
  const owner = agents.get(job.owner!);
  if (!owner) return;                      // chủ sở hữu không còn sống: bản ghi log là đủ

  const notice = `Background job ${job.id} (${job.label}) ${outcome.status}.` +
    (outcome.summary ? `\n${outcome.summary}` : '');

  owner.send({ role: 'user', content: [{ type: 'text', text: notice }] }, {
    boundary: 'next-turn',
    wake: owner.status === 'idle',         // nếu idle → đánh thức mở turn; nếu đang bận → đi kèm theo
    source: { kind: 'job-settled', jobId: job.id },
  });
}
```

Hai quyết định rất đáng học hỏi: Cờ `wake` phụ thuộc vào việc liệu agent có đang idle hay không — đánh thức một agent đang bận rộn là vô nghĩa, vì đằng nào nó cũng sẽ tự claim tin nhắn tại ranh giới tiếp theo. Và trường `source` đánh dấu đây là thông báo từ runtime, để bản ghi lịch sử transcript không bao giờ kết xuất nó như một lời do người dùng thốt ra.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness sở hữu một package `jobs` tổng quát với một bảng ánh xạ `JobKind` có thể mở rộng theo cơ chế merge, và điều thú vị là đối tượng sử dụng nó: `bash` là một producer, và **các subagent chạy ngầm một lần (one-shot background subagents) là một producer khác**. Tính năng ủy quyền delegation không hề tự xây dựng cơ chế chạy ngầm riêng cho nó — nó chỉ việc đăng ký như một producer của hệ thống jobs này.

Đó chính là bài kiểm tra thực tế xem liệu điểm nối seam có thực sự chuẩn xác hay không. Nếu tính năng chạy lâu thứ hai của bạn tái sử dụng lại runtime quản lý job thay vì tự sáng chế ra một hệ thống song song khác, thì sự phân chia giữa danh tính và tài nguyên đã được đặt trúng hồng tâm.

Thêm hai chi tiết nữa: `JobStatus` giữ một tập từ vựng đóng nhỏ gọn với các thông tin đặc thù của producer nằm trong trường `detail`, nhờ đó các bên tiêu thụ có thể rẽ nhánh logic dựa trên trạng thái mà không cần phải am hiểu từng producer cụ thể. Và `readOutput` là một tùy chọn — nó phân biệt rõ ràng giữa các job dạng stream có thể thăm dò liên tục và các job chỉ trả về kết quả cuối cùng một lần, thay vì ép buộc mọi producer phải giả mạo một luồng stream.

## Cái bẫy thường gặp

Cái bẫy là để cho mô hình tự mình quản lý các tiến trình chạy ngầm.

Đó là một đường tắt đầy cám dỗ: trao cho nó công cụ `bash`, để nó tự gõ `npm run build &`, rồi để nó tự lần mò PID. Trong bản demo nó thậm chí còn chạy ngon lành.

Thế rồi hoàn toàn không có cơ chế rào chắn quyền truy cập — bất kỳ agent nào cũng có thể `kill` bất kỳ PID nào mà nó đọc được. Hoàn toàn không có cơ chế thu dọn lúc giải phóng — phiên làm việc kết thúc, lệnh build vẫn lẳng lặng chạy ngầm, cổng mạng tiếp tục bị chiếm dụng. Hoàn toàn không có thứ gì báo cho mô hình biết khi nào lệnh chạy xong — nó bắt buộc phải tự nhớ để đi thăm dò polling, và nó chắc chắn sẽ quên. Và mô hình giờ đây đang phải làm công việc quản lý tiến trình hệ điều hành qua một giao diện văn bản, thứ mà nó dở tệ hại.

Runtime quản lý job không phải là một sự trang hoàng hình thức bọc quanh ký tự `&`. Nó là quyền sở hữu, là cơ chế thông báo tự động, và là sự gắn kết chặt chẽ trong quy trình giải phóng tài nguyên — ba thứ mà ký tự `&` hoàn toàn không có.

## Tiếp theo

**[Phần 21 — Ủy quyền: Subagent không có trẻ mồ côi](/vi/blog/building-agents/delegation-subagents/)**. Một nhiệm vụ phụ nuốt trọn 40 turn khám phá tìm tòi, và từng turn một trong số đó đều đổ ụp xuống cuộc hội thoại chính của bạn.
