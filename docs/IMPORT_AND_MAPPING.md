# Nhập dữ liệu và ghép mã

## Ghép mã sản phẩm

Vào **Kết nối kênh > Ghép mã sản phẩm**.

1. Mỗi dòng nối một cặp (tài khoản, mã sản phẩm, mã lựa chọn) với một gói nội bộ.
2. Bật **Đã kiểm tra** sau khi đối chiếu đúng sản phẩm. Chỉ dòng đã kiểm tra mới được dùng để xếp chuyến.
3. Khi bật, các booking đang chờ của mã đó được xếp chuyến ngay nếu còn chỗ.

Hệ thống không bao giờ ghép theo tên. Booking mang mã lạ vẫn được lưu, trạng thái **Chưa ghép mã**, và mã đó tự xuất hiện trong danh sách chờ kiểm tra.

Booking chỉ được xếp vào chuyến có sẵn. Hệ thống không tự tạo chuyến: chưa có chuyến thì booking ở trạng thái **Chưa xếp chuyến**.

## Nhập booking từ CSV

Vào **Nhập dữ liệu**.

1. Tải file `.csv`, tối đa 5 MB và 5.000 dòng. Nhận dấu phẩy, chấm phẩy, tab.
2. Chọn tài khoản kênh. Mã booking chỉ duy nhất trong một tài khoản.
3. Ánh xạ cột. Hệ thống đoán theo tên cột, luôn xem lại được.
4. Xem trước: mỗi dòng được phân loại **Tạo mới**, **Cập nhật**, **Trùng** hoặc **Lỗi**.
5. Xác nhận. Tải được danh sách lỗi.

| Trường | Bắt buộc | Định dạng |
|---|---|---|
| Mã booking | Có | |
| Mã sản phẩm | Có | Khớp với bảng ghép mã |
| Ngày đi | Có | `YYYY-MM-DD` hoặc `DD/MM/YYYY`. Không nhận `MM/DD` để tránh nhầm ngày |
| Giờ đi | Không | `HH:mm` |
| Người lớn, trẻ em, em bé | Tổng lớn hơn 0 | Số nguyên |
| Giá trị | Không | `1234.50`, `1.234,50`, `1,234.50` |
| Tiền tệ | Khi có giá trị | 3 chữ cái |
| Trạng thái | Không | confirmed, pending, cancelled, completed, hoặc tiếng Việt. Trống là đã xác nhận |

Ví dụ:

```csv
Booking Reference,Product Code,Travel Date,Time,Adults,Children,Amount,Currency,Hotel
BR-1001,VHLBENT,15/01/2030,08:00,2,1,"120,00",USD,Sofitel Metropole
```

### Quy tắc an toàn

- Nhập lại đúng file không tạo trùng: mọi dòng thành **Trùng**.
- Xác nhận lặp cùng một lượt chỉ nhập một lần.
- Booking đang đồng bộ trực tiếp từ kênh không bị file ghi đè.
- Booking lịch sử được tính vào sức chứa. Chuyến đầy thì vào hàng chờ, không vượt sức chứa.
- Không có giá trị thì để "chưa có dữ liệu", không coi là 0.
- Nguồn file, người nhập, thời điểm nhập được lưu ở **Lịch sử nhập**.

### Báo cáo booking của GetYourGuide

Kéo thẳng file `.xlsx` tải từ nút **Download bookings** trên cổng nhà cung cấp vào **Nhập dữ liệu**, chọn tài khoản kênh, không cần ánh xạ cột. Hệ thống gộp mọi sheet (mỗi sheet một ngày đi).

| Cột báo cáo | Thành |
|---|---|
| `Booking Ref #` | Mã booking |
| `Date` | Ngày giờ đi, giữ nguyên giờ trong ô |
| `Product`, phần `[T-...]` | Mã sản phẩm |
| `Option`, phần trong ngoặc vuông đầu dòng | Mã lựa chọn. Báo cáo không có mã option thật, đổi tên option trên cổng thì phải ghép lại |
| `Adult`, `Child`, `Infant`... | Nhóm khách |
| `Price` | Giá trị bán và tiền tệ |
| `Net Price` | Dự kiến nhận. Phí kênh suy ra bằng `Price - Net Price` khi cùng tiền tệ |

Giới hạn:

- Định dạng suy ra từ một file thật, GetYourGuide không công bố. Thiếu cột thì file bị từ chối.
- Mọi dòng được coi là đã xác nhận, vì báo cáo không có cột trạng thái. **Chưa biết báo cáo có chứa booking đã hủy hay không**: cần đối chiếu với cổng. Booking hủy trên cổng sau khi nhập không tự cập nhật.
- `Purchase Date` đọc theo giờ Việt Nam, nên chỉ đúng với doanh nghiệp ở múi giờ này.
- Nhập lại cùng file không tạo trùng. Giá thay đổi thì dòng thành Cập nhật.

### Báo cáo booking của Viator

Tải ở cổng nhà cung cấp: **Performance → Booking details**, chọn ngày đi hoặc ngày đặt, khoảng ngày, định dạng CSV. Màn **Nhập dữ liệu** tự nhận ra file theo tên cột và bỏ qua bước ánh xạ. Viator không công bố định dạng này: thiếu cột thì file đi qua màn ánh xạ chung, không nhập sai.

| Cột | Xử lý |
|---|---|
| `Tour Grade Code` | `TG7~12:30` thành gói `TG7`, giờ đi 12:30. Một gói chạy nhiều giờ chỉ ghép một lần |
| `Status` | `Confirmed`, `Amended` là đang chạy, `Cancelled` là hủy. Trạng thái khác báo lỗi dòng đó. Giá trị gốc lưu ở trạng thái kênh |
| `Net Price`, `Currency` | Dự kiến nhận. Báo cáo không có giá bán và phí, nên hai giá trị đó để trống |
| `Lead traveler Contact Info` | Nhận khi đúng dạng email hoặc có từ 6 chữ số, nếu không thì bỏ |
| `Hotel Pickup` | Lưu vào điểm đón nguyên văn |

Đây là nhập file: booking đổi hoặc hủy trên cổng chỉ cập nhật khi tải và nhập lại.

### Ghép khách giữa các kênh

Khách vào chung chuyến khi các kênh cùng nằm trong một doanh nghiệp và mã của chúng được ghép vào cùng một gói nội bộ, cùng ngày và giờ. Chọn đúng tài khoản kênh khi nhập: màn nhập chưa kiểm tra file có khớp với kênh đã chọn không.

Chuyến gắn với gói chỉ nhận gói đó, nên gói ghép 2 tiếng và 4 tiếng không lẫn xe. Hệ thống chưa chặn hai booking tour riêng trùng ngày giờ vào cùng một chuyến.

## Nhập bảng đối soát

Vào **Tài chính và đối soát > Đối soát > Nhập bảng thanh toán**. Cần ánh xạ mã booking, tiền tệ, số thực nhận.

| Kết quả | Nghĩa |
|---|---|
| Khớp | Đúng mã và tiền tệ, số thực nhận bằng dự kiến. Nếu chưa có dự kiến thì chỉ khớp mã, có ghi chú |
| Lệch | Khác số dự kiến hoặc khác tiền tệ |
| Chưa tìm thấy booking | Vào hàng chờ, có thể **Gán tay**, bắt buộc ghi lý do |
| Trùng | Dòng đã có ở bảng trước |
| Không hợp lệ | Thiếu mã, tiền tệ hoặc số thực nhận |

Chỉ khi **Xác nhận đối soát** thì số thực nhận của booking mới thay đổi. Xác nhận lặp không cộng dồn. Cùng file không nhập được lần hai.
