# Kết nối Viator và GetYourGuide

**Hiện chưa có kết nối thật.** Chỉ có connector mô phỏng. Việc lên production phụ thuộc hợp đồng và phê duyệt của từng nền tảng.

## Đã làm và chưa làm

| Hạng mục | Trạng thái |
|---|---|
| Giao diện connector, mô tả khả năng | Xong |
| Connector mô phỏng và 8 kịch bản | Xong |
| Lõi nhận sự kiện, giữ chỗ, đặt, hủy, chống trùng, retry | Xong, đã test |
| Thời hạn giữ chỗ theo từng kết nối | Xong |
| Cổng HTTP nhận yêu cầu từ kênh | GetYourGuide: **bản thử**, chưa deploy (xem mục Cổng GetYourGuide). Viator: chưa làm |
| Xác minh khóa theo từng kênh, rate limit cổng | GetYourGuide: HTTP Basic và giới hạn theo IP xong. Viator: chưa làm |
| Dịch payload thật sang dữ liệu chuẩn hóa | GetYourGuide: xong theo đặc tả, chưa thử với GetYourGuide. Viator: chưa làm |
| Đẩy tình trạng chỗ về kênh | GetYourGuide: worker gửi khi có `GYG_API_*`, chưa thử với GetYourGuide. Kênh khác: ghi `needs_connector` |
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

## Đồng bộ tour từ Viator

**Hiện chỉ chạy trên dữ liệu mô phỏng.** Mã sản phẩm có tiền tố `SIM`, không lấy từ tài khoản Viator nào.

Màn hình: **Kết nối kênh > Sản phẩm kênh**.

| Việc | Cách hoạt động |
|---|---|
| Lấy danh mục | Đưa vào bảng `channel_products`, không ghi vào `tours` hay `tour_options` |
| Tạo tour và gói | Người dùng bấm từng sản phẩm, đồng thời tạo ánh xạ đã kiểm tra |
| Ghép với tour có sẵn | Người dùng chọn gói; booking đang chờ của mã đó tự xếp chuyến |
| Khi kênh đổi nội dung | Giữ bản nội bộ, gắn cờ "Có thay đổi", người dùng duyệt từng trường |
| Sản phẩm biến mất khỏi kênh | Đánh dấu "Đã gỡ", không xóa gì ở nội bộ. Lịch cũ giữ làm lịch sử, không dùng để tạo chuyến |
| Lịch và số chỗ | Lưu ảnh chụp để đối chiếu, tạo chuyến thiếu khi người dùng nhập sức chứa. Không đổi `inventory_pools` |
| Cập nhật định kỳ | Worker chạy theo chu kỳ của từng kết nối. Kết nối thật hiện ghi lỗi `needs_connector`, không báo đã đồng bộ |

### Viator cho phép gì theo tài liệu

Đọc ngày 2026-11-04 tại trang Supplier API. Một phần lấy từ bản tóm tắt, cần đọc lại khi triển khai.

| Nhu cầu | Thực tế | Hệ quả |
|---|---|---|
| Kéo danh mục | `post/v2/mappings/catalog`, do Viator host, xác thực `X-Api-Key`. **Beta**, có thể đổi. Trả `productCode`, `productName`, `productStatus`, `mappings`. Giới hạn 300 request mỗi 60 giây, 15 mỗi giây. Chỉ cho nhà cung cấp một supplier code, nếu không trả `MULTIPLE_SUPPLIER_CODES` | Làm được nhưng không có mô tả, thời lượng, múi giờ, ngôn ngữ. Vì vậy mọi trường ngoài mã, tên, trạng thái đều được phép trống |
| Khai danh mục cho Viator | `post/tourlist` (v1): Viator gọi vào hệ thống của bạn | Chiều ngược lại, không dùng để lấy dữ liệu |
| Kéo lịch và số chỗ | **Không thấy nêu.** Viator gọi `post/v2/availability/check`, `calendar` vào hệ thống của bạn; bạn đẩy `post/v2/notification/events` | Khi kết nối thật, SAHA Tour Hub là nguồn số chỗ, không phải bên nhận. Ảnh chụp lịch hiện chỉ có ở bộ mô phỏng |
| Partner API (`/products/...`) | Trang tài liệu không đọc được. Merchant và Affiliate là chương trình cho đối tác phân phối | Chưa xác minh. Không giả định nhà tổ chức tour dùng được, hay nó trả booking của bạn |

### Đọc lại 2026-11-10: điều kiện trước khi làm

Trang https://docs.viator.com/supplier-api/technical/ ghi rõ: quyền dùng API chỉ dành cho nhà tổ chức tour đã đăng ký với Viator và **reservation system được họ cho phép**; tích hợp chỉ được tiến hành sau khi Viator **đánh giá kỹ thuật và phê duyệt chính thức**, và chỉ bắt đầu phát triển khi nhà tổ chức tour đã dùng reservation system đó.

Quy trình Viator nêu: họp khởi động với Viator → thống nhất phạm vi → rà đặc tả → phát triển → Viator dựng môi trường thử → chạy thử chứng nhận qua email → Viator cấu hình production → bật cho vài sản phẩm → mở hết. **Không có môi trường thử tự phục vụ** như cổng Integrator của GetYourGuide.

Endpoint trong đặc tả (OpenAPI tải từ trang trên):

| Viator gọi vào mình | Mình gọi Viator |
|---|---|
| `POST /tourlist` (v1, danh sách sản phẩm và option) | `POST /v2/notification/events` (báo thay đổi chỗ, giá) |
| `POST /v2/availability/check`, `POST /v2/availability/calendar` (bắt buộc) | `POST /v2/notification/special-offers` |
| `POST /v2/reserve` | `POST /v2/mappings/catalog`, `connect`, `disconnect` (Beta) |
| `POST /booking`, `/booking-amendment`, `/booking-cancellation` (v1) | |
| `POST /redemption`, `POST /v2/product/special-offers` | |

Xác thực v2 bằng header API key; chỉ JSON. Lõi giữ chỗ, đặt chỗ, hủy và cách tính chỗ của cổng GetYourGuide dùng lại được; phần cần viết mới là lớp dịch định dạng Viator, có thêm đổi booking (`booking-amendment`) và lịch giá theo ngày (`calendar`).

**Không bắt đầu viết cổng Viator trước khi Viator đồng ý**, vì điều khoản của họ yêu cầu như vậy.

### Cần xác định về tài khoản

Hiện chưa rõ tài khoản đang có quyền gì. Cách kiểm tra:

1. Đăng nhập trang supplier của Viator, tìm mục kết nối hoặc API, ghi lại **supplierId** nếu có.
2. Gửi supplierAPI@viator.com các câu hỏi dưới đây.

Câu hỏi nên gửi:

- Tài khoản supplier của chúng tôi có được dùng Supplier API trực tiếp không, hay phải qua reservation system đã được chứng nhận?
- `post/v2/mappings/catalog` có mở cho chúng tôi không, tài khoản có một hay nhiều supplier code?
- Có API nào trả mô tả, thời lượng, ngôn ngữ, giờ chạy của sản phẩm cho chính nhà cung cấp không?
- Có cách nào lấy booking lịch sử không, hay phải xuất file?

### Quan sát trên cổng nhà cung cấp Viator (2026-11-05)

Trang **Account → Connectivity** có nút "Connect now" để nối với phần mềm đặt chỗ và chưa thấy hệ thống nào được nối. Chưa mở nút này nên chưa biết Tour Hub có đăng ký vào đó được không. Không thấy chỗ cấp API key trên cổng. Dữ liệu thật lấy được bằng file: danh sách sản phẩm CSV ở trang Connectivity, booking CSV ở **Performance → Booking details**, xem [IMPORT_AND_MAPPING.md](IMPORT_AND_MAPPING.md).

## GetYourGuide: chiều dữ liệu và cách kết nối

Đọc ngày 2026-11-05 từ tài liệu integrator và cổng nhà cung cấp.

**Không có API để kéo sản phẩm, lịch hay booking về.** Mọi thứ ngược chiều: GetYourGuide gọi vào API do nhà cung cấp tự dựng.

| Bên chạy API | Endpoint | Việc |
|---|---|---|
| Nhà cung cấp | `GET /1/get-availabilities/` | GetYourGuide hỏi chỗ |
| Nhà cung cấp | `POST /1/reserve/`, `POST /1/cancel-reservation/` | Giữ và hủy giữ chỗ |
| Nhà cung cấp | `POST /1/book/`, `POST /1/cancel-booking/` | Đặt và hủy |
| Nhà cung cấp | `GET /1/suppliers/{supplierId}/products/` | GetYourGuide lấy danh sách để ghép sản phẩm |
| Nhà cung cấp | `POST /1/notify/` | Báo sản phẩm bị tắt |
| GetYourGuide | `POST /1/notify-availability-update` | Nhà cung cấp báo chỗ thay đổi, bắt buộc |
| GetYourGuide | `PATCH /1/products/{GYG-Option-ID}/activate`, `POST /1/redeem-ticket`, `POST /1/redeem-booking`, `/1/deals`, `POST /1/suppliers` | Bật lại sản phẩm, xác nhận vé, ưu đãi |

Base URL phía GetYourGuide: `https://supplier-api.getyourguide.com`. Xác thực HTTP Basic cả hai chiều. Mỗi `productId` ứng với một lựa chọn tour (option), và do nhà cung cấp đặt.

Hệ quả:

- Muốn đồng bộ thật thì phải deploy một cổng HTTP công khai, và hệ thống này thành **nguồn số chỗ** của các sản phẩm đã kết nối.
- `channel_catalog_ingest` và `channel_availability_ingest` không có nguồn dữ liệu thật từ GetYourGuide. Danh mục phải đi chiều ngược lại: hệ thống trả danh sách của mình để GetYourGuide ghép.
- Lỗi nghiệp vụ trả HTTP 200 kèm `errorCode`. Trang hủy booking viết `BOOKING_ALREADY_CANCELED`, trang tổng quan viết `BOOKING_ALREADY_CANCELLED`: phải xác nhận bản đúng khi tích hợp.

Tài liệu không nêu: nơi đăng ký quyền, sandbox đầy đủ, quy trình chứng nhận, booking cũ và lịch nhập tay xử lý thế nào sau khi kết nối, cách ngắt kết nối.

Cổng nhà cung cấp không có mục API hay kết nối trong menu, chỉ có liên kết "API Integration" và "Reservation System Integration" ở chân trang. Có nút "Download bookings" ở trang booking, chưa thử định dạng file.

## Cổng GetYourGuide (bản thử, 2026-11-10)

Đọc lại tài liệu ngày 2026-11-10: changelog vẫn bản 49 (23/09/2026). Cổng Integrator (https://integrator.getyourguide.com) cho tự đăng ký, cấu hình, thử và theo dõi kết nối. Bắt buộc: hỏi chỗ, giữ, hủy giữ, đặt, hủy đặt, và báo cập nhật chỗ. Uptime 99,8%/tháng; reserve < 3 giây, book < 4 giây ở phân vị 95; quá 27 giây bị ngắt.

**Đã chạy thử trên máy, chưa thử với GetYourGuide.** Chưa có thông tin đăng nhập GetYourGuide, chưa deploy.

| Phần | Ở đâu |
|---|---|
| Luật chỗ, chống trùng, đổi booking | `supabase/migrations/20261110100000_gyg_gateway.sql`, các hàm `gateway_gyg_*` chỉ `service_role` gọi được |
| Dịch định dạng, Basic auth, mã lỗi | `packages/gyg` (`@tours/gyg`) |
| Cloudflare Worker công khai | `apps/gyg-gateway`, cấu hình trong `wrangler.jsonc` |
| Báo cập nhật chỗ | `services/tour-worker`, hàm `pushGygAvailability`, đọc `worker_gyg_availability` |

Quy ước đã chọn:

- `productId` = mã sản phẩm của ánh xạ **đã kiểm tra** (`external_option_code` rỗng), mỗi mã một gói. GetYourGuide lấy danh sách qua `/1/suppliers/{supplierAccountRef}/products/`.
- Số chỗ báo đi = số chỗ trống của **chuyến trống nhất** ở giờ đó, không cộng chuyến 1, 2, 3, vì booking không bao giờ bị tách. Nhóm lớn hơn một chuyến nhận `NO_AVAILABILITY`; không dùng `INVALID_PARTICIPANTS_CONFIGURATION` vì mã đó đổi cấu hình sản phẩm vĩnh viễn trên GetYourGuide.
- Nhóm khách: `traveler_map` của ánh xạ, không có thì mã cùng tên viết thường (`ADULT` -> `adult`). Không có thì `INVALID_TICKET_CATEGORY`. `GROUP` chưa hỗ trợ.
- Chỗ giữ: hạn bằng `hold_ttl_seconds` của kết nối, tối thiểu 900 giây; GetYourGuide mong 3600, nên đặt kết nối là 3600. Gửi lại cùng yêu cầu nhận đúng chỗ giữ cũ.
- `bookingReference` trả về là mã booking nội bộ (`SH-...`, dưới 25 ký tự). Gửi lại `book` trả đúng booking cũ.
- Đổi booking: GetYourGuide đặt mới với cùng mã GYG rồi hủy mã cũ. Booking mới có `external_ref` dạng `GYG...~2`.
- Vé: mỗi khách một mã `TEXT` dạng `SH-000123-1`, vì tour không phát vé riêng.
- Mọi lỗi trả HTTP 200 kèm `errorCode`, đúng như tài liệu chỉ mô tả mã 200. Lỗi database hoặc timeout (8 giây) trả `INTERNAL_SYSTEM_FAILURE` để GetYourGuide tự gửi lại.
- `retailPrice` chưa được ghi vào số tiền booking: tài liệu không nói đơn vị (có thể là xu). Cần xác nhận trong sandbox.
- Không ghi log dữ liệu khách: chỉ đường dẫn, mã lỗi, thời gian.

Đã sửa kèm một lỗi lõi: khi chỗ giữ lấp kín chuyến 1 mà chuyến 2 cùng giờ còn trống, `channel_book` xếp nhầm sang chuyến 2 rồi báo hết chỗ. Giờ `_resolve_item` ưu tiên chuyến của chỗ giữ.

Kiểm chứng: 14 test hàm database, 2 test trọn luồng HTTP tới Postgres, 16 test lớp HTTP, 2 test worker báo chỗ, chạy thử qua PostgREST của dev stack (doanh nghiệp `gyg-smoke`, không có thành viên), `wrangler deploy --dry-run` build được.

Giới hạn: binding `ratelimits` của Cloudflare, 1000 lệnh/phút mỗi IP, kiểm tra trước mật khẩu; vượt thì HTTP 429 `RATE_LIMIT_EXCEEDED`. Bộ đếm lỗi thì cho qua để không chặn nhầm booking.

Supabase Cloud (project `saha-tour-hub`) đã có migration này từ 2026-11-10; kết nối GetYourGuide chưa được tạo ở đó.

Chưa làm: tiền theo `retailPrice`, `GROUP`, sản phẩm theo khoảng giờ (time period), add-on, `/1/notify/`, đổi giá qua API, hủy booking sát giờ bị từ chối.

Để chạy thật:

1. Đăng ký ở cổng Integrator (doanh nghiệp tự làm), nhận thông tin gọi `notify-availability-update` và môi trường thử.
2. Trong database: tạo kết nối `getyourguide`, `mode = sandbox`, `supplier_account_ref` = mã nhà cung cấp GetYourGuide, `hold_ttl_seconds = 3600`; ghép và kiểm tra mã cho từng gói.
3. Worker: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, `GYG_INBOUND_USERNAME`, `GYG_INBOUND_PASSWORD`; đặt `SUPABASE_URL`, `GYG_CONNECTION_ID`; `pnpm --filter @tours/gyg-gateway deploy`. Khai URL Worker và tên đăng nhập, mật khẩu trên cổng Integrator.
4. `tour-worker`: đặt `GYG_API_BASE`, `GYG_API_USERNAME`, `GYG_API_PASSWORD`, và phải chạy liên tục.
5. Database cần gói có sao lưu và không tự tạm dừng: gói Free của Supabase không đạt yêu cầu 99,8%.

## Màn Kết nối API (2026-11-10)

**Kết nối kênh → Kết nối API**: mỗi kết nối GetYourGuide, Viator có danh sách bước, cấu hình (phê duyệt, mã nhà cung cấp, địa chỉ cổng https, tên bí mật, thời hạn giữ chỗ) và bảng endpoint. Bước chỉ được tick khi có bằng chứng trong hệ thống: mã đã khai, ánh xạ đã kiểm tra, cổng trả lời `/health`, kênh đã giữ hoặc đặt chỗ thành công (`last_success_at`), worker đã gửi báo chỗ. Viator hiện điều kiện phải được duyệt trước khi viết cổng.

Kết nối API có cờ `is_api` (tạo bằng `api_connection_create`, bắt đầu ở Sandbox). Tài khoản nhập file của cùng kênh không có cờ này: cổng từ chối và worker không báo chỗ thay chúng, kể cả khi chúng ở chế độ Production.

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

- GetYourGuide: đã đọc đặc tả OpenAPI của reserve, cancel-reservation, book, cancel-booking, products, notify-availability-update (2026-11-10). Chưa đọc: redemption, add-ons, deals, live availability and pricing.
- Viator: event notifications, redemption, mapping, reliability chỉ có bản tóm tắt. Trang đăng ký, FAQ, hướng dẫn chuyển v2 chưa đọc.
