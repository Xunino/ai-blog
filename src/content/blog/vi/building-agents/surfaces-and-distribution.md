---
title: 'Bề mặt và Phân phối: Vòng lặp không được biết ai đang theo dõi'
description: 'Terminal, trình duyệt, JSON-RPC, webhook — một agent duy nhất, bốn cánh cửa trước. Và rồi có ai đó hỏi làm thế nào để cài đặt nó trên một cỗ máy không hề có Node.js.'
pubDate: 2026-10-01
tags: ['ai-agents', 'architecture', 'distribution']
translationKey: 'agents-26-surfaces'
sidebarTitle: '26 · Bề mặt (Surfaces)'
order: 26
---

Agent của bạn chạy rất ngon lành trong terminal. Thế rồi:

- Cả đội muốn có một giao diện Web UI trực quan.
- Một đội khác muốn gọi nó từ một microservice backend của họ.
- Ai đó muốn nó tự động chạy trên mọi pull request gửi đến.
- Một tiện ích mở rộng trên IDE muốn điều khiển nó thông qua một giao thức chuẩn.

Bốn bề mặt (surfaces) giao tiếp khác nhau. Phản xạ sai lầm là tạo ra bốn codebase riêng biệt dùng chung một thư viện lõi. Phản xạ đúng đắn bắt đầu bằng một câu hỏi: **một bề mặt thực sự cần những gì?**

Hóa ra chỉ có đúng hai thứ. Một cách để *điều khiển (drive)* agent — gửi tin nhắn, hủy bỏ, đọc trạng thái. Và một cách để *theo dõi (watch)* — nhìn thấy những gì đã và đang diễn ra, ngay khi nó xuất hiện.

Bạn vốn đã xây dựng cả hai thứ đó từ trước. Việc điều khiển chính là [`ctx.agents` và hộp thư đến (inbox)](/vi/blog/building-agents/the-inbox/). Còn việc theo dõi chính là [luồng sự kiện của session log](/vi/blog/building-agents/the-session-log/).

> Vòng lặp tuyệt đối không được phép biết ai đang theo dõi nó. Mọi bề mặt đều là **bên tiêu thụ (consumer)** của cùng hai API đó. Một bề mặt mới chỉ là một plugin mới, không phải là một nhánh rẽ code mới.

## Quy tắc, và cách nó bị phá vỡ

Sự thất bại bắt đầu từ một chi tiết rất nhỏ và tích tụ dần theo thời gian:

```typescript
if (mode === 'cli') {
  process.stdout.write(chunk.text);           // ← vòng lặp giờ đây đã bắt đầu biết về bên ngoài
}
```

Chỉ một câu lệnh điều kiện duy nhất. Rồi giao diện web cần câu điều kiện của riêng nó, rồi SDK cần cái thứ ba, và giờ đây vòng lặp mang theo một tham số `mode` mà bất kỳ bề mặt tương lai nào cũng bắt buộc phải mở rộng thêm. Sáu tháng sau, không còn cái gọi là vòng lặp nữa — nó là một câu lệnh `switch-case` khổng lồ với một lệnh gọi mô hình kẹp ở giữa.

Hình thái chuẩn mực là các bề mặt phải tự đăng ký theo dõi (subscribe):

```typescript
// Vòng lặp chỉ việc phát sự kiện. Nó không cần biết ai đang lắng nghe — hay liệu có ai đang nghe hay không.
log.on('event', (e) => { /* ở đây không có thứ gì biết về terminal cả */ });

// Một bề mặt CLI, dưới dạng một plugin:
export const cliSurface: Plugin = {
  name: 'surface-cli',
  inject: ['agents', 'sessions'],
  apply(ctx) {
    ctx.effect(() => ctx.sessions.on('event', (e) => {
      if (e.kind === 'assistant/chunk') process.stdout.write(renderDelta(e.delta));
      if (e.kind === 'tool/call') process.stderr.write(dim(`  → ${e.name}\n`));
    }));
  },
};
```

Xóa bỏ plugin đó sẽ loại bỏ hoàn toàn việc in ra terminal và không ảnh hưởng tới bất cứ thứ gì khác. Đó chính là bài kiểm tra tính độc lập.

<figure class="dg">
  <img src="/diagrams/part26-surfaces-distribution.svg" alt="Mọi bề mặt cùng tiêu thụ hai API giống hệt nhau, vì vậy một bề mặt mới là một plugin chứ không phải một nhánh rẽ trong vòng lặp." loading="lazy" />
  <figcaption><strong>Một câu lệnh kiểm tra mode trong vòng lặp chính là nơi bi kịch bắt đầu.</strong> Lệnh thứ hai sẽ dễ biện minh hơn lệnh thứ nhất, và lệnh thứ tư thì chẳng cần lý do nào nữa.</figcaption>
</figure>

## Bốn hình thái vận hành

Chúng khác nhau theo một trục tọa độ quan trọng hơn nhiều so với phương thức truyền tải mạng: **ai là người sở hữu vòng đời?**

Điều này dẫn dắt các quyết định thực tế. Chế độ chạy không đầu (Headless) áp dụng cấu hình một lần duy nhất lúc khởi động, vì không có thứ gì sống lâu hơn nhiệm vụ đó. Một phiên tương tác có thể [tải lại nóng (hot-reload)](/vi/blog/building-agents/configuration-must-fail-loudly/) ở giữa các turn. Một máy chủ thì tuyệt đối không được làm vậy — nó đã bàn giao vòng đời của nó cho caller ngay từ đầu, và việc tráo đổi dependency bên dưới một phiên đang chạy sẽ phá vỡ bản hợp đồng đã cam kết.

Trường hợp webhook là trường hợp kỳ lạ nhất và rất đáng để nhấn mạnh: **hoàn toàn không có ai đang chờ đợi cả.** Không có client nào để truyền stream, không có người dùng nào ngồi trước màn hình để hỏi xin phê duyệt. Vì vậy nó cần một preset với `approval: never` và một sandbox thật chặt chẽ, và kết quả đầu ra của nó được gửi tới một nơi lưu trữ bền vững — một bình luận trên PR, một issue mới — chứ không phải gửi tới một kết nối mạng.

## Truyền luồng dữ liệu (Streaming) tới client từ xa

Một bề mặt cục bộ đọc các sự kiện trực tiếp từ bộ nhớ RAM. Còn một bề mặt từ xa cần nhận chúng qua đường truyền mạng, và việc kết nối lại (reconnection) chính là phần người ta hay làm sai:

```typescript
// Client gửi lên chỉ số sequence cuối cùng mà nó nhìn thấy.
GET /sessions/:id/events?since=142

// Server phát lại từ log, sau đó stream tiếp các sự kiện trực tiếp. Một luồng mã duy nhất.
async function* eventStream(id: SessionId, since: number) {
  for (const e of log.read().filter((e) => e.seq > since)) yield e;   // bắt kịp dữ liệu cũ
  yield* liveEvents(id);                                              // tiếp tục truyền trực tiếp
}
```

Bởi vì log là dạng chỉ ghi thêm (append-only) với chỉ số `seq` tăng đơn điệu, nên việc bắt kịp dữ liệu cũ và việc stream trực tiếp là cùng một thao tác duy nhất, chỉ khác nhau điểm bắt đầu. Một client bị rớt mạng suốt 30 giây khi kết nối lại sẽ không bị rơi rụng mất một sự kiện nào.

Nếu cố làm điều này mà không có một log bền vững, bạn sẽ phải tự sáng chế ra một ring buffer, một cửa sổ phát lại replay window, và một chính sách xem chuyện gì sẽ xảy ra khi một client bị tụt lại quá xa phía sau — ba bài toán hóc búa mà [Phần 8](/vi/blog/building-agents/the-session-log/) vốn dĩ đã giải quyết trọn vẹn từ trước.

## Sự phân chia Host / Client

Đối với một giao diện đồ họa Web GUI, trình duyệt web không thể tự ôm toàn bộ agent — agent bắt buộc phải cần tới hệ thống tệp và các tiến trình con. Vì vậy sự chia tách là tất yếu, và câu hỏi là chia tách ở đâu.

Sai lầm là tạo ra một API quá mỏng phản chiếu thẳng nội bộ của agent: trình duyệt web phải học về turns, steps, tool calls, và trạng thái activation, và mỗi lần refactor nội bộ bên dưới lại trở thành một lần phải phát hành phiên bản client mới.

Cách làm tốt hơn: **host cung cấp những gì giao diện UI cần; client chịu trách nhiệm kết xuất nó.**

```text
Host                                Client
  agents, tools, execution            kết xuất sự kiện
  session log (nguồn sự thật)         thu thập đầu vào
  ──── typed RPC + event stream ────► gửi tin nhắn
```

Điều đó đồng nghĩa với việc mỗi công cụ cần một *bản hợp đồng hiển thị (presentation contract)* nằm song song với mã thực thi của nó — một lệnh gọi và kết quả của nó nên được hiển thị ra sao. Hãy quyết định điều này ngay khi bổ sung công cụ, chứ không đợi đến khi đội ngũ UI đến gõ cửa đòi hỏi. Một công cụ khi kết xuất chỉ là một bức tường JSON vô hồn là một công cụ không ai dám tin tưởng.

## Cấu hình tổ hợp, không phân nhánh mã nguồn

Các bề mặt chia sẻ dùng chung gần như mọi thứ. Sử dụng cơ chế các tầng layer từ [Phần 13](/vi/blog/building-agents/plugins-and-capability-seams/):

```text
base bundle        tools, persistence, policy, adapters, session
  + surface        cli | web | sdk | acp | webhook
  + profile patch  môi trường triển khai cụ thể này
  + user patch     cỗ máy cá nhân này
  + --patch        lần gọi lệnh cụ thể này
```

Bổ sung một bề mặt mới chỉ là thêm một bundle. Sửa một lỗi bug trong tầng base dùng chung sẽ tự động sửa lỗi cho mọi bề mặt cùng một lúc, đó là toàn bộ mục tiêu kiến trúc và nó đáng giá hơn nhiều so với vẻ ngoài — phương án thay thế là bạn phải sửa cùng một lỗi bug bốn lần và chắc chắn sẽ bỏ sót một nơi nào đó.

## Đưa sản phẩm tới tay người dùng

Một cái cây gồm 50 package plugin không phải là một sản phẩm hoàn chỉnh. Phải có cách để người ta cài đặt nó dễ dàng.

**Duy nhất một dải phiên bản đồng bộ.** Mọi package đều được xuất xưởng cùng nhau tại cùng một phiên bản version. Việc đánh số phiên bản độc lập cho 50 package sẽ tạo ra một ma trận tương thích không ai có thể hỗ trợ nổi, và bản báo cáo lỗi đầu tiên của người dùng sẽ là một tổ hợp kỳ quái mà bạn chưa từng bao giờ kiểm thử.

**Đóng gói sẵn runtime cho những người không có sẵn môi trường.** Một Python SDK mà bắt người dùng phải tự cài đặt Node.js trước thì sẽ không bao giờ được đón nhận rộng rãi. Hãy đóng gói runtime *bên trong* file wheel — một cổ vật riêng biệt cho từng hệ điều hành và kiến trúc chip — để lệnh `pip install` là tất cả những gì người dùng cần làm.

**Các thành phần Native là các cổ vật theo từng nền tảng.** Các backend sandbox cần mã máy native. Hãy build chúng cho từng nền tảng, phát hành chúng dưới dạng prebuilt sẵn, và việc thiếu binary phải là một [lỗi báo to rõ ràng](/vi/blog/building-agents/configuration-must-fail-loudly/) chỉ đích danh nền tảng — tuyệt đối không âm thầm trôi tuột về chế độ không có sandbox.

**Hiểu rõ dấu chân tài nguyên của bạn.** File cấu hình nằm ở đâu? Các phiên làm việc lưu ở đâu? Bộ chỉ mục cache đặt ở đâu? Người dùng chắc chắn sẽ hỏi, và câu trả lời *"ở một nơi nào đó dưới thư mục home"* không phải là một câu trả lời được chấp nhận. Một thư mục gốc được tài liệu hóa rõ ràng, một câu lệnh để hiển thị nó, và một câu lệnh để dọn sạch nó.

**Nói rõ những gì nó có thể làm.** Một agent có quyền chạy lệnh shell cần phải công khai minh bạch các giới hạn của nó — những gì sandbox có thể và không thể giam giữ, những gì được chạy mà không cần phê duyệt trong từng preset, những dữ liệu gì sẽ rời khỏi cỗ máy. Không phải là những lời lẽ pháp lý hình thức: mà là danh sách thực tế mà một reviewer cần để quyết định xem liệu có nên cho phép nó chạy hay không.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness xuất xưởng năm profile — `web`, `headless`, `sdk`, `sdk-minimal`, `acp` — cùng nằm trên một bundle `dsh-base`, và thực thi nghiêm ngặt một quy tắc rất đáng sao chép nguyên văn:

> Mọi ứng dụng được hỗ trợ đều bắt đầu từ CLI `dsh` với một profile được đặt tên cụ thể.

Không có các file bin lẻ tẻ của package, không có điểm vào demo tạm bợ, không có các cây plugin nhúng thẳng tùy tiện. Có một đoạn script trong CI chuyên phân loại mọi file thực thi trong repository và sẽ đánh rớt bài build nếu có bất kỳ đường dẫn ứng dụng Node nào dám đi đường tắt vượt qua launcher chung.

Điều đó trông có vẻ nặng tính quan liêu nhưng nó là thứ giữ cho lời hứa kiến trúc luôn có hiệu lực thực tế. Ngay khoảnh khắc một bề mặt có điểm vào riêng của nó, nó sẽ bắt đầu tích tụ phần khởi tạo đặc thù của riêng nó, và phần base dùng chung sẽ không còn được dùng chung nữa.

Python SDK tuân theo cùng một kiến trúc: file wheel của nó đóng gói CLI thông thường dưới dạng một runtime đặc thù cho nền tảng và khởi chạy với cờ `--profile sdk`. Người dùng Python nhận được sự lựa chọn profile và các file patch — chứ không phải nhận một con agent hoàn toàn khác.

## Cái bẫy thường gặp

Cái bẫy chính là một câu lệnh `if (mode === 'cli')` tưởng như vô hại.

Nó hoàn toàn có thể biện minh được khi đứng một mình. Bạn đang cần in kết quả ra màn hình ngay lúc này, lớp trừu tượng thì chưa kịp dựng, một câu điều kiện là rất trung thực, bạn tự nhủ sẽ dọn dẹp nó sau.

Nhưng nó đã chính thức xác lập tiền lệ nguy hiểm rằng vòng lặp được phép biết về các bề mặt bên ngoài. Câu điều kiện thứ hai sẽ dễ biện minh hơn câu thứ nhất, và câu thứ tư thì chẳng ai thèm cần lý do nữa. Đến lúc đó, việc thêm một bề mặt mới đồng nghĩa với việc bạn phải đi lùng sục mọi câu lệnh điều kiện và thêm một nhánh `case` — và chỉ cần bỏ sót đúng một chỗ là bạn tạo ra một bề mặt chạy chập chờn lúc được lúc không, vốn là dạng lỗi khó phát hiện nhất trên đời.

Bài kiểm tra vẫn không hề thay đổi từ Phần 13: **bạn có thể xóa bỏ hoàn toàn một plugin bề mặt mà mọi thứ khác vẫn tiếp tục chạy bình thường hay không?** Nếu vòng lặp còn import bất kỳ thứ gì có hình bóng của một bề mặt bên ngoài, câu trả lời chắc chắn là KHÔNG.

## Tiếp theo

**[Phần 27 — Kiểm thử tính phi tất định (Testing Nondeterminism)](/vi/blog/building-agents/testing-nondeterminism/)**. Làm thế nào để viết một bài kiểm thử test cho một hệ thống mà mỗi lần chạy lại cho ra một kết quả khác nhau cho cùng một đầu vào, và mỗi lần chạy đều làm tốn tiền thật?
