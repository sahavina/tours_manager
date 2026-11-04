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
