# My Authenticator — Chrome extension

Extension Chrome (Manifest V3) chứa mã 2FA (TOTP/HOTP) của bạn, nhập từ app Authenticator trên điện thoại,
và **tự hiện mã đúng của trang** khi trang web yêu cầu xác thực hai bước.

## Cài đặt

1. Mở `chrome://extensions`, bật **Developer mode** (góc phải trên).
2. Bấm **Load unpacked** → chọn thư mục `extension/`.
3. Ghim biểu tượng 🔒 lên thanh công cụ, bấm vào để **tạo mật khẩu chính**.

## Nhập mã từ điện thoại

**Google Authenticator**: menu ⋮ → *Chuyển tài khoản* → *Xuất tài khoản* → chọn tài khoản → app hiện mã QR.
Trên máy tính, bấm biểu tượng extension → **+** (trang Quản lý) → tab:

| Cách | Khi nào dùng |
|---|---|
| **Camera** | Đưa màn hình điện thoại vào webcam. Nhiều QR (1/3, 2/3…) thì quét lần lượt. |
| **Ảnh QR** | Chụp màn hình QR trên điện thoại, chuyển sang máy rồi kéo thả / dán (⌘V). |
| **Dán URI** | Danh sách `otpauth://…` hoặc `otpauth-migration://…` (Aegis, 2FAS, Bitwarden, file sao lưu .txt). |

Ngoài ra nút **quét** trong popup đọc mã QR đang hiển thị trên tab hiện tại (vd. trang bật 2FA mới của một website).

> Microsoft Authenticator và Authy không cho xuất secret. Với các tài khoản đó, hãy tắt/bật lại 2FA trên website
> và quét QR mới bằng nút quét trong popup.

## Tự hiện mã khi trang yêu cầu 2FA

Content script nhận diện trang 2FA qua: `autocomplete="one-time-code"`, tên/id/label của ô nhập (otp, totp, 2fa, mfa,
verification code, mã xác thực…), ô 6 chữ số rời nhau, và nội dung trang (two-factor, authenticator, xác minh 2 bước…).
Một thẻ nhỏ hiện cạnh ô nhập với mã của tài khoản khớp trang → bấm **Điền** hoặc **Chép**.

**Khớp tài khoản ↔ trang** (chặt để chống trang giả mạo):
- Theo tên nhà phát hành: `GitHub` ↔ `github.com`, `Google` ↔ `accounts.google.com`. Tên công ty chỉ khớp trang gốc
  và các trang đăng nhập (`www`, `login`, `sso`, `accounts`…), không khớp mọi ứng dụng nội bộ (`jira.`, `confluence.`…).
  `google-login.com` hay `google.com.evil.io` **không** khớp.
- Nhà phát hành ghi dạng host (GitLab tự host dùng `gitlab.mbbank.com.vn`) chỉ khớp đúng host đó và subdomain của nó.
- Nhà phát hành là tên app (`Jira` ↔ `jira.mbbank.com.vn`): thẻ hiện **gợi ý** (chỉ tên, chưa hiện mã) với nút **Dùng**.
  Bấm một lần để gắn đúng host đó, từ lần sau mã tự hiện.
- Tài khoản không tự khớp: mở popup trên trang đó → **Gắn trang này** (gắn đúng host đang mở), hoặc nhập host ở cột
  *Trang web* trong trang Quản lý. Nhập `example.com` nếu muốn áp dụng cho mọi subdomain.

## Bảo mật

- Secret được mã hoá bằng AES-256-GCM, khoá dẫn xuất từ mật khẩu chính (PBKDF2-SHA256, 600.000 vòng), lưu trong `chrome.storage.local`.
- Khi mở khoá, khoá giải mã chỉ nằm trong `chrome.storage.session` (bộ nhớ, mất khi đóng trình duyệt, content script không đọc được). Tự khoá sau 30 phút không dùng (chỉnh trong Cài đặt).
- Chỉ service worker giải mã và sinh mã. Trang web chỉ nhận **mã 6 số của tài khoản khớp tên miền** — tên miền lấy từ Chrome (`sender.url`), trang không giả mạo được. Các lệnh quản lý chỉ chấp nhận từ trang của extension.
- Thẻ hiển thị nằm trong closed shadow DOM và bỏ qua click giả (`isTrusted`). Không bao giờ nhập mật khẩu chính trong trang web.
- File sao lưu (.txt) **không mã hoá** — cất giữ cẩn thận.

## Phát triển

```bash
npm test          # test RFC 4226/6238, parser QR Google Authenticator, khớp tên miền, vault
npm run dev       # http://localhost:8765 — chạy popup/options/content script với chrome.* giả lập
npm run icons     # vẽ lại icon
```

Trang thử: `/extension/popup/popup.html?seed` (tạo vault mẫu, mật khẩu `test1234`),
`/extension/options/options.html`, `/dev/fixture-2fa.html`.

```
extension/
  manifest.json
  background.js        service worker: vault, sinh mã, phân quyền message
  content/content.js   nhận diện trang 2FA + thẻ hiện mã
  popup/               danh sách mã, gắn trang, quét QR trên tab
  options/             nhập (camera / ảnh / URI), quản lý, cài đặt, bảo mật
  lib/                 base32, otp, migration (protobuf), accounts, match, vault
dev/                   test, server + chrome giả lập, trang thử
```
