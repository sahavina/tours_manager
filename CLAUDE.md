# SAHA Tour Hub

Đọc `docs/STATUS.md` (đã kiểm chứng gì, chưa gì) và `docs/DECISION_LOG.md` trước khi đổi kiến trúc.

## Ranh giới

- `apps/*`: deploy bằng wrangler. `services/*`: tiến trình Node chạy ngoài Cloudflare. `packages/*`: dùng chung.
- `tour-core` và `channels` không phụ thuộc React hay Supabase.
- Nghiệp vụ nhạy cảm (chỗ, booking, đối soát) nằm trong RPC của Postgres, không nằm ở client. Client không có quyền ghi thẳng vào bảng booking, chuyến, giữ chỗ.

## Bất biến, mọi lỗi ở đây đều im lặng

1. Đổi `committed_seats` hay `inventory_holds` phải khóa `inventory_pools` trước bằng `_lock_pools`. Số chỗ không lưu thành bộ đếm.
2. Tiền ở tầng ứng dụng là chuỗi thập phân. `null` là chưa có dữ liệu, không phải 0. Không cộng băng qua tiền tệ.
3. Đường đồng bộ `_apply_booking_data` không được chạm `booking_notes` và các cột điều hành của `booking_pickups`.
4. Kết nối mock không thể có `status = connected` hay `last_success_at`. Không thêm đường nào từ giao diện báo đã kết nối.
5. Không bịa endpoint của Viator/GetYourGuide. Đối chiếu tài liệu của họ trước, ghi vào `docs/CHANNEL_INTEGRATION.md`.
6. RLS chặn UPDATE là khớp 0 dòng, không ném lỗi: test và giao diện phải đếm dòng.
7. RPC trả `{ok, code}` cho kết quả nghiệp vụ, chỉ raise khi sai quyền. Giao diện dịch mã qua `resultMessage`, không hiện lỗi thô của Postgres.
8. Quan hệ PostgREST nhúng mà giao diện đọc như object phải có unique đúng trên các cột FK, nếu không nó trả mảng.

## Migration

- `supabase/migrations` chỉ đi tới. Migration `..._rls_grants.sql` thu hồi quyền mặc định và cấp lại: **migration mới thêm bảng hoặc hàm phải tự bật RLS và cấp quyền**, không có gì tự động.
- Thêm RPC hay cột cho giao diện thì `packages/database/src/ui-contract.test.ts` sẽ kiểm tra tên.

## Trước khi xong việc

```bash
pnpm typecheck
```

```bash
pnpm test
```

Test bảo vệ một bất biến phải từng đỏ khi cố ý làm hỏng code. Không báo "đã kiểm thử" hay "đã kết nối" nếu chưa có bằng chứng.
