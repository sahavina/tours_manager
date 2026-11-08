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

Quản trị viên, Nhân viên booking, Điều hành, Kế toán: đã đăng nhập từng vai trò, đối chiếu menu, nút và tab với ma trận quyền, không có lỗi console. Đã thử ghi: ghi chú booking, ghi nhận sự cố.

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
| Tab sự cố hiện với người không có `ops.read` | Kế toán thấy "Chưa có sự cố" dù đã có sự cố |
| Nhân viên booking không gán được người phụ trách | Thiếu chức năng §7.2, vì danh sách thành viên đòi `member.manage` |
| Sản phẩm đã gỡ vẫn tạo được chuyến từ lịch cũ | Tạo chuyến theo dữ liệu đã lỗi thời |

### Đồng bộ danh mục kênh (mô phỏng)

Test trên Postgres thật: nhận danh mục lặp không trùng, đổi nội dung không ghi đè tour (gỡ chốt thì test đỏ), duyệt từng trường, mã trùng không để lại tour mồ côi, ảnh chụp lịch không đổi sức chứa, phân quyền và tách doanh nghiệp, người dùng không đẩy được danh mục vào kết nối thật. Worker tự đồng bộ theo chu kỳ.

Trên trình duyệt đã thử đủ luồng: xem danh sách và lịch, tạo tour từ sản phẩm, ghép với gói có sẵn, bỏ qua, giả lập kênh đổi danh mục, duyệt áp dụng từng trường, tạo chuyến từ lịch, cảnh báo với sản phẩm đã gỡ.

### Nhập báo cáo booking GetYourGuide

Đã nhập file thật tải từ cổng nhà cung cấp qua màn **Nhập dữ liệu**: 15 booking từ 9 sheet, không dòng lỗi, nhập lại không tạo trùng, ngày giờ và số khách đối chiếu khớp với cổng ở 2 booking. Parser được test bằng dữ liệu giả; file và dữ liệu thật chỉ nằm trên máy, không vào Git.

Sau đó đã ghép 5 mã, tạo 12 chuyến và xếp đủ 15 booking trên dữ liệu đó. Sức chứa 4 khách mỗi chuyến do người dùng chọn, đưa đón của 5 gói để "Không" vì file không có thông tin. Tour, gói và chuyến được tạo qua API với quyền owner, không qua form.

Đây là nhập file, không phải đồng bộ: booking đổi hoặc hủy trên cổng không tự cập nhật. Chưa biết báo cáo có chứa booking đã hủy không. Mặc định báo cáo chỉ lấy 15 ngày đi tới, nên booking xa hơn phải chọn thêm khoảng ngày khi tải.

### Nhập báo cáo booking Viator

Đã nhập file thật tải từ cổng nhà cung cấp qua màn **Nhập dữ liệu**: 18 booking (12 đang chạy, 6 đã hủy), không dòng lỗi, nhập lại không tạo trùng. Tổng số khách và tiền dự kiến nhận khớp với file; 10 mã hiển thị trên cổng đều có trong file với ngày đi khớp. Parser được test bằng dữ liệu giả; file và dữ liệu thật chỉ nằm trên máy, không vào Git. Danh sách sản phẩm CSV chưa tải được vì khung trình duyệt chặn thao tác tự động. Đã ghép 4 mã với gói nội bộ tạo qua API; sau đó tạo 12 chuyến và xếp đủ 12 booking đang chạy. Sức chứa 12 khách mỗi chuyến do người dùng chọn, đưa đón của 4 gói để "Không".

### Ghép khách giữa GetYourGuide và Viator

Hai kênh đã được nhập lại vào một doanh nghiệp local chung: 33 booking (27 đang chạy, 6 đã hủy), 24 chuyến, 82 chỗ. Gói ghép 4 tiếng và 2 tiếng của hai kênh dùng chung một gói nội bộ, gói riêng và gói chưa rõ thời lượng để tách. Trong dữ liệu hiện tại chưa có chuyến nào có khách từ cả hai kênh, nên việc vào chung chuyến và dùng chung sức chứa mới được kiểm chứng bằng test.

Màn hình chuyến đã hiện số booking, kênh và tour riêng. Số liệu được kiểm bằng test và trên trình duyệt với dữ liệu thật. Nhãn "Ghép 2 kênh" và cảnh báo "Tour riêng bị ghép" được xem trên một chuyến demo chỉnh tạm rồi trả lại, vì dữ liệu thật chưa có trường hợp này. Hệ thống chỉ cảnh báo, chưa chặn booking thứ hai vào tour riêng, và cổng số chỗ cho kênh vẫn dùng số còn bán như cũ.

### Xếp booking đang chờ và chặn nhập nhầm kênh

Nút "Xếp booking đang chờ" ở màn Booking và sau khi nhập file: xem trước theo gói, ngày, giờ, rồi xếp vào chuyến đã có, có thể tạo chuyến còn thiếu nếu người dùng nhập sức chứa. Test database phủ các nhánh: đủ chỗ, không đủ chỗ, tour riêng, booking đã hủy, chưa ghép mã, ngày đã qua và thiếu quyền. Trên trình duyệt đã chạy nhánh tạo chuyến với một booking demo chỉnh tạm rồi trả lại. Việc xếp này chỉ chạy khi người dùng bấm, đường nhận dữ liệu từ kênh vẫn không tự tạo chuyến.

Màn nhập chặn nút tiếp tục khi file nhận diện được là báo cáo GetYourGuide hoặc Viator mà tài khoản đã chọn thuộc kênh khác. CSV ánh xạ cột tay không nhận diện được kênh nên không được chặn. Nút xuất danh sách chuyến đã được bấm thử, file có hai cột "Nguồn bán" và "Mã kênh".

### Cảnh báo trùng lịch HDV và xe

Danh sách chọn, chi tiết chuyến và bảng Điều hành báo khi HDV hoặc xe đang ở chuyến khác chồng giờ. Hệ thống chỉ cảnh báo, không chặn, và chưa tính thời gian di chuyển giữa hai chuyến. Thời lượng lấy theo gói, rồi tới tour; thiếu thời lượng mà cùng ngày thì báo "Có thể trùng lịch". Test database phủ các nhánh, và đã thử trên trình duyệt với HDV ở doanh nghiệp demo rồi gỡ ra. Với xe, nhánh này mới được kiểm bằng test.

Hanoi Jeep đã có thời lượng cho 4 gói ghi rõ 2 tiếng hoặc 4 tiếng. Gói City và Discovery chưa rõ thời lượng, nên chỉ báo "Có thể trùng lịch". Hanoi Jeep cũng chưa khai báo HDV và xe.

### Gợi ý ghép mã khi nhập

Thử trên 9 ánh xạ thật của Hanoi Jeep, bỏ từng ánh xạ rồi xem gợi ý: 7 mã ra đúng gói, 2 mã ("Tour jeep city ghép" và "Tour 2.0 tiếng" của GetYourGuide) được để chọn tay vì tên không ghi đủ thời lượng hoặc kiểu tour, không có gợi ý sai. Trên trình duyệt đã thử với file Viator giả ở doanh nghiệp demo, chỉ xem trước rồi xóa ánh xạ thử. Chưa thử với file mới thật có mã lạ.

### Tài khoản GetYourGuide thứ hai (Hanoi Military Jeep)

Báo cáo GetYourGuide có thể dùng mã tham chiếu do nhà cung cấp tự đặt (`[JEEP-HNCITY-01]`) thay cho `[T-...]`; trước bản sửa, 42 trong 49 dòng bị báo "Không đọc được mã sản phẩm". Gợi ý ghép mã dùng cả tên nội bộ trong ngoặc và tên công khai phía sau, vì phần sau mới ghi thời lượng và riêng hay ghép.

Tài khoản này đã được gộp vào Hanoi Jeep: 49 booking, 4 mã Jeep ghép vào gói có sẵn, 41 booking đã vào chuyến (28 chuyến mới, sức chứa 12). Có 2 chuyến đầu tiên chứa khách từ hai tài khoản khác nhau. Còn 8 booking chờ vì chưa có gói phù hợp: tour xe máy, food tour 3 tiếng và sản phẩm `T-1151467`.

### Báo cáo Viator tải ở giao diện tiếng Việt

Cổng Viator đổi tên cột, ngày ("thg 10 19, 2026"), dấu thập phân ("27,45") và trạng thái ("Đã xác nhận", "Đã sửa đổi", "Đã hủy") theo ngôn ngữ giao diện. Màn nhập đổi bản tiếng Việt về bản tiếng Anh trước khi nhận diện. Đã nhập file thật của tài khoản Viator thứ hai (5567092) vào Hanoi Jeep: 55 dòng, 0 lỗi. Gợi ý ghép mã chọn nhầm sang "Discovery" cho "Private 2-Hour City Jeep Tour" (mức "cần xem lại") vì tên trùng nhiều chữ, nên gói chưa rõ thời lượng vẫn dễ được gợi ý.

### Sức chứa theo gói

Mỗi gói có thể đặt "Sức chứa mỗi chuyến". Số này được dùng khi tạo chuyến mới: xếp booking đang chờ, tạo chuyến và tạo chuyến lặp. Chuyến đã tạo giữ sức chứa riêng, trừ khi bấm "Áp cho chuyến sắp tới" ở màn gói; chuyến đã có nhiều khách hơn số mới hoặc dùng chung nguồn chỗ thì giữ nguyên. Test database phủ các nhánh. Trên trình duyệt đã xem cột và ô nhập ở Hanoi Jeep, chưa lưu số nào vì chưa có số thật cho từng gói.

### Sơ đồ đón

Trang chuyến có tab "Sơ đồ đón": mỗi xe một tuyến, các điểm theo thứ tự ở tab Khách, gộp booking cùng khách sạn, kèm cảnh báo giờ đón sai thứ tự và booking chưa có điểm đón. Đây là sơ đồ thứ tự, không phải bản đồ, vì điểm đón chưa có tọa độ. Test `tour-core` phủ các nhánh. Trên trình duyệt đã xem một chuyến thật chưa chia xe, ở khung máy tính và 375 px; tuyến nhiều xe mới được kiểm bằng test.

### Nhiều chuyến cùng giờ

Một gói có thể có nhiều chuyến cùng ngày giờ (`slot_no`), để giữ mỗi chuyến trong sức chứa của gói. "Xếp booking đang chờ" tự mở chuyến tiếp theo khi đầy, tour riêng mỗi booking một chuyến, và nút "Tách chuyến" trên trang chuyến chia lại chuyến đang quá sức chứa. Booking không bị tách: đoàn lớn hơn sức chứa đi trọn một chuyến với sức chứa bằng số khách. Đổi giữa các chuyến cùng giờ không tính là phải sửa trên kênh. Lúc nhập file, booking chỉ tự vào một chuyến cùng giờ còn chỗ; nếu chỗ không đủ cho cả đoàn thì nằm ở hàng chờ để "Xếp booking đang chờ" xử lý. Test database phủ các nhánh. Hanoi Jeep đã được tách bằng đúng hàm này, nhưng nút "Tách chuyến" trên giao diện chưa được bấm thử.

### Bản đồ và tối ưu thứ tự đón

Tab "Sơ đồ đón" có bản đồ OpenStreetMap (Leaflet). Nút "Tìm vị trí" gửi tên và địa chỉ khách sạn đến Nominatim, rồi Photon, không gửi thông tin khách; chỉ nhận kết quả khi tên khớp, không thì dùng tên phố và báo gần đúng, hoặc để đặt tay. Tọa độ lưu ở `booking_pickups`, dùng lại cho cùng khách sạn và không bị đồng bộ từ kênh xóa. Nút đề xuất thứ tự tính theo đường chim bay, chưa tính đường một chiều, kẹt xe hay giờ hẹn; điểm xuất phát của xe chưa được cấu hình, nên chuyến đi bắt đầu từ điểm xa trung tâm nhóm. Giờ đón không tự đổi. Đã thử tìm vị trí và áp dụng thứ tự trên hai chuyến thật. Chưa thử trên trình duyệt: kéo điểm, đặt điểm tay và chuyến nhiều xe. Nominatim, Photon và máy chủ bản đồ công cộng có giới hạn sử dụng, khi lên production cần xem lại nhà cung cấp.

## Chưa kiểm chứng

| Hạng mục | Vì sao |
|---|---|
| **`pnpm db:start` (Supabase Auth và PostgREST thật của Supabase)** | Docker trên máy phát triển mất kết nối liên tục (`timed out dialing Hyper-V socket`). Đang dùng cổng xác thực giả lập cho dev |
| Postgres 17 | `config.toml` khai 17, đã chạy trên 18 |
| `docker compose up` cho worker | Như dòng đầu |
| Trên điện thoại thật | Chỉ mô phỏng khung 375 px |
| Đổi chuyến và chia xe bằng giao diện với nhiều người cùng thao tác | Bất biến đã test ở database, giao diện chưa thử đồng thời |
| Chế độ không có Redis dưới tải lớn | Chưa đo tải |
| Sao lưu và phục hồi | Lệnh trong OPERATIONS.md chưa chạy thử: gói Postgres đang dùng không kèm `pg_dump` |

## Chưa làm

- **Kết nối thật với Viator, GetYourGuide**: chỉ có connector mô phỏng. Xem [CHANNEL_INTEGRATION.md](CHANNEL_INTEGRATION.md).
- **Đồng bộ tour từ Viator chưa lấy được dữ liệu thật**: màn Sản phẩm kênh và worker chạy trên dữ liệu `SIM`. Chưa xác định tài khoản có quyền API gì. Theo tài liệu, Supplier API không có đường kéo số chỗ về.
- Cổng HTTP nhận yêu cầu từ kênh, nên chưa có rate limit và xác minh khóa cho chiều đó.
- Chưa quy đổi tiền tệ: mỗi tiền tệ tính riêng, nên không có bảng tỷ giá.
- XLSX: chỉ nhận báo cáo booking của GetYourGuide, còn lại là CSV. Báo cáo CSV của Viator được tự nhận diện, CSV khác đi qua màn ánh xạ cột. Nhập file chỉ có loại booking.
- Mời người dùng từ giao diện: tạo tài khoản bằng `scripts/create-user.mjs`.
- Tự tối ưu tuyến đón: chỉ sắp xếp thủ công, không tuyên bố tối ưu.
- Giới hạn đăng nhập: dựa vào Supabase Auth khi lên production, chưa cấu hình.
- Chưa deploy.

## Vấn đề nhỏ đã biết

- Console có cảnh báo `There may be circular references` khi mở vài màn của Ant Design; không thấy ảnh hưởng chức năng.
- Mã của tour đã xóa mềm vẫn giữ chỗ, nên không dùng lại được mã đó.
- Gói `antd` khoảng 1,2 MB trước nén (382 KB sau gzip), đủ dùng cho app nội bộ, chưa tối ưu.

## Khác với đặc tả

Đặc tả mặc định Next.js và Prisma cho dự án mới. Theo yêu cầu "dựa vào cấu trúc keodansaha", hệ thống dùng stack của keodansaha. Xem [DECISION_LOG.md](DECISION_LOG.md).

## Việc tiếp theo

1. Sửa Docker và giải phóng ổ C (còn khoảng 8 GB) rồi chạy `pnpm db:start`, để xác nhận trên Supabase thật.
2. Rà soát bảo mật trước khi đưa dữ liệu khách thật vào.
3. Đăng ký quyền kết nối với từng nền tảng, rồi viết cổng HTTP và connector thật.
