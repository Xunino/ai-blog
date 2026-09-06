---
title: 'Mất mát năng lực trong thầm lặng'
description: 'Một biểu thức đặt sai chỗ. Mọi công cụ hệ thống tệp biến mất hoàn toàn. Không có lỗi nào bắn ra — agent chỉ âm thầm trở nên vô dụng một cách lặng lẽ.'
pubDate: 2026-09-22
tags: ['ai-agents', 'architecture', 'operations']
translationKey: 'agents-17-config'
sidebarTitle: '17 · Cấu hình (Config)'
order: 17
---

Bài viết này là một bản phân tích sự cố (postmortem), bởi vì hình thái của lỗi bug này quan trọng hơn bất kỳ API nào mà tôi có thể trình diễn cho bạn xem.

## Chuyện gì đã xảy ra?

Một file cấu hình tổ hợp muốn vô hiệu hóa một plugin trong một điều kiện cụ thể. Định dạng file cấu hình có hỗ trợ các biểu thức nhúng, vì vậy ai đó đã viết một đoạn cấu hình giống như bạn sẽ viết:

```yaml
- id: filesystem-tools
  name: '@scope/tool-fs'
  disabled: !!js 'ctx.mode === "restricted"'
```

Trình nạp cấu hình chỉ thực hiện nội suy các biểu thức `!!js` **bên trong khối `config` của một plugin**. Chứ không nội suy ở metadata cấp entry. Mà `disabled` lại là metadata ở cấp entry.

Vì vậy, `disabled` không hề nhận được giá trị `false`. Nó nhận được một object chưa được tính toán — mà trong JavaScript thì object luôn là truthy. Plugin đã bị vô hiệu hóa. Luôn luôn bị vô hiệu hóa. Trong mọi chế độ chạy.

Không có thứ gì bị lỗi. Cú pháp YAML vẫn parse chuẩn xác. Trình nạp loader vẫn chạy êm ru. Agent vẫn khởi động bình thường, kết nối thành công, trả lời các câu hỏi trơn tru. Chỉ có điều nó hoàn toàn không có `read`, không có `write`, không có `edit`, và cũng không có `glob`.

## Góc nhìn từ bên ngoài trông như thế nào?

Không hề có một vụ sập dịch vụ (outage) nào cả. Chỉ là các phản hồi phàn nàn rải rác trong suốt khoảng một tuần lễ, không có phản hồi nào chỉ ra được nguyên nhân thực sự:

- *"Nó cứ liên tục yêu cầu tôi phải dán nội dung file vào thay vì tự đọc chúng."*
- *"Nó bảo không tìm thấy file cấu hình — dù tôi đã đưa cho nó đường dẫn tuyệt đối chính xác."*
- *"Chất lượng dạo này tụt dốc thê thảm so với tuần trước?"*

Mỗi lời phàn nàn trên đều phản ánh chính xác hình ảnh của một agent tài năng khi nó vừa bị âm thầm phẫu thuật cắt thùy não. Nó không bao giờ tự thông báo rằng mình đang bị thiếu một năng lực nào đó. Nó sẽ **tự tìm cách đi vòng qua trở ngại**, bởi vì luồn lách qua các trở ngại chính là thứ mà nó giỏi nhất. Nó lịch sự xin người dùng dán file vào. Nó tự suy diễn nội dung từ những gì nó lờ mờ nhìn thấy được. Nó tự tin tạo ra những câu trả lời nghe có vẻ rất hợp lý từ những mẩu thông tin chắp vá không đầy đủ, suốt cả một tuần trời.

Cách sửa chỉ vỏn vẹn đúng một dòng code. Nhưng việc tìm ra nó ngốn gần như toàn bộ tuần đó, bởi vì chẳng có thứ gì để mà tìm kiếm. Không có lỗi runtime, không có ngoại lệ exception, không có cảnh báo warning, không có số liệu metric nào bất thường. Dấu vết duy nhất chỉ là sự suy giảm từ từ của một tín hiệu chất lượng mà chưa có ai đo đếm đủ chi tiết để thiết lập cảnh báo alert.

## Tại sao dạng lỗi này lại đặc thù riêng cho Agent?

Phần mềm thông thường khi mất một năng lực sẽ lăn ra chết một cách ầm ĩ. Một dependency bị thiếu sẽ ném ra lỗi ngay khi khởi động. Một tham chiếu dịch vụ null sẽ quăng ngoại lệ ở lần sử dụng đầu tiên. Bạn nhận được một stack trace với số dòng code rõ ràng.

Nhưng một agent thì lại hấp thụ toàn bộ sự mất mát đó vào bên trong:

> **Mất mát năng lực trong thầm lặng (Silent capability loss) là kịch bản lỗi tồi tệ nhất của một hệ thống agent.** Hoàn toàn không có ngoại lệ nào bị ném ra, bởi vì chẳng có đoạn mã nào bị lỗi cả. Mô hình chỉ đơn giản là tự tìm đường vòng qua sự thiếu hụt đó và đưa ra một câu trả lời kém chất lượng hơn — và trớ trêu thay, *việc cố tạo ra câu trả lời bất chấp mọi trở ngại* lại chính là hành vi cốt lõi mà bạn đã dày công huấn luyện cho nó.

Sự thiếu vắng đó vô hình ở cả hai đầu. Hệ thống không hề biết một công cụ đang bị thiếu — xét theo góc độ của registry, mọi thứ hoàn toàn bình thường. Mô hình cũng không hề hay biết — nó chưa từng nhìn thấy công cụ đó, nên nó chẳng có gì để mà nhớ nhung hay phàn nàn. Đối tượng duy nhất có thể nhận ra điều này là người dùng, và những gì họ quan sát được chỉ là "nó dạo này kém đi", vốn không phải là một bản báo cáo lỗi mà bạn có thể bắt tay vào sửa chữa ngay được.

## Quy tắc vàng

> Cấu hình sai bắt buộc phải báo lỗi **thật to (loudly)**, tại **thời điểm sớm nhất có thể phân giải được**.

Hai nửa của quy tắc, và nửa thứ hai chính là nơi đòi hỏi sự phán đoán kỹ thuật sâu sắc.

**Báo lỗi to** có nghĩa là: từ chối khởi động. Không phải là một dòng warning nằm trong file log trôi tuột qua màn hình lúc boot. Không phải là chế độ hoạt động suy thoái (degraded mode). Hãy thoát tiến trình kèm theo một thông báo nêu đích danh tên file, số dòng, và điều gì đã được kỳ vọng ở đó.

**Thời điểm sớm nhất có thể phân giải** bởi vì không phải mọi thứ đều có thể kiểm tra được ngay lúc nạp:

| Kiểm tra được ngay lúc nạp (Load) | Kiểm tra được ở lần sử dụng đầu tiên (First use) |
|---|---|
| Tên plugin không xác định | Dịch vụ từ xa không thể tiếp cận được |
| Trường lạ trong một khối cấu hình | Thông tin xác thực bị nhà cung cấp từ chối |
| Bất đồng bộ về kiểu dữ liệu (Type mismatch) | ID mô hình bị adapter từ chối |
| Công cụ được tham chiếu mà không có plugin nào đăng ký | Binary của sandbox bị thiếu trên máy host này |
| Biểu thức đặt vào vị trí không hỗ trợ nội suy | Thư mục làm việc đã bị xóa sau khi khởi động |

Cột bên trái: bắt buộc phải báo lỗi ngay lúc boot. Cột bên phải: bắt buộc phải báo lỗi ở lần dùng đầu tiên, với một thông báo lỗi nêu đích danh cấu hình nào đã gây ra nó — không phải một lỗi chung chung như `ENOENT`, mà là `sandbox backend "bwrap" đã được cấu hình nhưng chưa được cài đặt trên hệ thống`.

Con đường không bao giờ được phép chấp nhận chính là con đường thỏa hiệp ở giữa: nhận thấy có điều gì đó sai sai nhưng vẫn tiếp tục chạy với ít năng lực hơn.

<figure class="dg">
  <img src="/diagrams/part17-config-fail-loudly.svg" alt="Các tầng xếp chồng hợp nhất thành một cấu hình hiệu dụng duy nhất; việc in cây hợp nhất với nguồn gốc xuất xứ trên từng dòng biến một sự cố thành việc đọc hiểu đơn giản." loading="lazy" />
  <figcaption><strong>Hãy xây dựng tính năng duy nhất này.</strong> Nó chỉ tốn một buổi chiều nhưng sẽ biến câu hỏi "tại sao agent dạo này kém đi?" thành một số dòng code cụ thể.</figcaption>
</figure>

## Ba cơ chế cốt lõi

**Xác thực schema nghiêm ngặt, từ chối mọi key lạ.**

```typescript
const EntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  disabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();          // ← từ khóa quan trọng nhất
```

Hàm `.strict()` là thứ biến một lỗi gõ nhầm như `denny: ['bash']` thành một lỗi cú pháp thay vì biến nó thành một phiên làm việc tự huyễn hoặc rằng mình đã được hạn chế. Mọi lỗi chính tả trong key cấu hình đều là một vụ mất mát năng lực trong thầm lặng đang chờ chực bùng nổ; việc parse lỏng lẻo dễ dãi chính là con đường đưa tất cả chúng lọt qua cửa.

Và hãy xác thực đúng *vị trí*, chứ không chỉ xác thực kiểu dữ liệu. Lỗi bug ở đầu bài nếu được kiểm tra boolean chặt chẽ thì đã bị bắt bài — nhưng tuyến phòng thủ thực sự là hiểu rõ `disabled` không hỗ trợ nội suy và chủ động từ chối một marker chưa được tính toán ngay tại vị trí đó.

**Phân giải các tham chiếu ngay lúc nạp.**

```typescript
function verifyReferences(entries: Entry[], registry: PluginRegistry) {
  for (const e of entries) {
    if (!registry.has(e.name)) throw new ConfigError(`${e.id}: không tìm thấy plugin "${e.name}"`);
    for (const dep of registry.get(e.name).inject ?? []) {
      if (!provides(entries, dep)) {
        throw new ConfigError(`${e.id}: cần dịch vụ "${dep}", nhưng không có thành phần nào trong cấu hình này cung cấp`);
      }
    }
  }
}
```

Một plugin gọi tên một provider không hề được gắn kết chính là người anh em sinh đôi lúc nạp của cùng một dạng lỗi này: một thứ mà cấu hình đã hứa hẹn, nhưng lại âm thầm vắng mặt.

**Làm cho cây cấu hình sau khi merge có thể in ra được dễ dàng.**

```bash
$ agent --dump-config
```

```yaml
- id: filesystem-tools          # base/cordis.yml:41
  name: '@scope/tool-fs'
  disabled: true                # ← profiles/restricted.patch.yml:12
```

Đây chính là tính năng có thể tóm gọn lỗi bug trên chỉ trong vòng vài phút. Kiến trúc cấu hình phân tầng từ [Phần 13](/vi/blog/building-agents/plugins-and-capability-seams/) đồng nghĩa với việc giá trị hiệu dụng của bất kỳ hàng nào cũng là kết quả cộng dồn của nhiều file khác nhau, và việc *file nào đã giành chiến thắng sau cùng* chính xác là câu hỏi bạn đau đáu nhất giữa một sự cố. Hãy in ra cây cấu hình đã hợp nhất kèm theo nguồn gốc xuất xứ trên từng dòng.

Nếu bạn chỉ được chọn làm một việc duy nhất từ bài viết này, hãy làm tính năng này. Nó chỉ tốn một buổi chiều nhưng chuyển hóa bài toán "tại sao agent kém đi?" từ một cuộc khảo cổ mò mẫm thành một việc đọc văn bản đơn thuần.

## Tự soi chiếu (Introspection) ngay lúc runtime

Lệnh `--dump-config` trả lời cho câu hỏi những gì đã được *cấu hình*. Nhưng một câu hỏi thứ hai thường xuất hiện trong các sự cố: những gì *thực sự đang được gắn kết ngay lúc này*?

Chúng khác nhau nhiều hơn bạn tưởng — một plugin có thể đã được cấu hình nhưng thất bại khi kích hoạt, hoặc đã được gắn kết nhưng không hề đăng ký bất kỳ thứ gì.

```typescript
{
  name: 'inspect_runtime',
  description: 'Liệt kê các plugin và dịch vụ hiện đang được nạp, cùng các công cụ mà mỗi thành phần đã đăng ký.',
  async execute() {
    return JSON.stringify(runtime.plugins().map((p) => ({
      name: p.name,
      status: p.status,               // active | failed | disabled
      provides: p.services,
      tools: p.registeredTools,
    })), null, 2);
  },
}
```

Trao công cụ này cho *mô hình* không phải là một chiêu trò quảng cáo. Một agent có khả năng tự trả lời "tôi có công cụ `write` không?" có thể nói thẳng với người dùng rằng nó đang bị thiếu công cụ đó, đó chính là điều duy nhất có thể rút ngắn một tuần lễ điều tra sự cố xuống chỉ còn một giờ đồng hồ.

## Tải lại nóng (Hot Reload), và ranh giới của nó

Một khi cấu hình đã là dữ liệu phân tầng, việc tải lại một tầng patch mà không cần khởi động lại toàn bộ tiến trình trở nên khả thi — và cực kỳ hữu ích trong quá trình tinh chỉnh tổ hợp.

Ranh giới ở đây không phải là một tùy chọn lỏng lẻo:

> Chỉ tải lại những gì **chưa được trao quyền cho người khác**. Tuyệt đối không bao giờ tải lại bên dưới một ứng dụng vốn đã đang nắm quyền sở hữu công việc.

Cụ thể: một phiên tương tác chạy dài có thể tải lại các tầng patch ở giữa các turn. Còn một runner chạy một lần (one-shot runner), một máy chủ giao thức stdio, một máy chủ SDK — những thành phần này bàn giao toàn bộ vòng đời của chúng cho một caller ngay khi khởi động, và việc tráo đổi các dependency của chúng giữa chừng sẽ phá vỡ bản hợp đồng đó. Những thành phần đó áp dụng toàn bộ các tầng một lần duy nhất và dừng theo dõi thay đổi.

Đó là một quyết định theo từng ứng dụng cụ thể, được đưa ra có chủ đích và được ghi thành văn bản. Không phải là một công tắc bật tắt cẩu thả trên toàn cục.

## Phiên bản hoàn chỉnh trông như thế nào?

Bản postmortem ở trên được trích xuất từ chính DeepSeek Harness — file `docs/postmortem/0002-js-expression-disabled-filesystem-tools.md`. Điều rất đáng học hỏi là nó *thực sự tồn tại*: sự cố đã tạo ra một bản ghi bằng văn bản với dạng lỗi được định danh rõ ràng, và cái tên đó giờ đây đã trở thành một phần của bộ từ vựng dùng chung. "Mất mát năng lực trong thầm lặng" là thứ mà mọi người có thể gắn cờ ngay trong quá trình review mã nguồn.

Các cơ chế phòng vệ có cấu trúc được thiết lập ngay sau đó:

**`verify-cordis-config` là một cổng kiểm tra bắt buộc trong CI.** Tên các plugin trần bắt buộc phải xuất hiện trong danh sách dependencies của bản kê khai resolver manifest. Một cấu hình tham chiếu tới một thứ không thể phân giải sẽ làm rớt bài build, chứ không chờ đến lúc runtime mới phát hiện.

**`--dump-config` in ra cây cấu hình đã hợp nhất**, và tài liệu chỉ định nó là bước gỡ lỗi đầu tiên cho bất kỳ thứ gì có liên quan đến cấu hình tổ hợp.

**"Cấu hình sai phải báo lỗi to"** được khắc sâu vào quy ước của repository, nằm song song với nguyên tắc "không bao giờ âm thầm bỏ qua một đối tượng tham chiếu bị thiếu". Không phải là một luật lint hình thức — mà là một quy tắc mà các reviewer áp dụng thực tế.

## Cái bẫy thường gặp

Cái bẫy chính là việc dùng giá trị dự phòng "an toàn" (safe fallback).

```typescript
const mode = config.sandboxMode ?? 'workspace-write';   // nghe rất hợp lý!
const tools = config.tools ?? [];                       // vô hại!
const preset = presets[config.preset] ?? presets.normal; // quá chuẩn mực!
```

Mỗi dòng code trên đều là mầm mống của lỗi bug. Một lỗi gõ sai chính tả `sandboxMode` sẽ âm thầm nhận giá trị mặc định. Một cái tên preset gõ nhầm không tìm thấy sẽ âm thầm nhận `normal` — vốn dĩ có thể *thoáng hơn rất nhiều* so với những gì người ta định yêu cầu, và yêu cầu thắt chặt an toàn hơn bốc hơi không một dấu vết.

Giá trị mặc định chỉ đúng đắn khi một giá trị **bị vắng mặt (absent)**. Chúng hoàn toàn sai lầm khi một giá trị **bị sai (wrong)**:

```typescript
if ('sandboxMode' in config && !isValidMode(config.sandboxMode)) {
  throw new ConfigError(`sandboxMode: "${config.sandboxMode}" không phải là một chế độ hợp lệ`);
}
const mode = config.sandboxMode ?? 'workspace-write';
```

Vắng mặt có nghĩa là "bạn không yêu cầu gì cả" — hãy lấy mặc định. Hiện diện nhưng không hợp lệ có nghĩa là "bạn đã yêu cầu một thứ không hề tồn tại" — và việc âm thầm tiếp tục chạy chính là cách mà một tuần làm việc của bạn biến mất vào hư không.

## Tiếp theo

**[Phần 18 — Thế giới thực thi (The Execution World)](/vi/blog/building-agents/the-execution-world/)**. Agent chạy trên máy của bạn. Bây giờ nó phải chạy trong một sandbox từ xa. Hãy đếm những nơi bạn bắt buộc phải chỉnh sửa — con số đó sẽ cho bạn biết liệu Phần 13 có thực sự đi vào đời sống hay không.
