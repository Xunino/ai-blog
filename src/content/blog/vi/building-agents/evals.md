---
title: 'Evals: Đo lường những gì bài Test không thể'
description: 'Mọi bài test snapshot đều xanh rì nhưng agent lại giải quyết được ít bài toán hơn tháng trước. Không có bài test nào bắt được điều đó, bởi vì không bài test nào đặt câu hỏi liệu nó có giỏi hay không.'
pubDate: 2026-10-03
tags: ['ai-agents', 'testing', 'operations']
translationKey: 'agents-28-evals'
sidebarTitle: '28 · Đánh giá (Evals)'
order: 28
---

Bộ test từ [Phần 27](/vi/blog/building-agents/testing-nondeterminism/) xanh mướt toàn bộ. Mọi snapshot đều khớp chính xác, mọi bất biến đều được giữ vững, độ bao phủ coverage rất đẹp.

Thế nhưng agent lại dở đi. Người dùng phàn nàn điều đó. Nó tốn nhiều turn hơn để đi đến cùng một kết quả, dễ dàng đầu hàng trước những tác vụ mà trước đây nó từng hoàn thành tốt, và quay sang hỏi người dùng những câu hỏi mà trước đây nó từng tự tin trả lời.

Không có thứ gì bị hỏng hóc kỹ thuật cả. Chỉ là có thứ gì đó đã *kém đi*, và toàn bộ bộ test của bạn về mặt cấu trúc hoàn toàn bất lực trong việc nhận ra điều đó, bởi vì mọi bài test đều chỉ assert trên những hành vi mà bạn đã đóng băng từ trước — mà chất lượng thì không bao giờ là một hành vi bị đóng băng.

<figure class="dg">
  <img src="/diagrams/part28-evals-telemetry.svg" alt="Các bài test hỏi xem hành vi có thay đổi không và cần tính tất định; các bài eval hỏi xem agent có giỏi không và cần tính ngẫu nhiên lặp lại đối với mô hình thực tế." loading="lazy" />
  <figcaption><strong>Một bài eval là một chiếc nhiệt kế, không phải một tấm bia mục tiêu.</strong> Ngay khoảnh khắc nó biến thành mục tiêu phấn đấu, nó lập tức ngừng đo lường thứ mà nó vốn được sinh ra để đo lường.</figcaption>
</figure>

## Hai câu hỏi, hai hệ thống hoàn toàn khác biệt

> **Bài Test hỏi: "Hành vi có bị thay đổi không?"** và bắt buộc phải cần tính tất định (determinism) thì mới có ý nghĩa.  
> **Bài Eval hỏi: "Nó có thực sự giỏi không?"** và bắt buộc phải cần tính ngẫu nhiên (randomness) thì mới có ý nghĩa.

Đánh đồng hai khái niệm này sẽ dẫn tới hai thất bại quen thuộc. Viết test snapshot chạy trực tiếp với mô hình thực tế: chập chờn flaky, đắt đỏ, và mỗi lần nhà cung cấp ra mắt phiên bản mô hình mới lại phải viết lại toàn bộ fixture. Đưa eval vào làm cổng kiểm tra bắt buộc trong CI: hóa đơn tiền điện toán tăng vọt, hàng đợi nghẽn ứ, và một chữ *pass* chẳng nói lên điều gì vì một lần chạy đơn lẻ của một hệ thống ngẫu nhiên không bao giờ là một phép đo lường khoa học.

Hãy xây dựng cả hai. Không cái nào có thể thay thế cho cái nào.

## Một bài Eval được cấu thành từ những gì?

Gồm ba phần. Chỉ có phần thứ hai là thực sự khó.

**Các tác vụ có kết quả có thể kiểm tra được (Checkable outcomes).** Không phải là yêu cầu mơ hồ kiểu "hãy viết code thật hay" — mà là một tác vụ nơi thành công được phán quyết bởi một chương trình máy tính:

```typescript
interface EvalTask {
  id: string;
  prompt: string;
  fixture: string;                              // một snapshot repository để làm việc trong đó
  check(workspace: string): Promise<boolean>;   // tất định 100%
}

const tasks: EvalTask[] = [
  {
    id: 'fix-failing-test',
    prompt: 'Bộ test đang bị lỗi. Hãy sửa nó.',
    fixture: 'fixtures/broken-parser',
    check: async (ws) => (await run('npm test', ws)).exitCode === 0,
  },
  {
    id: 'add-endpoint',
    prompt: 'Hãy thêm endpoint DELETE /users/:id theo đúng các pattern hiện có.',
    fixture: 'fixtures/api-server',
    check: async (ws) => (await run('npm test -- delete-user', ws)).exitCode === 0,
  },
];
```

**Sự lặp lại (Repetition).** Một lần chạy chỉ là một giai thoại ngẫu nhiên. Ba lần chạy là một tín hiệu yếu ớt. Năm lần chạy mới bắt đầu có thể sử dụng được:

```typescript
async function evaluate(task: EvalTask, runs = 5): Promise<TaskResult> {
  const outcomes = await Promise.all(
    Array.from({ length: runs }, async () => {
      const ws = await materializeFixture(task.fixture);
      const agent = await createAgent({ workspace: ws });
      const start = Date.now();
      await agent.run(task.prompt);
      return {
        passed: await task.check(ws),
        cost: agent.metrics.costUsd,
        turns: agent.metrics.turns,
        ms: Date.now() - start,
      };
    }),
  );
  const passes = outcomes.filter((o) => o.passed).length;
  return {
    id: task.id,
    passRate: passes / runs,
    medianCost: median(outcomes.map((o) => o.cost)),
    costPerSolve: passes === 0 ? Infinity : sum(outcomes.map((o) => o.cost)) / passes,
  };
}
```

**Chi phí trên mỗi bài toán giải được (Cost per solve).** Đây là chỉ số mà mọi người hay quên nhất, nhưng lại là chỉ số định đoạt mọi quyết định kinh doanh. Một agent giải được 90% bài toán với giá $0.40 và một agent giải được 95% bài toán với giá $2.10 là một sự đánh đổi thực tế rất lớn — và bạn không thể nào có một cuộc thảo luận nghiêm túc nếu không có con số đó trong tay.

## Tìm kiếm các tác vụ mang ý nghĩa thực sự

Cám dỗ lớn nhất là tự mình ngồi bịa ra các tác vụ. Đừng làm vậy — phần lớn thời gian bạn sẽ chỉ vô thức viết ra những tác vụ mà bạn vốn đã biết thừa là agent xử lý rất tốt.

**Khai thác từ chính file log của bạn.** Bạn đang sở hữu một [session log](/vi/blog/building-agents/the-session-log/) ghi lại mọi thứ agent từng làm. Hãy tìm những phiên làm việc có kết cục tồi tệ, biến chúng thành các tác vụ eval. Về mặt bản chất, đây chính là những thất bại thực tế mà bạn đang thực sự đối mặt mỗi ngày.

**Khai thác từ các báo cáo lỗi của người dùng.** Mỗi câu phàn nàn *"nó đã làm X trong khi đáng lẽ phải làm Y"* chính là một ca eval hoàn hảo với bài kiểm tra check đã được người báo cáo viết sẵn bằng lời.

**Giữ lại một tập dữ liệu đối chứng độc lập (Holdout set).** Hãy chia bộ đề thành hai phần: một tập để bạn liên tục thử nghiệm lặp lại (iterate), và một tập bạn tuyệt đối không bao giờ được chạm vào ngoại trừ lúc làm báo cáo đánh giá cuối cùng. Nếu không có sự phân chia này, bạn sẽ tự rơi vào cái bẫy overfitting — làm tăng điểm số trên tập kiểm tra nhưng chất lượng thực tế của agent thì không hề tăng, điều đó còn tồi tệ hơn việc không đo lường gì bởi vì bạn đang tự tin một cách hoàn toàn sai lầm.

## Vị trí của các bộ Benchmark công khai

SWE-bench Verified, Terminal-Bench, bảng xếp hạng polyglot của Aider. Chúng rất hữu ích nhưng chúng tuyệt đối không phải là bài eval của riêng bạn.

**Hãy dùng chúng để:** lựa chọn mô hình nền tảng ban đầu; kiểm tra đối chiếu xem harness của bạn có bị thụt lùi quá xa so với những gì mô hình thô làm được hay không; so sánh [các định dạng chỉnh sửa mã](/vi/blog/building-agents/how-an-agent-changes-your-code/), nơi độ chênh lệch giữa các định dạng trên cùng một mô hình thường lớn hơn nhiều so with chênh lệch giữa các mô hình khác nhau.

**Tuyệt đối không dùng chúng để:** quyết định xem liệu agent của *chính bạn* có thực sự tiến bộ hay không. Tác vụ của họ không phải tác vụ của bạn, codebase của họ không phải codebase của bạn, và một bộ benchmark đã lưu hành suốt hai năm trời chắc chắn đã bị rò rỉ vào dữ liệu huấn luyện của các mô hình theo những cách mà không ai có thể định lượng nổi.

Phần giá trị nhất có thể chuyển giao từ một benchmark công khai chính là *phương pháp luận (methodology)* của nó — cách nó định nghĩa một tác vụ, cách nó kiểm tra sự thành công, và cách nó báo cáo độ lệch phương sai. Hãy học hỏi phương pháp đó; và tự đo lường trên bài toán của chính bạn.

## Leo đồi (Hill-climbing) mà không tự lừa dối bản thân

Một khi bạn có một con số trong tay, mọi người sẽ tìm mọi cách để đẩy con số đó tăng lên. Bốn quy tắc giữ cho quá trình này luôn trung thực:

**Mỗi lần chỉ thay đổi duy nhất một thứ.** Đổi prompt, đổi mô hình, đổi định dạng chỉnh sửa, đổi tập công cụ — chỉ một thứ trên mỗi lượt đánh giá. Thay đổi hai thứ cùng lúc và đạt mức tăng 4% sẽ chẳng nói lên được điều gì về việc bạn nên giữ lại thay đổi nào.

**Báo cáo theo khoảng dao động (interval), không báo cáo điểm số đơn lẻ (point).** Năm lần chạy của một tác vụ có tỷ lệ vượt qua 70% có thể rơi vào bất kỳ đâu từ 40% đến 100%. Mức "cải thiện" 4% nằm lọt thỏm bên trong biên độ dao động đó chỉ là tiếng ồn ngẫu nhiên đội lốt một chữ số thập phân.

**Quan sát chi phí song song với tỷ lệ thành công.** Một cải tiến làm tăng gấp đôi chi phí tiêu tốn là một quyết định đánh đổi, không phải một chiến thắng mặc nhiên. Hãy luôn trình bày cả hai con số cạnh nhau trong cùng một bảng báo cáo.

**Ghi log toàn bộ cấu hình đi kèm từng kết quả.** Sáu tuần sau, câu hỏi "tại sao chỉ số này dạo trước đạt 88% mà giờ chỉ còn 82%?" sẽ không thể nào trả lời nổi nếu thiếu phiên bản mô hình, mã băm hash của prompt, và tập công cụ cụ thể đã tạo ra từng con số đó.

## Đánh giá hành vi, không chỉ đánh giá kết quả cuối cùng

Không phải mọi thứ đều có thể quy về một bài test chạy pass. Có thêm hai dạng eval rất đáng để xây dựng:

**Kiểm tra quỹ đạo hành động (Trajectory checks)** assert trên [chuỗi sự kiện](/vi/blog/building-agents/testing-nondeterminism/) thay vì chỉ nhìn vào kết quả cuối cùng: *nó có đọc file trước khi sửa không? nó có tuân thủ ngân sách step không? nó có tránh công cụ bị cấm không?* Những bài kiểm tra này tái sử dụng bộ máy từ Phần 27, chạy trực tiếp trên mô hình thật, và tóm gọn những sự thụt lùi về mặt quy trình mà một bài test pass thông thường dễ dàng che giấu.

**Các trường hợp từ chối và an toàn (Refusal & safety cases)** cũng thuộc về nơi này — một tập hợp các [payload tấn công injection](/vi/blog/building-agents/what-it-reads-is-not-an-order/) nơi thành công đồng nghĩa với việc *từ chối tuân theo*. Con số đó bắt buộc phải được theo dõi chặt chẽ như mọi chỉ số khác, và nó phải là chỉ số có quyền phủ quyết chặn đứng một bản phát hành release.

## Phiên bản hoàn chỉnh trông như thế nào?

Thành thật mà nói: DeepSeek Harness không có package eval riêng biệt. Hầu hết các repository về agent khác cũng vậy, kể cả những sản phẩm rất tốt. Người ta thường chỉ xây dựng snapshot testing vì sự thụt lùi về chức năng luôn gãy đổ ầm ĩ; còn eval thì không được chú trọng, vì sự suy thoái về chất lượng diễn ra hết sức âm thầm trong bóng tối.

Vì vậy, thực hành đáng học hỏi nhất không đến từ một repository cụ thể nào — mà đến từ chính tính kỷ luật kỹ thuật:

**Chỉ chạy eval trước khi một thay đổi lớn được đưa vào nhánh chính, không chạy trên mọi commit.** Chúng là cổng kiểm duyệt cho việc nâng cấp mô hình, viết lại prompt, thay đổi công cụ. Chứ không dùng cho các commit sửa lỗi chính tả.

**Công khai minh bạch con số này trong nội bộ tổ chức.** Một bảng tỷ lệ thành công treo trang trọng trên tường sẽ tạo ra những cuộc thảo luận sâu sắc về chất lượng mà nếu không có nó sẽ chẳng bao giờ diễn ra.

**Đánh số phiên bản cho chính bộ đề Eval.** Bổ sung thêm tác vụ mới sẽ làm thay đổi điểm số vì những lý do hoàn toàn không liên quan đến năng lực của agent. Hãy gắn tag cho bộ đề; và luôn báo cáo kèm theo tag đó.

## Cái bẫy thường gặp

Cái bẫy chính là việc tối ưu hóa cho bài benchmark (Overfitting the benchmark).

Nó diễn ra mà không cần ai phải chủ đích làm vậy. Con số điểm số sừng sững ở đó, việc làm cho nó tăng lên mang lại cảm giác của sự tiến bộ, và con đường nhanh nhất để đẩy nó tăng lên là làm cho agent giỏi hơn ở *chính xác những tác vụ đó*. Thêm một câu gợi ý trong prompt giúp ích cho 3 trong số 20 bài toán. Viết thêm một đoạn mã đặc cách (special-case) cho một công cụ phục vụ riêng một pattern chỉ xuất hiện trong các fixture kiểm thử. Điểm số tăng vọt. Nhưng chẳng có thứ gì thực sự tiến bộ cả.

Một bài eval là **chiếc nhiệt kế, không phải tấm bia mục tiêu**. Ngay khoảnh khắc nó biến thành mục tiêu, nó lập tức ngừng đo lường thứ mà nó vốn được sinh ra để đo lường — định luật Goodhart, luôn luôn xuất hiện đúng như hẹn ước.

Tuyến phòng thủ duy nhất là tập dữ liệu đối chứng độc lập holdout set và thói quen luôn tự vấn trước mỗi thay đổi làm dịch chuyển con số: *liệu thay đổi này có thực sự giúp ích cho một người dùng có tác vụ hoàn toàn không nằm trong bộ đề kiểm tra này hay không?* Nếu bạn không thể tự tin trả lời CÓ, bạn chỉ vừa mới tinh chỉnh lại chiếc nhiệt kế của mình mà thôi.

## Tiếp theo

**[Phần 29 — Vận hành thực chiến (Running It for Real)](/vi/blog/building-agents/running-it-for-real/)**. Hệ thống đã chạy tốt. Giờ đây nó phục vụ cho năm trăm người dùng cùng lúc, và ai đó hỏi tháng này nó tiêu tốn bao nhiêu tiền và số tiền đó đã biến đi đâu mất.
