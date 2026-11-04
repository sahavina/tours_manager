# Trạng thái

Cập nhật 2026-11-04.

## Đã kiểm chứng bằng chạy thật

| Hạng mục | Cách kiểm chứng |
|---|---|
| Migration áp được | Áp sạch trên database mới, Postgres 18 (embedded) |
| Bất biến tồn chỗ, chống trùng, sai thứ tự, retry, phân quyền, đối soát, nhập file, phân xe | `packages/database`, Postgres thật, mỗi yêu cầu một kết nối, đúng role và JWT |
| Tranh chỗ cuối thật sự cần khóa | Gỡ khóa `_lock_pools` thì test đỏ (5 yêu cầu giữ được chuyến 3 chỗ), khôi phục thì xanh |
| Toàn luồng tạo tour đến báo cáo | `flow.test.ts` ở tầng RPC, và làm lại từng phần trên giao diện |
| Logic thuần: tiền, CSV, chuẩn hóa dòng, connector | `tour-core`, `channels` |
| Tên RPC, tham số, cột, quan hệ giao diện dùng khớp schema | `ui-contract.test.ts`, đã thử cố ý viết sai và thấy đỏ |
| Seed demo | Chạy lặp lại được qua RPC, không nguồn chỗ nào vượt sức chứa |
| Worker | Xử lý hết outbox, `/health` trả 200, sống sót khi database bị cắt kết nối và khi database bị xóa rồi tạo lại |
| Typecheck, build production | Sạch |

### Kiểm thử trên trình duyệt, qua PostgREST 16.5 thật

Chủ doanh nghiệp, mọi mục menu đều tải được dữ liệu. Đã thao tác thật:

- Đăng nhập sai và đúng, đăng xuất, tìm booking theo bộ lọc trên URL.
- 8 kịch bản của bộ mô phỏng, cả 8 cho kết quả đúng.
- Tạo booking thủ công, xem mọi tab chi tiết, hủy booking.
- Phân xe, chia khách (vượt sức chứa xe bị chặn), sửa điểm đón, đổi sức chứa (giảm dưới cam kết bị chặn).
- Nhập CSV: dòng tốt, mã lạ vào hàng chờ, dòng lỗi có lý do, nhập lại không tạo trùng.
- Ghép mã: các booking đang chờ tự được xếp chuyến.
- Đối soát: xem kết quả ghép, xác nhận.
- Thêm tour, trùng mã báo lỗi, xóa mềm, xem trước chuyến lặp.

Hướng dẫn viên trên màn 375 px: chỉ thấy chuyến được giao, điểm danh cập nhật ngay, có nút gọi và bản đồ, không tràn ngang.

Chỉ xem: menu ẩn mục nhạy cảm, không có nút ghi, vào thẳng link báo không có quyền.

Ma trận quyền của cả 7 vai trò kiểm tra qua HTTP: đúng đặc tả §5. Hướng dẫn viên đọc bảng nhạy cảm trả rỗng, đọc `credential_ref` và xuất CSV trả 403.

### Lỗi chỉ lộ ra khi chạy thật, đã sửa

| Lỗi | Hậu quả nếu để nguyên |
|---|---|
| Hash chống trùng đối soát tính cả phí | Cùng khoản tiền ở file khác cách ghi: thực nhận bị **cộng đôi** |
| `CrudPage` mất giá trị form ở lần mở đầu | Form sửa mở ra trống, nút Lưu không có tác dụng |
| Worker không bắt lỗi của connection pool | Database khởi động lại là worker sập |
| Hàm khóa viết bằng SQL | Có thể chỉ khóa một trong hai nguồn chỗ khi đổi chuyến |
| Bộ đếm mã booking trên dòng doanh nghiệp | Deadlock với khóa nguồn chỗ |
| RLS trên bảng kết nối | Cột kênh trống với nhân viên booking |
| Quan hệ `booking_financials` chưa 1-1 | "Khoản lệch" hiện chưa có dữ liệu dù đã có số |
| Khối phân công hiện với người không có `ops.read` | Kế toán thấy "Chưa phân công" dù chuyến đã phân công |
| `pnpm test` ở thư mục gốc không chạy | Tưởng đã test mà không |
| Seed lần hai lỗi | Không tái tạo được dữ liệu |

### Đồng bộ danh mục kênh (mô phỏng)

Test trên Postgres thật: nhận danh mục lặp không trùng, đổi nội dung không ghi đè tour (gỡ chốt thì test đỏ), duyệt từng trường, mã trùng không để lại tour mồ côi, ảnh chụp lịch không đổi sức chứa, phân quyền và tách doanh nghiệp, người dùng không đẩy được danh mục vào kết nối thật. Worker tự đồng bộ theo chu kỳ.

Trên trình duyệt đã thử: xem danh sách, xem lịch, tạo tour từ sản phẩm, giả lập kênh đổi danh mục, mở màn duyệt thay đổi. Chưa bấm trên giao diện: áp dụng thay đổi, ghép, bỏ qua, tạo chuyến từ lịch (đã có test ở tầng RPC).

## Chưa kiểm chứng

| Hạng mục | Vì sao |
|---|---|
| **`pnpm db:start` (Supabase Auth và PostgREST thật của Supabase)** | Docker trên máy phát triển mất kết nối liên tục (`timed out dialing Hyper-V socket`). Đang dùng cổng xác thực giả lập cho dev |
| Postgres 17 | `config.toml` khai 17, đã chạy trên 18 |
| `docker compose up` cho worker | Như dòng đầu |
| Trên điện thoại thật | Chỉ mô phỏng khung 375 px |
| Đổi chuyến và chia xe bằng giao diện với nhiều người cùng thao tác | Bất biến đã test ở database, giao diện chưa thử đồng thời |
| Vai trò Quản trị viên, Booking, Điều hành, Kế toán trên giao diện | Quyền đã kiểm tra qua HTTP; giao diện từng màn chưa bấm với từng vai trò |
| Chế độ không có Redis dưới tải lớn | Chưa đo tải |
| Sao lưu và phục hồi | Lệnh trong OPERATIONS.md chưa chạy thử |

## Chưa làm

- **Kết nối thật với Viator, GetYourGuide**: chỉ có connector mô phỏng. Xem [CHANNEL_INTEGRATION.md](CHANNEL_INTEGRATION.md).
- **Đồng bộ tour từ Viator chưa lấy được dữ liệu thật**: màn Sản phẩm kênh và worker chạy trên dữ liệu `SIM`. Chưa xác định tài khoản có quyền API gì. Theo tài liệu, Supplier API không có đường kéo số chỗ về.
- Cổng HTTP nhận yêu cầu từ kênh, nên chưa có rate limit và xác minh khóa cho chiều đó.
- Chưa quy đổi tiền tệ: mỗi tiền tệ tính riêng, nên không có bảng tỷ giá.
- XLSX: chỉ có CSV. Nhập file chỉ có loại booking.
- Mời người dùng từ giao diện: tạo tài khoản bằng `scripts/create-user.mjs`.
- Tự tối ưu tuyến đón: chỉ sắp xếp thủ công, không tuyên bố tối ưu.
- Giới hạn đăng nhập: dựa vào Supabase Auth khi lên production, chưa cấu hình.
- Chưa deploy. Chưa commit.

## Vấn đề nhỏ đã biết

- Console có cảnh báo `There may be circular references` khi mở vài màn của Ant Design; không thấy ảnh hưởng chức năng.
- Mã của tour đã xóa mềm vẫn giữ chỗ, nên không dùng lại được mã đó.
- Gói `antd` khoảng 1,2 MB trước nén (382 KB sau gzip), đủ dùng cho app nội bộ, chưa tối ưu.

## Khác với đặc tả

Đặc tả mặc định Next.js và Prisma cho dự án mới. Theo yêu cầu "dựa vào cấu trúc keodansaha", hệ thống dùng stack của keodansaha. Xem [DECISION_LOG.md](DECISION_LOG.md).

## Việc tiếp theo

1. Sửa Docker rồi chạy `pnpm db:start`, để xác nhận trên Supabase thật.
2. Rà soát bảo mật trước khi đưa dữ liệu khách thật vào.
3. Đăng ký quyền kết nối với từng nền tảng, rồi viết cổng HTTP và connector thật.
