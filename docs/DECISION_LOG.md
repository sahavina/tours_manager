# Quyết định kiến trúc

## 1. Dùng stack keodansaha, không dùng Next.js + Prisma

Đặc tả nói dự án mới dùng Next.js, Prisma, shadcn, BullMQ; nhưng cũng nói ưu tiên công nghệ hiện có, và yêu cầu ghi rõ "dựa vào cấu trúc keodansaha".

| Đặc tả | Ở đây | Lý do |
|---|---|---|
| Next.js App Router | React + Vite (SPA) | Giống `apps/admin` của keodansaha, deploy Cloudflare đã quen |
| shadcn/ui, TanStack Table, React Hook Form | Ant Design | Bảng, form, lịch có sẵn; giống keodansaha |
| Prisma | SQL migration | Nghiệp vụ nằm trong RPC và RLS, Prisma không diễn đạt được |
| Zod ở API | Kiểm tra trong RPC, `tour-core` | Không có tầng API trung gian |
| Auth tự chọn | Supabase Auth | Giống keodansaha |
| Redis + BullMQ | Hàng đợi PostgreSQL, `SKIP LOCKED` | Đặc tả cho phép; ít hạ tầng hơn |
| Next route handler | PostgREST + RPC | Giống keodansaha |

## 2. Nghiệp vụ tồn chỗ nằm trong database

Mọi kiểm tra và trừ chỗ chạy trong một giao dịch, dưới khóa dòng `inventory_pools`. Số chỗ tính lại từ dữ liệu gốc thay vì lưu bộ đếm, nên không có bộ đếm nào lệch được. Hold quá hạn tự mất tác dụng ngay cả khi worker dừng.

## 3. Test trên Postgres thật, không dùng PGlite

Keodansaha dùng PGlite, nhưng PGlite chỉ có một kết nối: bài tranh chỗ cuối sẽ luôn xanh dù khóa viết sai. Đã kiểm chứng: gỡ khóa thì test đỏ.

## 4. Booking kênh thiếu chỗ vào hàng chờ, không vượt sức chứa

Booking đã bán trên kênh là chuyện đã xảy ra nên không được mất, nhưng tổng cam kết cũng không được vượt sức chứa. Vì vậy booking được lưu, không chiếm chỗ, gắn cờ cần xử lý. Ngược lại, luồng giữ chỗ (kênh hỏi trước) trả `no_seats` ngay.

## 5. Không có API lấy lịch sử booking trong connector

Tài liệu Viator và GetYourGuide (đọc 2026-11-04) không nêu endpoint lấy booking theo mã hay theo lịch sử. Booking lịch sử đi qua nhập CSV, không giả định bật kết nối là có dữ liệu cũ.

## 6. Khóa API không vào database

`channel_connections.credential_ref` chỉ là tên của bí mật. Authenticated không đọc được cả cột này, chỉ thấy `has_credentials`.

## 7. Mã booking dùng sequence, có thể nhảy số

Bộ đếm trên dòng `organizations` khóa ngược thứ tự với khóa nguồn chỗ, gây deadlock.

## 8. Stack dev không Docker là công cụ phụ

Thêm vì Docker trên máy phát triển không ổn định. Cổng xác thực trong `scripts/dev-stack.mjs` chỉ dùng local; production dùng Supabase Auth.
