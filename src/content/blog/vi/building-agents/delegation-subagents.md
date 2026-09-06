---
title: 'Ủy quyền: Subagent không có trẻ mồ côi'
description: 'Một nhiệm vụ phụ nuốt trọn 40 turn khám phá tìm tòi, và từng turn một trong số đó đều đổ ụp xuống cuộc hội thoại chính của bạn. Giao việc cho agent con thì dễ; làm chủ vòng đời của nó mới là việc khó.'
pubDate: 2026-09-26
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-21-delegation'
sidebarTitle: '21 · Ủy quyền (Delegation)'
order: 21
---

Agent cần tìm ra tầng nào trong số bốn tầng cache đang bị vô hiệu hóa quá sớm. Việc tìm kiếm câu trả lời tiêu tốn tới 40 turn gồm grep, đọc code và thử nghiệm các giả thuyết. Toàn bộ 40 turn đó đều rơi thẳng vào cuộc hội thoại chính, và đến khi câu trả lời thực sự xuất hiện, thì nhiệm vụ ban đầu kích hoạt câu hỏi đó đã bị cơ chế [thu gọn ngữ cảnh (compaction)](/vi/blog/building-agents/the-context-budget/) cuốn phăng ra ngoài cửa sổ context.

Cách khắc phục quá hiển nhiên: giao cuộc điều tra đó cho một agent con với ngữ cảnh độc lập riêng, và chỉ nhận lại kết luận sau cùng.

Nhưng cách khắc phục đó cũng chính là nơi mọi bài toán về quyền sở hữu từ sáu bài viết vừa qua cùng lúc ập đến — đó là lý do tại sao bài viết này xuất hiện ở đây chứ không phải ở Phần 5.

## Một điểm kết nối (Seam), không phải một tính năng đơn lẻ

> Ủy quyền (Delegation) là một **điểm kết nối năng lực (capability seam)**, chứ không phải một tính năng đơn lẻ. Và các agent con xuất hiện dưới hai hình thái với vòng đời hoàn toàn khác nhau, hoàn tất tại các ranh giới khác nhau.

**Chạy một lần (One-shot).** Chạy một lần duy nhất, tạo ra kết quả, rồi bị giải phóng dọn dẹp (disposed). Agent cha hoặc chờ đợi nó hoặc thu thập nó như một [tác vụ ngầm (job)](/vi/blog/building-agents/background-work/).

**Có thể tiếp tục (Continuable).** Có một phiên làm việc bền vững riêng. Có khả năng tiếp nhận các tin nhắn tiếp theo. Có thể chuyển sang trạng thái "nguội" (cold) và được khôi phục lại sau đó nhiều ngày.

Cùng một seam, nhưng cơ chế bên dưới hoàn toàn khác biệt. Việc xây dựng hình thái thứ hai như một biến thể vụng về của hình thái thứ nhất — một lượt chạy one-shot mà bạn quên chưa dispose — là một sai lầm chết người; nó thực chất là một phiên làm việc có thời gian lưu trú (residency period), và chính khái niệm lưu trú mới là thứ giúp nó hoạt động trơn tru.

Phía provider rất mỏng, và sự mỏng manh đó là có chủ đích:

```typescript
interface SubagentProvider {
  readonly name: string;
  readonly capabilities: {
    agentOptions: boolean;   // caller có được phép ghi đè provider/model không?
    toolFilter: boolean;     // caller có được phép hạn chế công cụ của con không?
    persona: boolean;
    depthLimit: boolean;
  };
  /** Con có được nhìn thấy các turn đã hoàn tất của cha không? */
  readonly inheritsParentContext: boolean;

  start(request: ResolvedStartRequest): Promise<SubagentRun>;
  /** Sự hiện diện của phương thức này CHÍNH LÀ năng lực continuable. */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<{ seed?: SessionEvent[] }>;
}
```

`spawn` (tạo con mới toanh) và `fork` (con thừa hưởng các turn đã hoàn tất của cha) chỉ khác nhau đúng một trường. Các provider chạy ngoài tiến trình — một sản phẩm hoàn toàn khác, giao tiếp qua một giao thức — cũng triển khai cùng một interface này và chỉ đơn giản là quảng bá ít năng lực hơn.

**Kiểm tra năng lực trước khi điều phối, và báo lỗi to nếu không đáp ứng:**

```typescript
function assertCapabilities(p: SubagentProvider, req: StartRequest) {
  for (const [need, cap] of [
    [req.persona !== undefined, 'persona'],
    [req.toolFilter !== undefined, 'toolFilter'],
    [req.agentOptions !== undefined, 'agentOptions'],
    [req.maxDepth !== undefined, 'depthLimit'],
  ] as const) {
    if (need && !p.capabilities[cap]) {
      throw new SubagentError(`provider "${p.name}" không hỗ trợ năng lực "${cap}"`);
    }
  }
}
```

Việc âm thầm bỏ qua một `persona` mà provider không thể đáp ứng sẽ tạo ra một agent con chạy sai vai trò, mà không hề có bất kỳ thông báo lỗi nào xuất hiện. Cùng một nguyên tắc với [Phần 17](/vi/blog/building-agents/configuration-must-fail-loudly/): chấp nhận rồi lờ đi là kịch bản tồi tệ nhất có thể xảy ra.

<figure class="dg">
  <img src="/diagrams/part21-delegation-subagents.svg" alt="Một con one-shot hoàn tất lúc công bố; một con continuable hoàn tất sớm hơn, ngay tại khâu chấp nhận vào inbox, sau đó signal của caller không hủy được gì nữa." loading="lazy" />
  <figcaption><strong>Hai vòng đời, hai điểm kết thúc hoàn tất.</strong> Nhầm lẫn chúng và một caller bị hủy bỏ sẽ tiêu diệt một continuable child ngay giữa dòng suy nghĩ của nó.</figcaption>
</figure>

## Hai ranh giới hoàn tất

Đây là chi tiết thường khiến nhiều người kinh ngạc, và là phần sắc bén nhất trong bài viết này.

**One-shot hoàn tất tại thời điểm công bố (publication).**

```typescript
async function start(name: string, request: StartRequest): Promise<SubagentRun> {
  const provider = expectProvider(name);
  assertCapabilities(provider, request);
  assertDepth(request);
  const descriptor = snapshotDescriptor({ mode: 'one-shot', provider: name });  // trước bất kỳ await nào
  return provider.start({ ...request, descriptor });
}
```

Hàm `start()` chỉ hoàn thành khi một agent con thực sự đã hiện diện. Trước thời điểm đó, provider nắm toàn quyền thiết lập và bắt buộc phải rollback toàn bộ nếu gặp lỗi. Sau thời điểm đó, caller sở hữu lượt chạy đó và bắt buộc phải có trách nhiệm dispose nó. Nhờ vậy, caller luôn luôn nắm giữ hoặc là một agent con đang sống, hoặc là không có gì cả — tuyệt đối không bao giờ nắm giữ một đối tượng bị khởi tạo dở dang nửa vời.

**Continuable hoàn tất ngay tại khâu chấp nhận vào Inbox.**

```typescript
async function startContinuable(spec: ContinuableSpec): Promise<{ childId; messageId }> {
  const childId = newSessionId();
  const descriptor = snapshotDescriptor({ mode: 'continuable', provider: spec.provider,
                                          model: resolved.model, persona: spec.persona });
  const release = holdOwnership(spec.parent, childId);      // ← xem giải thích bên dưới
  try {
    const prepared = await provider.prepareContinuable({ sessionId: childId, parent: spec.parent });
    return await locks.run(childId, async () => {
      const activation = await materialize({ childId, seed: prepared.seed, descriptor });
      const messageId = submit(activation, spec.prompt);     // ← resolve NGAY TẠI ĐÂY
      return { childId, messageId };
    });
  } catch (err) { release(); throw err; }
}
```

Nó resolve ngay khi prompt được **chấp nhận vào hộp thư đến (inbox)** — trước khi turn bắt đầu, trước khi tin nhắn kịp đi vào session log. Kể từ khoảnh khắc đó, tín hiệu `signal` của caller không còn quyền hủy bỏ bất cứ thứ gì nữa: trình quản lý manager đã chính thức nắm quyền sở hữu activation một cách độc lập.

Hai vòng đời, hai điểm hoàn tất khác nhau. Đánh đồng chúng lại và bạn sẽ có một agent con continuable bị một caller đã hủy bỏ tiêu diệt ngay giữa dòng suy nghĩ.

## Khái niệm Kích hoạt (Activation)

Một agent con continuable là một phiên làm việc bền vững có **tối đa một** activation đang hoạt động trực tiếp:

```text
Session được lưu trữ              bền vững, sống sót qua việc tiến trình bị hủy
  └── Activation (≤ 1)            thời kỳ lưu trú cục bộ trong tiến trình
        ├── một AgentHandle
        ├── inbox của Agent       hàng đợi turn duy nhất
        └── ownedChildren: Set<SessionId>
```

Bởi vì một session có tối đa một activation, **session id của con chính là thứ định danh agent con đang sống**. Không cần thêm tham chiếu hiện thân runtime thứ hai, không cần bộ đếm thế hệ.

Trạng thái được suy ra trực tiếp, giống hệt như trong [Phần 15](/vi/blog/building-agents/who-owns-the-agent/):

```typescript
function stateOf(a: Activation): 'running' | 'waiting' | 'settled' {
  if (a.handle.agent.status === 'running' || a.accepted.size > 0) return 'running';
  if (a.ownedChildren.size > 0) return 'waiting';
  return 'settled';
}
```

### Giữ cho Agent cha luôn mở

Dòng mã `holdOwnership` ở trên là dòng mã vi tế nhất trong toàn bộ hệ thống và rất xứng đáng có một phân tích riêng.

Nếu bản thân agent cha *chính nó* cũng là một continuable child và hiện đang nhàn rỗi (idle), nó hoàn toàn có thể tự kết luận rằng mình không còn việc gì để làm và tự động settle kết thúc **ngay trong lúc agent con của nó đang được khởi tạo**. Kết quả là khi con ra đời, nó sẽ bơ vơ đối diện với một danh tính cha đã chết.

Vì vậy: hãy chèn `childId` vào tập hợp `ownedChildren` của cha *trước* khi có lệnh `await` đầu tiên diễn ra. Một agent cha không bao giờ được phép settle chừng nào tập hợp đó chưa rỗng. Nếu gặp lỗi, `release()` sẽ gỡ nó ra và đánh thức cha để đánh giá lại tình hình.

## Quan hệ liền kề (Adjacency)

Ai có quyền gửi tin nhắn cho ai? Câu trả lời dễ dãi — bất kỳ ai có ID đều được gửi — sẽ biến hệ thống thành một mớ hỗn độn không ai hiểu nổi chỉ sau ba thế hệ.

> Thẩm quyền bắt buộc phải là **sự liền kề chính xác (exact adjacency)**, được kiểm tra đối chiếu trực tiếp với đối tượng người gửi **đang sống**.

```typescript
async function sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[]) {
  if (agents.get(sender.id) !== sender) {
    throw new SubagentError('yêu cầu đúng đối tượng agent người gửi đang sống');   // đối tượng đã cũ
  }
  const senderActivation = activations.get(sender.id);
  if (senderActivation?.handle.agent === sender && senderActivation.parentSession === targetId) {
    return sendToParent(senderActivation, content);                    // con → cha
  }
  if (sender.session.header.parentSession === targetId) {
    throw new SubagentError('không phải là một resident continuable child; không thể gửi tin cho cha');
  }
  return deliverToChild(sender, targetId, content);                    // cha → con
}
```

Hãy chú ý hai nhánh ở giữa. Cả hai cùng hỏi "đích đến có phải là cha của tôi không?" nhưng chúng trả lời hoàn toàn khác nhau: nhánh thứ nhất kiểm tra **activation đang lưu trú (resident activation)**, nhánh thứ hai kiểm tra **header bền vững (durable header)**. Một agent có header ghi tên một người cha nhưng bản thân nó không phải là một continuable child đang lưu trú — chẳng hạn như một con dạng one-shot — sẽ rơi vào nhánh thứ hai và bị từ chối thẳng thừng, thay vì âm thầm lọt vào luồng gửi cho con.

Được phép: cha → con trực tiếp, và con đang lưu trú → cha trực tiếp. Bị từ chối: anh em ruột, ông bà - cháu chắt, tự gửi cho chính mình, các đối tượng đã chết, và con dạng one-shot.

Và việc định tuyến theo trạng thái lưu trú, đây chính là nơi cơ chế khôi phục từ trạng thái nguội (cold resume) xuất hiện:

| Activation của đích đến | Phương thức chuyển giao |
|---|---|
| `running` | bẻ lái (steer) tại ranh giới step gần nhất |
| `waiting` | đánh thức và bẻ lái ngay trên cùng activation đó |
| Không có | **khôi phục nguội (cold-resume)** một activation mới, rồi bẻ lái |

## Khôi phục nguội không cần Provider

Một agent con đã đi vào trạng thái nguội sẽ được khôi phục trực tiếp từ chính file log của nó. Hoàn toàn không cần provider tham gia vào:

```typescript
async function coldResume(parent: Agent, childId: SessionId, content: ContentBlock[]) {
  const observation = await query.observeSession(childId);
  authorizeLineage(parent, childId, observation.header.parentSession);

  // CHỈ fold trên phần hậu tố của riêng con này.
  const descriptor = foldDescriptor(observation.events.slice(observation.inheritedEventCount));
  if (descriptor?.mode !== 'continuable') throw new SubagentError('NOT_RESUMABLE');

  const activation = await materialize({
    childId,
    agentOptions: { provider: descriptor.provider, model: descriptor.model },
    composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
  });
  return submit(activation, content);
}
```

**`inheritedEventCount` chính là lỗi bug mà nếu không để ý bạn chắc chắn sẽ phạm phải.** Một agent con dạng `fork` được gieo mầm bằng chính log của cha. Nếu người cha đó bản thân nó cũng là một continuable child, thì log phát lại **sẽ chứa descriptor của người cha**. Nếu bạn fold toàn bộ mảng sự kiện đó, bạn sẽ vô tình khôi phục con với mô hình và persona của tổ tiên nó. Việc cắt mảng (slice) chính xác tại ranh giới thừa kế — trường dữ liệu mà [Phần 8](/vi/blog/building-agents/the-session-log/) đã giới thiệu riêng cho bài toán này — sẽ đảm bảo descriptor của chính người con giành chiến thắng.

Đó cũng là lý do tại sao descriptor continuable phải snapshot lại mô hình và persona đã phân giải: tại thời điểm khôi phục, người cha ban đầu có thể đã chết từ rất lâu, vì vậy bản mô tả descriptor bắt buộc phải có khả năng tự cung tự cấp độc lập.

## Thứ tự dọn dẹp giải phóng, và một cuộc đua hiểm hóc

Quy trình giải phóng Disposal tuân theo nguyên tắc giải phóng con trước từ [Phần 15](/vi/blog/building-agents/who-owns-the-agent/), cộng thêm một chi tiết sửa lỗi bug cực kỳ đắt giá:

```typescript
async function finishDisposal(a: Activation) {
  a.handle.agent.cancel({ kind: 'parent' });                 // từ trên xuống dưới, trước bất kỳ await nào
  await Promise.allSettled([...a.ownedChildren].map(disposeChild));
  await a.handle.agent.whenIdle();
  await flushSession(a).catch(logWarn);

  notifySettlement(a, terminalOutcome(a));    // ← TRƯỚC KHI giải phóng quyền sở hữu
  releaseOwnership(a.childId);                // ← luôn chạy ngay cả khi gặp lỗi
  await a.handle.dispose();
}
```

Nếu bạn tráo đổi vị trí của hai dòng mã đó, đây là những gì sẽ diễn ra: quyền sở hữu bị giải phóng trước, bộ theo dõi việc hoàn tất của cha thức giấc sau đó một microtask, thấy mình không còn đứa con nào và đang yên ắng, thế là nó tự động dispose chính nó — và lệnh `cancel()` của nó sẽ dọn sạch bóng hộp thư đến inbox vốn đang chứa thông báo mà bạn vừa gửi tới. Thông báo đã được gửi đi thành công rực rỡ nhưng bị tiêu diệt sạch sẽ trước khi kịp có ai đọc được nó.

Và hãy luôn giải phóng quyền sở hữu **ngay cả khi quá trình teardown gặp lỗi thất bại**. Một agent con bị lỗi nếu bị giữ lại sẽ khóa chặt toàn bộ dòng họ tổ tiên của nó trong trạng thái `waiting` mãi mãi.

Bản thân thông báo hoàn tất cũng nhận được một loại nguồn gốc riêng biệt — tuyệt đối không dùng `agent-message`:

```typescript
source: { kind: 'subagent-settled', childId, summary: 'Agent con đã cạn kiệt ngữ cảnh.' }
```

Bởi vì những trường hợp cần thông báo nhất — chạm trần token, lỗi mô hình, bị hủy bỏ, giải phóng cưỡng chế — lại chính là những trường hợp mà đứa con chưa từng có cơ hội tự chọn lời lẽ cho mình. Gán nhãn báo cáo của runtime như lời nói của agent con là đang tự tiện gán cho nó những từ ngữ mà nó chưa từng bao giờ viết ra.

## Độ sâu đệ quy và sự ủy quyền tất định

Một agent con có quyền ủy quyền thì có thể đệ quy vô tận. Hãy giới hạn nó, dựa trên header **đã được lưu trữ bền vững**:

```typescript
function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const depth = delegationDepthOf(parent) + 1;         // lấy từ header bền vững
  if (maxDepth !== undefined && depth > maxDepth) throw new DepthError(depth, maxDepth);
  return depth;
}
```

Việc đọc header bền vững thay vì một trường trong bộ nhớ RAM đảm bảo rằng một người cha được khôi phục lại không thể giả vờ mình là một agent cấp cao nhất (top-level). Giá trị mặc định là 3. Và công cụ vẫn tiếp tục hiển thị khi chạm ngưỡng giới hạn — mỗi nỗ lực gọi vượt trần sẽ bị từ chối kèm một thông báo lỗi mà mô hình có thể đọc và hiểu được, thay vì làm năng lực biến mất một cách bí ẩn trong thầm lặng.

Cũng rất đáng để nhắc tới một giải pháp thay thế: khi sự phân nhánh luồng công việc **đã được biết trước từ đầu**, một **đoạn mã kịch bản workflow** — luồng điều khiển tất định, coi các agent như các bước step — luôn luôn đánh bại cơ chế ủy quyền do mô hình tự dẫn dắt. Mô hình quyết định *nội dung* mỗi bước cần làm; còn mã nguồn của bạn quyết định *có bao nhiêu bước* và theo thứ tự nào. Hãy tìm đến cơ chế ủy quyền linh hoạt khi hình thái công việc chưa xác định, và tìm đến kịch bản workflow khi quy trình đã rõ ràng.

## Cái bẫy thường gặp

Cái bẫy là cho phép bất kỳ agent nào cũng có thể gửi tin nhắn cho bất kỳ agent nào chỉ thông qua ID.

Thoạt nhìn nó có vẻ rất tổng quát và linh hoạt, nhưng đó là dấu chấm hết cho khả năng hiểu được hệ thống. Một khi đứa cháu có thể gửi tin nhắn cho ông chú, câu hỏi "thứ gì có thể tiếp cận agent này?" hoàn toàn không có lời giải nếu không đọc hết toàn bộ codebase, nguy cơ deadlock bế tắc xuất hiện giữa các agent không có bất kỳ mối quan hệ được khai báo nào, và đồ thị quyền sở hữu — thứ giữ cho quy trình teardown được chính xác — không còn phản ánh đúng đồ thị giao tiếp nữa.

Chỉ duy nhất một cạnh quan hệ trực tiếp. Nếu hai agent cần phối hợp với nhau mà không nằm liền kề nhau, đó là dấu hiệu cho thấy **hệ thống phân cấp** của bạn đang bị sai, chứ không phải quy tắc này sai.

## Tiếp theo

**[Phần 22 — Phê duyệt và phân quyền (Approval and Permissions)](/vi/blog/building-agents/approval-and-permissions/)**. Agent chuẩn bị chạy lệnh `git push --force`. Bạn muốn nó phải hỏi ý kiến mình. Nhưng bạn tuyệt đối không muốn nó mở miệng xin phép trước mỗi lệnh `ls`.
