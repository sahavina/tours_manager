# Vận hành

Chưa triển khai production. Đây là các yêu cầu khi triển khai.

## Thành phần

| Thành phần | Chạy ở đâu | Bí mật |
|---|---|---|
| `apps/admin` | Cloudflare Worker tĩnh | Chỉ khóa anon, công khai |
| Database, Auth, PostgREST | Supabase | Service role, chỉ ở server |
| `services/tour-worker` | Docker, 1 hoặc nhiều bản | `WORKER_DATABASE_URL` |

Deploy app cần đặt `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` lúc build.

## Trước khi đưa dữ liệu thật vào

- Không chạy `scripts/seed-demo.mjs`: script từ chối mọi database không phải local.
- Không dùng `scripts/dev-stack.mjs`: cổng xác thực trong đó không dành cho production.
- Tạo role database riêng cho worker, chỉ có quyền EXECUTE `worker_*`, thay vì `postgres`.
- Tạo tài khoản đầu tiên bằng `scripts/create-user.mjs`, gán vai trò `owner`.
- Bật giới hạn đăng nhập của Supabase Auth, tắt đăng ký công khai (`enable_signup = false`).
- Đặt CSP, HSTS và các header bảo mật ở Cloudflare cho app.

## Bí mật

- Không có bí mật trong Git; `.env*` trừ `.env.example` đã bị chặn.
- Khóa kênh nằm ở secret manager, database chỉ giữ tên.
- Trước khi lưu, payload đi qua `_sanitize_payload`, che các khóa như password, token, api_key, authorization, card_number, cvv, passport.
- Log worker không ghi payload hay dữ liệu khách.

## Dữ liệu cá nhân

- Payload sự kiện đã xử lý bị xóa nội dung sau `payload_retention_days` (mặc định 180, sửa ở Cài đặt).
- `booking_source_snapshots` và `audit_logs` **chưa có** chính sách xóa tự động: cần quyết định theo quy định áp dụng.
- Khách OTA có `marketing_consent = false`, không dùng cho tiếp thị.
- Xuất CSV cần quyền `booking.export` và được ghi nhật ký. Ô bắt đầu bằng `=`, `+`, `-`, `@` được vô hiệu hóa công thức.

## Sao lưu và phục hồi

```bash
pg_dump --format=custom --file=tourhub-YYYYMMDD.dump "$DATABASE_URL"
```

```bash
pg_restore --clean --if-exists --dbname="$DATABASE_URL" tourhub-YYYYMMDD.dump
```

Sao lưu hằng ngày, lưu ngoài máy chủ database, và thử phục hồi định kỳ. Supabase Cloud có sao lưu tự động theo gói. Các lệnh trên chưa được chạy thử trong dự án này.

## Giám sát

- `GET /health` của worker: 503 nghĩa là vòng lặp dừng hoặc mất database.
- **Kết nối kênh > Nhật ký đồng bộ**: sự kiện `failed` và `dead`.
- `outbox_events` trạng thái `dead` cần xử lý tay.
- Mọi sự kiện có `correlation_id` để lần theo qua log.

## Sự cố

| Triệu chứng | Xử lý |
|---|---|
| Worker dừng | Chỗ giữ quá hạn vẫn tự trả (số chỗ tính theo `expires_at`). Thông báo và retry chờ đến khi chạy lại |
| Sự kiện `dead` | Xem lỗi ở Nhật ký đồng bộ, sửa nguyên nhân, bấm Thử lại |
| Booking ở hàng chờ | Ghép mã, tạo chuyến, hoặc đổi chuyến rồi bấm Đã xử lý xong |
| Mất phản hồi khi gọi kênh | Không coi là thất bại: kiểm tra trạng thái trước khi gửi lại |
