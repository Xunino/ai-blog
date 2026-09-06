---
title: 'Vận hành thực chiến: Đưa vào sản xuất'
description: 'Hệ thống đã chạy tốt. Giờ đây nó phục vụ cho năm trăm người và ai đó hỏi tháng này tiêu tốn bao nhiêu tiền và số tiền đó đã biến đi đâu. Câu trả lời vốn đã nằm sẵn trong file log của bạn.'
pubDate: 2026-10-04
tags: ['ai-agents', 'operations', 'architecture']
translationKey: 'agents-29-operations'
sidebarTitle: '29 · Vận hành (Operations)'
order: 29
---

Năm trăm người dùng thực tế. Câu hỏi từ bộ phận tài chính xuất hiện: *hệ thống này tiêu tốn bao nhiêu tiền, và số tiền đó đã đi đâu?*

Sau đó là những câu hỏi hóc búa hơn. Những lỗi thất bại nào là do mã của chúng ta và những lỗi nào là do nhà cung cấp mô hình gây ra. Tại sao một số phiên làm việc lại tốn kém gấp bốn mươi lần những phiên khác. Liệu sự thay đổi prompt vào tuần trước là giúp ích hay làm hại hệ thống. Chuyện gì sẽ xảy ra khi tiến trình bị sập ngay ở giữa một turn.

Bạn hoàn toàn có thể trả lời được tất cả những câu hỏi đó, và bạn không hề cần đến một pipeline đo đếm số liệu (metrics pipeline) phức tạp riêng biệt để làm điều đó.

<figure class="dg">
  <img src="/diagrams/part29-operations-harness-vi.svg" alt="Mọi con số vận hành đều là một phép fold duyệt trên session log, vì vậy các chỉ số có thể tính toán lại và không bao giờ mâu thuẫn với bản ghi lịch sử transcript." loading="lazy" />
  <figcaption><strong>Nếu một chỉ số không thể suy ra được, bạn đang bị thiếu một sự kiện.</strong> Hãy ghi log sự kiện đó — tuyệt đối không mở thêm một đường ống thu thập thứ hai.</figcaption>
</figure>

## Dữ liệu đo đạc từ xa (Telemetry) chỉ là một phép Fold

> Những gì bạn không ghi log, bạn không thể gỡ lỗi — và file log của một agent **chính là** [session log](/vi/blog/building-agents/the-session-log/). Đo đạc từ xa không phải là một hệ thống thứ hai. Nó chỉ là thêm một bên tiêu thụ nữa của luồng sự kiện mà bạn vốn đã có sẵn.

Từng con số dưới đây đều là kết quả rút gọn (reduction) từ các sự kiện vốn đã tồn tại:

```typescript
interface TurnMetrics {
  turnId: string;
  steps: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  costUsd: number;
  cacheHitRate: number;
  toolCalls: number;
  toolErrors: number;
  wallClockMs: number;
  stopReason: string;
}

function foldTurn(events: SessionEvent[]): TurnMetrics {
  // lượng token từ assistant/message, thời gian từ turn/start..turn/end,
  // số lượng công cụ từ tool/call và tool/result. Hoàn toàn không ghi thêm dữ liệu mới.
}
```

Hai hệ quả kéo theo, và cả hai đều quan trọng hơn bản thân đoạn mã rất nhiều:

**Các chỉ số có thể tính toán lại bất cứ lúc nào.** Sửa một lỗi bug trong công thức tính chi phí và bạn có thể chạy lại nó trên toàn bộ lịch sử trong quá khứ. Còn một pipeline số liệu phát ra các con số ngay tại thời điểm đó thì bất lực — những con số cũ đó sẽ mãi mãi bị sai lệch.

**Chỉ có duy nhất một nguồn sự thật.** Bảng điều khiển dashboard và bản ghi lịch sử transcript không bao giờ có thể mâu thuẫn nhau, bởi vì dashboard được trích xuất trực tiếp từ chính transcript. Đây là cùng một kỷ luật kỹ thuật từ Phần 8, được áp dụng ở một tầng cao hơn, và đó là lý do cái bẫy ở cuối bài viết này xuất hiện.

## Chi phí, được quy kết chi tiết

Tổng chi tiêu là con số vô dụng nhất mà bạn có thể tính ra. Hãy quy kết nó một cách chi tiết:

```typescript
const cost = (u: Usage, p: Pricing) =>
  (u.input_tokens * p.inPerMTok +
   u.cache_read_input_tokens * p.cacheReadPerMTok +
   u.cache_creation_input_tokens * p.cacheWritePerMTok +
   u.output_tokens * p.outPerMTok) / 1_000_000;
```

Sau đó cắt lát dữ liệu, bởi vì mỗi lát cắt sẽ trả lời một câu hỏi hoàn toàn khác nhau:

| Lát cắt | Cho bạn biết |
|---|---|
| theo người dùng | cần gặp ai để thảo luận về quy trình làm việc |
| theo phiên làm việc | những dạng tác vụ nào gây tốn kém tiền bạc |
| theo turn | thời điểm nào phiên làm việc bắt đầu đi chệch hướng |
| theo công cụ | kết quả của công cụ nào đang thống trị lượng token đầu vào |
| đã cache vs tươi mới | liệu [Phần 9](/vi/blog/building-agents/the-prompt-prefix/) có đang phát huy tác dụng hay không |

Hai chỉ số luôn khiến các đội ngũ kỹ thuật phải kinh ngạc: **tỷ lệ trúng bộ nhớ đệm (cache hit rate)** — một phiên đạt 30% có chi phí đắt gấp nhiều lần một phiên đạt 90% cho cùng một khối lượng công việc — và **tỷ trọng kết quả công cụ trong tổng token đầu vào**, vốn là chỉ số báo trước hàng đầu cho [các vấn đề về ngữ cảnh](/vi/blog/building-agents/the-context-budget/). Khi chỉ số này tăng vọt, một công cụ đáng lẽ phải dùng cơ chế spill thì lại không làm vậy.

Hãy trao cho người dùng những con số của chính họ. Lệnh `agent stats <session>` in ra lượng token, chi phí, tỷ lệ cache và số lỗi công cụ là một công cụ gỡ lỗi đắc lực cho họ và giúp giảm tải khối lượng hỗ trợ support cho bạn.

## Hệ thống phân loại lỗi (Failure Taxonomy)

"Tỷ lệ lỗi (Error rate)" không phải là một con số chung chung. Hãy phân nhóm dựa trên việc **ai là người có khả năng khắc phục nó**:

```typescript
type FailureClass =
  | 'user-cancelled'      // hoàn toàn không phải lỗi
  | 'model-refused'       // mô hình từ chối theo chính sách
  | 'context-overflow'    // lỗi của chúng ta: quản lý ngân sách kém
  | 'tool-error'          // thường là do môi trường của người dùng
  | 'provider-error'      // lỗi của họ: HTTP 5xx, chạm rate limit
  | 'harness-error'       // lỗi của chúng ta: một con bug trong mã
  | 'guard-stopped';      // do chúng ta chủ động dừng có chủ đích
```

Xếp `user-cancelled` vào cùng một rổ với `provider-error` là sai lầm từ [Phần 5](/vi/blog/building-agents/the-llm-layer/), và nó sẽ đầu độc mọi cảnh báo alert được dựng trên tổng số lỗi. Việc một người dùng đổi ý hủy lệnh không phải là một sự cố hạ tầng.

Hãy bắn cảnh báo alert cho `harness-error` và khi có sự đột biến trong `context-overflow` hoặc `guard-stopped`. Đừng bao giờ bắn alert cho `tool-error` — một bài test bị fail *chính là* một tool error, và đó là bằng chứng cho thấy agent đang làm việc đúng chức năng.

## Kế toán sự cố sập (Crash Accounting)

Tiến trình bị sập ngay ở giữa một turn. Những gì đã bị mất mát?

Bởi vì log là dạng chỉ ghi thêm và được flush xuống đĩa ngay khi các sự kiện được ghi, bạn chỉ mất tối đa các sự kiện nằm sau lần flush gần nhất. Khi khởi động lại, một phiên làm việc có sự kiện cuối cùng là `step/start` mà không hề có `step/end` là một phiên đã bị ngắt quãng — và đó là một trạng thái có thể phục hồi và *định danh được*:

```typescript
function classifyOnLoad(events: SessionEvent[]): 'clean' | 'interrupted' {
  const last = events.at(-1);
  return !last || last.kind === 'turn/end' ? 'clean' : 'interrupted';
}
```

Hãy ghi thêm một sự kiện `turn/end` với lý do `interrupted` và nói thẳng thắn với mô hình khi khôi phục lại: *"turn trước đó đã bị ngắt quãng bởi một lần khởi động lại tiến trình; hãy kiểm tra đối chiếu lại trạng thái của bất kỳ thứ gì bạn đang chỉnh sửa dở."* Việc âm thầm khôi phục mà không báo trước sẽ tạo ra một agent tự huyễn hoặc rằng một chỉnh sửa đã được áp dụng thành công trong khi thực tế thì chưa.

Có hai thứ thực sự có thể bị mất và cần phải được thừa nhận sòng phẳng: một tin nhắn đã được chấp nhận vào [inbox](/vi/blog/building-agents/the-inbox/) nhưng chưa kịp ghi vào log, và phần đuôi của một luồng stream. Cả hai đều là những khoảng thời gian cực ngắn. Nhưng không có cái nào là bằng 0 cả, và giả vờ như chúng không tồn tại chính là cách bạn tạo ra một sự cố nơi bản ghi lịch sử và thực tế mâu thuẫn nhau.

## Thời hạn lưu trữ và Sự đồng thuận

Các session log là một kho hồ sơ vô cùng phong phú: mã nguồn, đường dẫn file, và đôi khi là cả các chuỗi token bí mật mà ai đó vô tình dán vào. Hãy quyết định những điều này trước khi có người dùng đầu tiên xuất hiện, chứ không phải sau khi yêu cầu đầu tiên được gửi đi:

- **Các file log lưu ở đâu?** Lưu cục bộ trên máy người dùng theo mặc định là một câu trả lời an toàn và chính đáng. Tự động tải lên máy chủ theo mặc định là một quyết định bắt buộc phải có sự đồng thuận rõ ràng của người dùng.
- **Lưu trong bao lâu?** Đặt thời hạn lưu trữ mặc định đi kèm lệnh `agent sessions prune` và một chính sách được tài liệu hóa rõ ràng.
- **Những gì rời khỏi cỗ máy?** Nếu dữ liệu telemetry được gửi đi bất kỳ đâu, hãy công khai schema của nó. *"Dữ liệu sử dụng ẩn danh"* không phải là một schema.
- **Người dùng có thể xóa được không?** Một câu lệnh duy nhất, và nó bắt buộc phải xóa sạch thực sự — bao gồm cả chỉ mục tìm kiếm từ [Phần 12](/vi/blog/building-agents/cross-session-recall/).

Luôn luôn là cơ chế Opt-in cho bất kỳ thứ gì rời khỏi cỗ máy cá nhân. Sự cụ thể đến mức khó chịu của việc viết ra chính xác những gì bạn thu thập chính là toàn bộ mục đích của bài tập này.

## Phản hồi gắn liền với Bằng chứng thực tế

Một cú bấm ngón tay cái hướng xuống (thumbs-down) gần như vô giá trị. Một cú thumbs-down **được gắn kèm với một session id** là một ca kiểm thử eval quý giá:

```typescript
{ kind: 'feedback/given', turnId, rating: 'negative', comment, at }
```

Ghi thẳng vào trong log, để nó luôn đồng hành cùng bằng chứng thực tế. Giờ đây vòng phản hồi từ [Phần 28](/vi/blog/building-agents/evals/) chính thức khép lại: nhận phản hồi tiêu cực → tìm session tương ứng → trích xuất tác vụ → thêm vào bộ đề eval → đo lường hiệu quả bản sửa lỗi. Pipeline đó chính là sự khác biệt giữa một sản phẩm ngày càng hoàn thiện và một sản phẩm chỉ biết tích tụ những lời phàn nàn.

## Công khai minh bạch các giới hạn

Hãy xuất xưởng một bản tuyên bố trung thực về những gì agent có thể làm và những gì đang giam giữ nó. Không phải những lời lẽ pháp lý sáo rỗng — mà là danh sách mà một chuyên gia đánh giá bảo mật cần để quyết định xem liệu có nên cho phép nó chạy hay không:

- Sandbox thực sự giam giữ được những gì và không giam giữ được những gì, theo từng nền tảng hệ điều hành.
- Những gì được chạy mà không cần phê duyệt trong từng preset.
- Những dữ liệu gì sẽ rời khỏi cỗ máy, và trong trường hợp nào.
- Các kịch bản lỗi đã biết.

Hầu hết các dự án đều để những thứ này nằm rải rác trong README, changelog và trong trí nhớ của một vài lập trình viên. Việc tập hợp nó vào một nơi duy nhất chỉ mất vài giờ đồng hồ, và đó là cổ vật giúp bạn vượt qua các cuộc kiểm duyệt an ninh gắt gao nhất.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness trích xuất telemetry của phiên trực tiếp từ chính file log thay vì phát ra một luồng dữ liệu song song, và mỗi README của package đều bắt buộc phải có một mục **Known Limitations and Deferred Work (Các hạn chế đã biết và Công việc tồn đọng)** — bắt buộc phải có, được cưỡng chế bởi một cổng CI, với một allowlist tường minh cho một số ít package thực sự được miễn trừ.

Quy ước đó chính là thứ đáng học hỏi nhất từ toàn bộ bài viết này. Nó biến câu hỏi "thứ này không làm được những gì?" thành một thứ bạn bắt buộc phải viết ra ngay trong lúc đang xây dựng, nằm trong cùng một file với những gì nó làm được. Phương án thay thế là bạn sẽ phải tự khám phá ra những hạn chế của mình từ chính người dùng, trong một chiếc issue công khai, trước sự chứng kiến của toàn bộ cộng đồng.

## Cái bẫy thường gặp

Cái bẫy chính là việc dựng một hệ thống số liệu metrics nằm song song cạnh file log.

Nó diễn ra hết sức tự nhiên: bạn cần một dashboard hiển thị, vì vậy bạn phát ra các metrics — StatsD, OpenTelemetry, một bảng cơ sở dữ liệu. Giờ đây bạn có hai bản ghi về những gì đã diễn ra, chúng bắt đầu mâu thuẫn nhau ở các trường hợp biên edge cases, và bản ghi bạn mang đi trình bày cho ban tài chính không còn khớp với bản ghi bạn dùng để gỡ lỗi kỹ thuật nữa.

File log vốn dĩ đã chứa đựng mọi sự thật. Hãy trích xuất trực tiếp từ nó. Nếu một chỉ số không thể suy ra được, đó là tín hiệu cho thấy bạn đang bị thiếu một *sự kiện*, và cách khắc phục là ghi log sự kiện đó — tuyệt đối không mở thêm một đường ống thu thập thứ hai.

## Nhìn lại toàn bộ chuỗi bài viết

Hai mươi chín phần, và vòng lặp cốt lõi từ [Phần 1](/vi/blog/building-agents/an-agent-is-a-while-loop/) vẫn vẹn nguyên không hề đổi thay:

```typescript
const response = await client.chat.completions.create({ ...request, messages });
messages.push(response.choices[0].message);
if (!response.choices[0].message.tool_calls?.length) break;
messages.push(...toolResults);
```

Mọi thứ được viết ra kể từ đó đến nay đều chỉ là hệ quả của việc giữ cho bốn dòng code này sống sót: sống sót suốt một giờ đồng hồ thay vì chỉ một phút, phục vụ một người lạ xa xôi thay vì chỉ chính bạn, chạy trên một repository quan trọng mà bạn tuyệt đối không được phép làm hỏng.

Nếu chỉ có một điều duy nhất được phép đọng lại trong tâm trí bạn, hãy nhớ lấy điều này: **Hiển thị cho mô hình ⟺ Đã được ghi log**. Gần như mọi thứ khác trong loạt bài này đều bắt nguồn từ việc xác lập chiều hướng mối quan hệ đó một cách chính xác. Khôi phục phiên resume, tách nhánh fork, bản ghi transcript, thu gọn compaction, hồi tưởng recall, đo đạc telemetry, kiểm thử phát lại replay, phục hồi sau khi sập — tất cả chúng đều trở nên cực kỳ rẻ khi lịch sử chỉ là một hình chiếu từ log, và tất cả chúng đều biến thành những bài toán hóc búa nan giải khi bạn làm ngược lại.

Và hai thói quen đáng giá hơn bất kỳ thành phần kỹ thuật nào: **hãy báo lỗi thật to (fail loudly)** — mất mát năng lực trong thầm lặng là kịch bản lỗi sẽ cướp đi hàng tuần lễ làm việc của bạn — và **hãy đo lường chính xác thứ bạn tuyên bố rằng mình quan tâm**, bởi vì một agent khi âm thầm kém đi sẽ không bao giờ tự nói cho bạn biết, và các bài kiểm thử thông thường của bạn cũng vậy.
