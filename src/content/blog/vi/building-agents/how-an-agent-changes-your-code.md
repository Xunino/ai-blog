---
title: 'Cách một Agent thay đổi mã nguồn của bạn'
description: 'Nó đã chỉnh sửa 14 file và làm hỏng bài build. Không có thứ gì để hoàn tác quay lại. Hai quyết định hoàn toàn tách biệt — cách nó diễn đạt một thay đổi, và cách bạn ghi nhận thay đổi đó.'
pubDate: 2026-09-24
tags: ['ai-agents', 'tools', 'developer-experience']
translationKey: 'agents-19-edits'
sidebarTitle: '19 · Chỉnh sửa mã (Edits)'
order: 19
---

Mười bốn file vừa bị thay đổi. Bài build bị vỡ nát. Bạn muốn quay lại trạng thái của bốn phút trước.

Lệnh `git stash` sẽ cuốn phăng luôn cả những dòng code dở dang của chính bạn. Lệnh `git checkout .` sẽ xóa sạch mọi thứ kể từ commit gần nhất, vốn đã diễn ra từ một giờ trước. Agent đã ghi thẳng dữ liệu xuống đĩa cứng mà không để lại bất kỳ bản ghi nào về những gì nó đã chạm vào, và người duy nhất biết rõ 14 file đó là những file nào lại chính là agent, trong một cuộc hội thoại mà bạn sắp sửa làm mất.

Có hai câu hỏi ẩn nấp ở đây, và chúng cần phải được tách bạch bởi vì chúng có những câu trả lời hoàn toàn khác nhau:

- **Agent diễn đạt một thay đổi như thế nào?** Quyết định tỷ lệ thất bại của nó thường xuyên đến mức nào.
- **Bạn ghi nhận việc một thay đổi đã xảy ra như thế nào?** Quyết định xem liệu có ai dám để nó chạy mà không cần giám sát hay không.

## Phần một: Định dạng chỉnh sửa (Edit Format)

Có ba cách để cho phép một mô hình thay đổi một file, và sự lựa chọn này không mang tính phong cách — mỗi cách đều có một tỷ lệ thất bại có thể đo đếm được rõ ràng.

**Ghi đè toàn bộ file (Whole file).** Mô hình trả về toàn bộ nội dung mới của file. Không bao giờ thất bại khi áp dụng — vì nó chỉ đơn giản là ghi đè. Nhưng tiêu tốn lượng token đầu ra tỷ lệ thuận với kích thước file, vì vậy một thay đổi 2 dòng trong một file dài 800 dòng sẽ phải viết lại cả 800 dòng. Tệ hơn nữa, quá trình sinh văn bản dài chính là nơi các mô hình hay đánh rơi dữ liệu: một hàm có thể âm thầm biến mất ở giữa chừng mà không có thứ gì cảnh báo, bởi vì mã sinh ra vẫn hoàn toàn đúng cú pháp.

**Unified diff.** Nhỏ gọn và rất dễ cho con người review. Nhưng kịch bản lỗi thì vô cùng tàn khốc: các mô hình rất kém trong việc tính toán chính xác số dòng và các khối tiêu đề hunk header. Một bản diff đúng hoàn toàn về mặt ngữ nghĩa nhưng lệch đúng 2 dòng sẽ không thể áp dụng được (patch failed), và mô hình thì ngơ ngác không hiểu tại sao.

**Tìm kiếm và thay thế (Search and replace).** Mô hình cung cấp một đoạn trích chính xác cần tìm và nội dung thay thế tương ứng. Không có số dòng nào để mà tính nhầm, lượng token đầu ra chỉ tỷ lệ thuận với phần thay đổi. Nó chỉ thất bại khi đoạn trích không khớp — do khoảng trắng thừa, do lần đọc file đã cũ, hoặc chuỗi đó xuất hiện hai lần trong file.

Dạng lỗi cuối cùng đó là thứ bạn hoàn toàn có thể dùng kỹ thuật để triệt tiêu, và đó là lý do định dạng này giành chiến thắng tuyệt đối trong thực tế:

```typescript
{
  name: 'edit',
  description:
    'Thay thế một chuỗi chính xác trong file. old_str BẮT BUỘC phải khớp duy nhất một lần, bao gồm ' +
    'cả khoảng trắng và thụt đầu dòng. Hãy bổ sung đủ dòng ngữ cảnh xung quanh để đảm bảo tính duy nhất.',
  inputSchema: { /* path, old_str, new_str */ },

  async execute({ path, old_str, new_str }, ctx) {
    const content = await ctx.fs.read(path, { encoding: 'utf8' });
    const count = content.split(old_str).length - 1;

    if (count === 0) return `Không tìm thấy chuỗi old_str trong ${path}. Hãy đọc lại file và thử lại.`;
    if (count > 1) {
      return `Chuỗi old_str khớp tới ${count} lần trong ${path}. Hãy bổ sung thêm các dòng xung quanh để phân biệt.`;
    }

    await ctx.fs.write(path, content.replace(old_str, new_str));
    return `Đã chỉnh sửa ${path}.`;
  },
}
```

> **Bắt buộc phải khớp duy nhất một lần, và hãy nói rõ điều đó trong thông báo lỗi.** Thông báo "khớp tới 3 lần" chính là thứ biến một lần sửa thất bại thành một lần thử lại thành công, bởi vì nó chỉ dẫn cho mô hình chính xác cần phải thay đổi điều gì trong yêu cầu của nó.

Sự mơ hồ đa nghĩa mới là kẻ thù thực sự, chứ không phải sự vắng mặt. Việc tự tiện thay thế vị trí *đầu tiên* trong số ba vị trí khớp là kết cục bạn tuyệt đối không bao giờ được phép dung thứ: nó báo thành công rực rỡ, nhưng thực chất đã sửa nhầm vào một hàm hoàn toàn khác.

**Đọc trước khi ghi (Read before write).** Một mô hình chỉnh sửa một file mà nó chưa từng đọc trong phiên làm việc này là nó đang làm việc dựa trên trí nhớ mơ hồ hoặc trí tưởng tượng thuần túy. Hãy cưỡng chế điều này tại điểm nối seam, không làm trên từng công cụ:

```typescript
ctx.events.on('fs/write-intent', async (intent, next) => {
  const lastRead = readLog.get(intent.path);
  if (lastRead === undefined) {
    return { kind: 'reject', reason: `Hãy đọc ${intent.path} trước khi chỉnh sửa nó.` };
  }
  if (lastRead < (await ctx.fs.stat(intent.path))!.mtimeMs) {
    return { kind: 'reject', reason: `${intent.path} đã bị thay đổi kể từ lần cuối bạn đọc nó. Hãy đọc lại.` };
  }
  return next();
});
```

Nhánh kiểm tra thứ hai là kiểm soát đồng thời lạc quan (optimistic concurrency), và nó trở nên tối quan trọng ngay khoảnh khắc có bất kỳ thứ gì khác có thể chạm vào cây thư mục — bạn, một công cụ format mã, một tiến trình watch file, hoặc một agent khác.

<figure class="dg">
  <img src="/diagrams/part19-code-edits.svg" alt="Ba định dạng chỉnh sửa với các kịch bản lỗi khác nhau, và một repository shadow git ghi lại các thay đổi của agent mà không đụng tới repository của người dùng." loading="lazy" />
  <figcaption><strong>Hai quyết định hoàn toàn tách biệt.</strong> Định dạng quyết định tỷ lệ thất bại; bản ghi quyết định xem liệu có ai dám để nó chạy mà không cần giám sát hay không.</figcaption>
</figure>

## Phần hai: Khả năng hoàn tác (Undo)

Bây giờ là nửa bài toán về việc ghi nhận. Yêu cầu ở đây rất hẹp và cực kỳ cụ thể:

> Hoàn tác tất cả những gì **agent này** đã làm, mà không được phép chạm vào bất kỳ thứ gì **tôi** đã làm, tại bất kỳ thời điểm nào.

Chỉ riêng `git` thông thường không thể diễn đạt được điều này — những thay đổi của agent và của bạn đều nằm chung trong một thư mục làm việc dirty lộn xộn. Giải pháp hiệu quả là một shadow repository: một thư mục `.git` thứ hai mà chỉ có duy nhất agent ghi vào đó.

```typescript
class Checkpoints {
  private readonly env: Record<string, string>;

  constructor(private workspace: string, shadowDir: string) {
    // Cùng thư mục làm việc, nhưng trỏ sang thư mục git khác. Thư mục .git của bạn nguyên vẹn.
    this.env = { GIT_DIR: shadowDir, GIT_WORK_TREE: workspace };
  }

  async snapshot(label: string): Promise<CheckpointId> {
    await this.git('add', '-A');
    const sha = await this.git('commit', '-m', label, '--allow-empty', '--quiet', '&&',
                               'rev-parse', 'HEAD');
    return sha.trim() as CheckpointId;
  }

  async restore(id: CheckpointId, paths?: string[]): Promise<void> {
    await this.git('checkout', id, '--', ...(paths ?? ['.']));
  }

  async diff(from: CheckpointId, to = 'HEAD'): Promise<string> {
    return this.git('diff', from, to);
  }
}
```

Bạn nhận được một lịch sử định danh theo nội dung thực thụ, các bản diff chuẩn mực, và khả năng khôi phục một phần thực sự — chỉ với cái giá của hai biến môi trường. Và các lệnh `git status`, `git stash` cùng trạng thái nhánh của người dùng hoàn toàn không hề nhìn thấy hay bị ảnh hưởng bởi bất kỳ điều gì trong số đó.

**Tạo snapshot tại các ranh giới turn.** Không làm trên từng lệnh chỉnh sửa lẻ tẻ — điều đó sẽ sinh ra hàng trăm commit rác không ai có thể điều hướng nổi. Tạo một snapshot trước lần ghi đầu tiên của turn, và một sau khi turn kết thúc. Đây lại là lúc [ranh giới turn](/vi/blog/building-agents/turn-and-step/) chứng minh giá trị: nó là đơn vị mà con người tư duy ("hãy hoàn tác những gì nó vừa làm"), vì vậy đó là đơn vị mà các checkpoint nên sử dụng.

**Khôi phục là một thao tác thực tế với một câu hỏi thực tế.** Chỉ hoàn tác file, hay hoàn tác cả file *lẫn* cuộc trò chuyện? Chỉ hoàn tác file sẽ để lại cho agent niềm tin rằng nó đã thực hiện những chỉnh sửa hiện không còn tồn tại nữa — nó sẽ bị bối rối, một cách hoàn toàn dễ hiểu. Hoàn tác cả cuộc trò chuyện đồng nghĩa với việc [fork phiên làm việc](/vi/blog/building-agents/the-session-log/) tại turn tương ứng. Hãy cung cấp cả hai lựa chọn, gọi tên chúng rõ ràng, và mặc định là chỉ hoàn tác file kèm theo một tin nhắn được tiêm vào thông báo cho agent biết những gì vừa bị revert.

## Phần ba: Hiển thị sự thay đổi cho con người

Có hai chế độ, và sự lựa chọn phụ thuộc vào mức độ tin cậy của người dùng, chứ không phải sở thích cá nhân của bạn.

**Xem xét trước khi áp dụng (Review before apply).** Agent đề xuất; bản diff được hiển thị; người dùng nhấn chấp nhận, từ chối hoặc tự tay chỉnh sửa. An toàn nhất, nhưng cũng đủ chậm chạp để người ta tắt béng nó đi ngay từ ngày thứ hai sử dụng.

**Áp dụng rồi mới xem xét (Apply then review).** Các thay đổi được ghi ngay lập tức, giao diện UI hiển thị những gì vừa thay đổi, và hoàn tác chỉ tốn đúng một cú click chuột. Nhanh hơn rất nhiều, và đó là thứ khiến agent mang lại cảm giác của một cộng sự đắc lực thay vì một biểu mẫu hành chính rườm rà. Nó chỉ có thể hoạt động được nếu hệ thống checkpoint đã tồn tại — đó là lý do nửa bài viết này bắt buộc phải đứng sau nửa bài viết trước.

Dù bằng cách nào, **hãy luôn hiển thị một bản diff, tuyệt đối không bao giờ hiển thị một đoạn tóm tắt bằng lời.** Câu nói "Tôi vừa cập nhật việc xử lý lỗi trong ba file" là hoàn toàn không thể kiểm chứng được. Một bản diff mới là thứ thực sự đã được thực thi.

## Những con số thống kê nói lên điều gì?

Đây là một trong số rất ít các quyết định thiết kế agent có số liệu nghiên cứu được công bố công khai. Bảng xếp hạng polyglot của Aider báo cáo tỷ lệ thành công theo từng mô hình *và theo từng định dạng chỉnh sửa*, và độ chênh lệch giữa các định dạng trên cùng một mô hình thường lớn hơn nhiều so với độ chênh lệch giữa các thế hệ mô hình liền kề nhau.

Hai kết luận rút ra, và cả hai đều rất đáng để hành động ngay:

**Đừng chọn theo cảm tính.** Định dạng tối ưu phụ thuộc chặt chẽ vào mô hình, và nó thay đổi qua từng thế hệ mô hình. Hãy đo lường nó trên chính codebase của bạn — đó là chủ đề của [Phần 28](/vi/blog/building-agents/evals/), và đây là bài toán thực tế nhất để hướng bộ máy đo lường đó vào.

**Theo dõi tỷ lệ thất bại khi áp dụng (apply-failure rate) như một số liệu hạng nhất.** Số lần chỉnh sửa dự định so với số lần chỉnh sửa được áp dụng thành công. Khi một mô hình mới làm con số này tăng lên, bạn đang gặp vấn đề về định dạng, chứ không phải vấn đề của mô hình — và cách khắc phục là sửa công cụ, chứ không phải sửa prompt.

## Phiên bản hoàn chỉnh trông như thế nào?

DeepSeek Harness cung cấp **hai** bộ từ vựng chỉnh sửa có chủ đích: một bộ biên tập kiểu `str_replace` với cơ chế so khớp chuỗi nguyên văn duy nhất, và một bộ ba công cụ `read`/`write`/`edit` đơn giản hơn. Hai định dạng cùng tồn tại song song không phải là sự thiếu quyết đoán — đó là sự thừa nhận rằng định dạng phù hợp phụ thuộc vào mô hình và tác vụ cụ thể, và biến điều đó thành một sự lựa chọn lúc cấu hình tổ hợp.

Quy tắc đọc-trước-khi-ghi là một package chính sách (`fs-observation-policy`) chứ không phải một câu kiểm tra nhét bừa vào từng công cụ, được hook trực tiếp vào các sự kiện ý định hệ thống tệp. Cùng một lập luận với việc [đặt sandbox tại seam tiến trình con](/vi/blog/building-agents/the-execution-world/): một điểm yết hầu duy nhất, không có lỗ hổng rải rác theo từng công cụ.

Bên ngoài repository này, không gian này đã được khám phá rất kỹ và rất đáng để học hỏi: Checkpoints của Cursor, shadow git của Cline với các tùy chọn tách biệt *restore files* / *restore files and task*, và bảng xếp hạng định dạng chỉnh sửa của Aider.

## Cái bẫy thường gặp

Cái bẫy là chọn một định dạng chỉnh sửa chỉ vì trông nó có vẻ thanh lịch.

Unified diff là định dạng mà các kỹ sư phần mềm yêu thích nhất. Nó gọn gàng, nó là thứ ngôn ngữ mà `git` sử dụng, nó hiển thị review cực kỳ đẹp mắt. Nhưng nó cũng chính là định dạng mà các mô hình ngôn ngữ dở tệ nhất khi sinh ra, bởi vì nó đòi hỏi các phép tính số học số dòng chính xác tuyệt đối về một file mà mô hình chỉ đang mường tượng trong đầu.

Một định dạng mà mô hình có thể áp dụng một cách đáng tin cậy luôn luôn đánh bại một định dạng đọc êm mắt — trong mọi trường hợp, với một khoảng cách cách biệt mà bạn hoàn toàn có thể đo lường được. Hãy đo lường nó.

## Tiếp theo

**[Phần 20 — Công việc chạy ngầm (Background Work)](/vi/blog/building-agents/background-work/)**. Lệnh `npm run build` ngốn tới tám phút đồng hồ. Mô hình không nên ngồi im một chỗ để chờ đợi, và nó tuyệt đối không được quên nhiệm vụ. Và chuyện gì sẽ xảy ra nếu phiên làm việc bị đóng lại trong lúc lệnh đó vẫn đang chạy?
