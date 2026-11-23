# Trang đặt tour cho khách

`apps/storefront`, chạy `pnpm dev:storefront` ở http://localhost:3104. Tách hẳn trang quản trị (3101).

Trang tự thiết kế; chỉ học cách hoạt động của các sàn tour (xem tour, chọn ngày còn chỗ, gửi đặt), không dùng giao diện, thương hiệu hay nội dung của sàn nào.

## Khách làm được gì

1. Xem các tour **đã bật công khai** của một doanh nghiệp (`VITE_STOREFRONT_ORG`, mặc định `hanoi-jeep`).
2. Mở một tour: mô tả, lịch trình, bao gồm, điểm hẹn; các gói với tên hiển thị và giá.
3. Chọn gói, xem 14 ngày một lần các giờ còn chỗ, chọn số khách theo nhóm khách của doanh nghiệp.
4. Gửi yêu cầu: hệ thống tạo booking **chờ xác nhận**, giữ chỗ ngay, nguồn "Website", bật cờ cần xử lý và gửi thông báo cho nhân viên. Khách nhận mã booking.

Tiếng Anh mặc định, có nút chuyển tiếng Việt. Không có thanh toán trực tuyến, không gửi email.

## Nhân viên xử lý yêu cầu

Mở booking (danh sách booking, trạng thái "Chờ xác nhận", hoặc từ thông báo "Booking cần xử lý"). Booking website đang chờ có khung "Yêu cầu đặt từ trang đặt tour" với email, điện thoại của khách và hai nút:

- **Xác nhận**: chuyển sang Đã xác nhận, giữ chỗ, tắt cờ cần xử lý (`website_request_decide`, quyền `booking.manage`).
- **Từ chối**: hủy và trả chỗ, ghi lý do.

Hệ thống chưa gửi email: nhân viên tự báo cho khách. Hủy một booking website sau này cũng không đòi "hủy tay trên kênh", vì Website là kênh của chính doanh nghiệp.

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

## Trang chủ, danh sách, chi tiết (migration `20261123110000_storefront_content.sql`)

- Trang chủ: thanh liên hệ, ô tìm tour (điểm đến, ngày, số khách), điểm đến kèm số tour, tour nổi bật, "Vì sao đặt trực tiếp" (chỉ điều có thật: hủy miễn phí theo `storefront_settings.cancel_free_hours`, chưa thu tiền, số khách tối đa, WhatsApp), hỏi đáp về quy trình đặt.
- `/tours`: lọc theo điểm đến, thời lượng (nửa ngày, cả ngày, nhiều ngày), từ khóa.
- Trang tour: bộ ảnh và xem ảnh to, nhãn thông tin, điểm nổi bật, lịch trình, bao gồm, điểm hẹn, nên mang theo, lưu ý, chính sách; khung đặt có tour ghép / tour riêng, lịch tháng, đặt hai bước, thanh đặt cố định trên điện thoại, tour tương tự.
- Dữ liệu mới: `tours.gallery, highlights, what_to_bring, good_to_know, duration_label, group_max, content_vi` (bản tiếng Việt, thiếu khóa nào thì dùng bản gốc); `tour_options.group_prices` (giá mỗi khách theo số khách, cho tour riêng), `child_note`, `content_vi`; `organizations.storefront_settings` (liên hệ, giờ hủy miễn phí).
- Tiền tính ở một chỗ: `_storefront_price` (bảng giá theo người nếu có, không thì người lớn / trẻ em / em bé miễn phí). Trang khách gọi `public_quote` để hiện tổng tiền đúng như lúc đặt.
- Production (2026-11-23): 22 tour từ hanoibackstreettours.com (website của doanh nghiệp) có nội dung, bản dịch, 204 ảnh WebP trên máy chủ (`/media/<CODE>/<n>.webp`), 7 gói tour riêng `<CODE>-PRV` theo bảng giá trên website, lịch chuyến đến 22/01/2027. Trang quản trị chưa có ô sửa các trường mới.

## Sửa nội dung trong trang quản trị

- Tour: bấm tên tour hoặc "Sửa" mở form 4 tab: Thông tin, Ảnh, Nội dung, Tiếng Việt. Danh sách (điểm nổi bật, bao gồm, lưu ý...) nhập mỗi dòng một mục; lịch trình là các bước có tiêu đề và mô tả.
- Ảnh: tải nhiều ảnh lên (thu nhỏ còn rộng 1600px, WebP, ngay trên trình duyệt), kéo thả sắp xếp, ảnh đầu là ảnh bìa, thêm bằng link https, tối đa 20 ảnh. Ảnh lưu ở bucket công khai `tour-images`, thư mục `<organization_id>/<tour_id>/`; chỉ người có `catalog.manage` của doanh nghiệp đó tải lên, đổi, xóa được (migration `20261123120000_tour_images.sql`, chỉ chạy nơi có dịch vụ lưu file). Bỏ ảnh khỏi tour không xóa file trong kho.
- Gói: thêm "Giá mỗi khách theo số người" (mỗi dòng một bậc: `2: 199`, `3-4: 180`, `7+: 160`), ghi chú giá trẻ em, bản tiếng Việt của tên và ghi chú.
- Máy chủ tự cài: dịch vụ lưu file `tourhub-storage` (storage-api, cổng 8103, `/storage/v1` qua Caddy), file ở `/srv/tourhub/storage`.

## Chưa làm

- Deploy: chưa đưa lên Cloudflare hay Supabase Cloud. Migration `20261122100000_storefront.sql` và `20261122110000_website_requests.sql` mới áp ở database máy dev.
- Thanh toán, email xác nhận, tự hủy yêu cầu không được xác nhận sau một thời gian.
- Tên miền, SEO, ảnh.
