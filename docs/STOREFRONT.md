# Trang đặt tour cho khách

`apps/storefront`, chạy `pnpm dev:storefront` ở http://localhost:3104. Tách hẳn trang quản trị (3101).

Trang tự thiết kế; chỉ học cách hoạt động của các sàn tour (xem tour, chọn ngày còn chỗ, gửi đặt), không dùng giao diện, thương hiệu hay nội dung của sàn nào.

## Khách làm được gì

1. Xem các tour **đã bật công khai** của một doanh nghiệp (`VITE_STOREFRONT_ORG`, mặc định `hanoi-jeep`).
2. Mở một tour: mô tả, lịch trình, bao gồm, điểm hẹn; các gói với tên hiển thị và giá.
3. Chọn gói, xem 14 ngày một lần các giờ còn chỗ, chọn số khách theo nhóm khách của doanh nghiệp.
4. Gửi yêu cầu: hệ thống tạo booking **chờ xác nhận**, giữ chỗ ngay, nguồn "Website", bật cờ cần xử lý và gửi thông báo cho nhân viên. Khách nhận mã booking.

Tiếng Anh mặc định, có nút chuyển tiếng Việt. Không có thanh toán trực tuyến, không gửi email.

## Doanh nghiệp nhập trong trang quản trị

**Tour và gói dịch vụ**:

- Tour: "Công khai trên trang đặt tour", ảnh bìa (link https), mô tả, thời lượng, bao gồm, hướng dẫn tham gia.
- Gói: "Hiện trên trang đặt tour", tên hiển thị cho khách, giá người lớn, giá trẻ em, tiền tệ. Bỏ trống giá thì khách thấy "Giá liên hệ". Em bé không tính tiền; trẻ em không có giá thì tính giá người lớn.

Không có nội dung nào được điền sẵn. Trên database ở máy dev, 5 tour Hanoi Jeep đã được bật công khai và tên gói được dịch từ tên nội bộ (ghép = Small group, riêng = Private tour) để xem thử; chưa có giá, mô tả, ảnh.

## An toàn

- Khách chưa đăng nhập (anon) chỉ gọi được `public_storefront`, `public_tour`, `public_availability`, `public_booking_request`; không đọc thẳng bảng nào.
- Số chỗ báo cho khách là của chuyến trống nhất ở mỗi giờ, nên nhóm không bao giờ bị tách sang hai chuyến.
- Giới hạn: 1 đến 20 khách, đặt trước tối đa 365 ngày, mỗi email tối đa 3 yêu cầu đang chờ trong 24 giờ, mỗi doanh nghiệp tối đa 60 yêu cầu website mỗi giờ.
- Chưa có CAPTCHA (ví dụ Cloudflare Turnstile): cần thêm trước khi mở công khai, vì yêu cầu đặt giữ chỗ thật.

## Chưa làm

- Deploy: chưa đưa lên Cloudflare hay Supabase Cloud. Migration `20261122100000_storefront.sql` mới áp ở database máy dev.
- Thanh toán, email xác nhận, tự hủy yêu cầu không được xác nhận sau một thời gian.
- Tên miền, SEO, ảnh.
