# Kết nối Viator và GetYourGuide

**Hiện chưa có kết nối thật.** Chỉ có connector mô phỏng. Việc lên production phụ thuộc hợp đồng và phê duyệt của từng nền tảng.

## Đã làm và chưa làm

| Hạng mục | Trạng thái |
|---|---|
| Giao diện connector, mô tả khả năng | Xong |
| Connector mô phỏng và 8 kịch bản | Xong |
| Lõi nhận sự kiện, giữ chỗ, đặt, hủy, chống trùng, retry | Xong, đã test |
| Thời hạn giữ chỗ theo từng kết nối | Xong |
| Cổng HTTP nhận yêu cầu từ kênh | **Chưa làm** |
| Xác minh khóa theo từng kênh, rate limit cổng | **Chưa làm** |
| Dịch payload thật sang dữ liệu chuẩn hóa | **Chưa làm** |
| Đẩy tình trạng chỗ về kênh | **Chưa làm**, worker chỉ ghi `needs_connector` |
| Đăng ký, chứng nhận với nền tảng | **Chưa làm**, cần doanh nghiệp thực hiện |

## Tài liệu đã đọc

Đọc ngày 2026-11-04, cần kiểm tra lại khi triển khai. Một số trang chưa đọc được nguyên văn, ghi ở cuối.

- Viator: https://docs.viator.com/supplier-api/technical/ (changelog 2.0.1, 04/09/2026)
- GetYourGuide: https://integrator.getyourguide.com/documentation/overview, https://integrator.getyourguide.com/documentation/supplier_endpoints (changelog version 49, 23/09/2026)

Cả hai đều là API dành cho nhà cung cấp, **do nền tảng gọi vào hệ thống của nhà cung cấp**. Đây không phải API affiliate.

| | Viator | GetYourGuide |
|---|---|---|
| Kiểm tra chỗ | `post/v2/availability/check`, `post/v2/availability/calendar` | `GET /1/get-availabilities/` |
| Giữ chỗ | `post/v2/reserve` | `POST /1/reserve/` |
| Hủy giữ chỗ | Không thấy nêu | `POST /1/cancel-reservation/` |
| Đặt | `post/booking` (v1.0) | `POST /1/book/` |
| Hủy | `post/booking-cancellation` (v1.0) | `POST /1/cancel-booking/` |
| Sửa | `post/booking-amendment` (v1.0) | Tạo booking mới rồi hủy mã cũ |
| Nhà cung cấp đẩy chỗ | `post/v2/notification/events` | Thông báo cập nhật chỗ, bắt buộc |
| Xác thực | Header `X-Api-Key` (v2), trường `ApiKey` (v1) | HTTP Basic cả hai chiều |
| Giữ tối thiểu | 15 phút, nhà cung cấp trả hạn | Mong muốn 60 phút, tối thiểu 15 phút |
| Lấy booking theo mã, lịch sử | Không thấy nêu | Không thấy nêu |
| Retry | Chỉ nêu cho endpoint mapping | Book thử lại tối đa 10 lần, mỗi 10 phút, phải trả lại đúng booking cũ |
| Giới hạn thời gian phản hồi | Reserve, booking 28 giây | Reserve, book 10 giây; hủy giữ 4 giây; hủy đặt 6 giây |

Hệ quả cho thiết kế:

- Giữ chỗ và đặt chỗ phải hoàn tất trong giao dịch trước khi phản hồi. `channel_reserve`, `channel_book` đã làm vậy.
- `channel_book` gọi lại trả đúng booking cũ, khớp yêu cầu retry của GetYourGuide.
- Đổi booking trên GetYourGuide là hai sự kiện: booking mới, rồi hủy mã cũ. Lõi xử lý được, cổng phải dịch đúng.
- Không có API lịch sử, nên booking trước ngày kết nối phải nhập bằng CSV.
- Không nêu thứ tự sự kiện, nên chiến lược là dùng phiên bản hoặc thời điểm nếu có, và gắn cờ `ordering_verified = false` để đối chiếu nếu không.
- GetYourGuide báo lỗi nghiệp vụ bằng HTTP 200 kèm `errorCode`: cổng phải trả đúng khuôn đó.

## Các bước để kết nối thật

1. **Đăng ký**: Viator tại https://supplier.viator.com/sign-up-info, liên hệ SupplierAPI@viator.com. GetYourGuide liên hệ theo trang integrator. Cần doanh nghiệp đứng tên.
2. **Đọc lại tài liệu**, đặc biệt các phần ghi chưa đọc nguyên văn.
3. **Viết cổng HTTP** (gợi ý Supabase Edge Function hay Cloudflare Worker như keodansaha). Mỗi kênh một adapter: xác minh khóa, dịch payload, gọi RPC bằng service role, dịch kết quả về khuôn kênh, trong giới hạn thời gian của kênh.
4. **Lưu khóa** trong secret manager; khai tên ở `credential_ref`. Không dán khóa vào database.
5. **Khai khả năng thực tế** trong `capabilities`.
6. **Thử nghiệm**: Viator có quy trình chứng nhận và Contract Testing Tool; GetYourGuide có sandbox cho một số endpoint.
7. **Chuyển chế độ**: đặt `approval_status = approved` trước khi chuyển production. Chỉ cổng thật báo được `connected` qua `connection_mark_health`.
8. **Ngày chuyển đổi**: nhập CSV booking đang mở để tính vào sức chứa trước khi mở kênh.

## Bộ mô phỏng

**Kết nối kênh > Bộ mô phỏng**, cần `connection.simulate`, chỉ hoạt động trên kết nối `mock`. Mọi mã có tiền tố `SIM`, email dùng miền `.invalid`, không có gì gửi ra ngoài.

## Mô phỏng không giả làm thật

- Ràng buộc `mock_is_never_connected`: kết nối mock không thể có `status = connected` hay `last_success_at`.
- Giao diện luôn hiện chế độ cạnh trạng thái; booking mang nhãn "Mô phỏng".
- `connection_update` không có tham số trạng thái; `connection_mark_health` không cấp cho người dùng.
- Không chuyển production nếu chưa có phê duyệt.

## Chưa đọc được nguyên văn

- GetYourGuide: chi tiết `cancel-reservation`, `cancel-booking`, thông báo cập nhật chỗ, redemption, products, add-ons.
- Viator: event notifications, redemption, mapping, reliability chỉ có bản tóm tắt. Trang đăng ký, FAQ, hướng dẫn chuyển v2 chưa đọc.
