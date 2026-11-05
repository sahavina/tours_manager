// Nhãn tiếng Việt cho trạng thái và mã kết quả RPC. Mã lạ rơi về câu chung, không rò chuỗi thô.

export const BOOKING_STATUS: Record<string, string> = {
  pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', cancelled: 'Đã hủy', completed: 'Hoàn thành', no_show: 'Vắng mặt',
}
export const OPS_STATUS: Record<string, string> = {
  new: 'Mới', needs_mapping: 'Chưa ghép mã', needs_departure: 'Chưa xếp chuyến', needs_info: 'Thiếu thông tin',
  ready: 'Chờ phân công', assigned: 'Đã phân công', done: 'Đã chạy xong', cancelled: 'Đã hủy',
}
export const PAYMENT_STATUS: Record<string, string> = {
  unknown: 'Chưa có dữ liệu', unpaid: 'Chưa thanh toán', partially_paid: 'Thanh toán một phần', paid: 'Đã thanh toán',
  partially_refunded: 'Hoàn một phần', refunded: 'Đã hoàn tiền',
}
export const RECONCILIATION_STATUS: Record<string, string> = {
  unreconciled: 'Chưa đối soát', matched: 'Đã khớp', mismatch: 'Có lệch', adjusted: 'Đã điều chỉnh',
}
export const SYNC_STATUS: Record<string, string> = {
  manual: 'Nhập nội bộ', simulated: 'Mô phỏng', synced: 'Đã đồng bộ', stale: 'Có thể đã cũ', error: 'Lỗi đồng bộ',
}
export const CHANNEL: Record<string, string> = {
  viator: 'Viator', getyourguide: 'GetYourGuide', manual: 'Nội bộ', other: 'Khác',
}
export const CONNECTION_MODE: Record<string, string> = { mock: 'Mô phỏng', sandbox: 'Sandbox', production: 'Production' }
export const CONNECTION_STATUS: Record<string, string> = {
  not_configured: 'Chưa cấu hình', simulated: 'Đang mô phỏng', pending_approval: 'Chờ phê duyệt',
  connected: 'Đã kết nối', error: 'Lỗi', disabled: 'Đã tắt',
}
export const APPROVAL_STATUS: Record<string, string> = {
  not_requested: 'Chưa đăng ký', pending: 'Đang chờ', approved: 'Đã duyệt', rejected: 'Bị từ chối', not_required: 'Không cần',
}
export const EVENT_STATUS: Record<string, string> = {
  received: 'Đã nhận', processed: 'Đã xử lý', ignored_stale: 'Bỏ qua (dữ liệu cũ)', failed: 'Lỗi, chờ thử lại', dead: 'Cần xử lý tay',
}
export const ATTENDANCE: Record<string, string> = { pending: 'Chưa đón', picked_up: 'Đã đón', no_show: 'Vắng mặt' }
export const CHANNEL_REQUEST: Record<string, string> = {
  not_applicable: 'Không áp dụng', manual_required: 'Cần xử lý tay trên kênh', requested: 'Đã gửi yêu cầu',
  confirmed: 'Kênh đã xác nhận', rejected: 'Kênh từ chối',
}
export const MATCH_STATUS: Record<string, string> = {
  matched: 'Khớp', mismatch: 'Lệch', unmatched: 'Chưa tìm thấy booking', duplicate: 'Trùng', invalid: 'Không hợp lệ',
}
export const CAPABILITIES: Record<string, string> = {
  receive_booking: 'Nhận booking', receive_cancellation: 'Nhận hủy', receive_amendment: 'Nhận thay đổi',
  provide_availability: 'Cung cấp tình trạng chỗ', hold: 'Giữ chỗ', confirm_booking: 'Xác nhận đặt',
  update_price: 'Cập nhật giá', recovery_query: 'Truy vấn phục hồi', amend_from_system: 'Sửa/hủy từ hệ thống',
  catalog_pull: 'Lấy danh mục sản phẩm', availability_pull: 'Lấy lịch và số chỗ',
}

const PAX_LABEL: Record<string, string> = { adult: 'Người lớn', child: 'Trẻ em', infant: 'Em bé', youth: 'Thanh thiếu niên', senior: 'Người cao tuổi' }

/** {adult: 2, child: 1} thành "Người lớn 2, Trẻ em 1". Mã lạ giữ nguyên để không giấu dữ liệu. */
export function formatPax(pax: Record<string, unknown> | null | undefined): string {
  return Object.entries(pax ?? {}).map(([k, v]) => `${PAX_LABEL[k] ?? k} ${v}`).join(', ')
}

const RESULT_CODES: Record<string, string> = {
  no_seats: 'Không đủ chỗ trên chuyến này.',
  not_on_sale: 'Chuyến đang đóng bán hoặc đã quá hạn nhận khách.',
  duplicate_departure: 'Chuyến này đã tồn tại.',
  departure_not_found: 'Không tìm thấy chuyến.',
  below_committed: 'Không thể giảm sức chứa xuống dưới lượng đã cam kết.',
  booking_cancelled: 'Booking đã hủy, không thể thực hiện.',
  invalid_pax: 'Số khách phải lớn hơn 0.',
  invalid_capacity: 'Sức chứa không hợp lệ.',
  invalid_range: 'Khoảng ngày không hợp lệ (tối đa 366 ngày).',
  invalid_input: 'Dữ liệu chưa hợp lệ.',
  missing_lead: 'Cần nhập tên khách đại diện.',
  vehicle_full: 'Vượt quá sức chứa của xe.',
  vehicle_not_found: 'Không tìm thấy xe.',
  different_departure: 'Khách không thuộc chuyến của xe này.',
  no_committed_seats: 'Khách này chưa chiếm chỗ trên chuyến.',
  has_allocations: 'Xe còn khách đã được chia, hãy gỡ khách trước.',
  not_on_departure: 'Khách không thuộc chuyến này.',
  hold_expired: 'Giữ chỗ đã hết hạn.',
  hold_not_found: 'Không tìm thấy mã giữ chỗ.',
  already_booked: 'Giữ chỗ này đã thành booking.',
  production_needs_approval: 'Chỉ chuyển Production sau khi kênh đã phê duyệt.',
  verified_needs_target: 'Phải chọn gói nội bộ trước khi xác nhận ánh xạ.',
  duplicate_connection: 'Tài khoản này đã tồn tại.',
  not_retryable: 'Sự kiện này không ở trạng thái lỗi.',
  user_not_found: 'Chưa có tài khoản với email này. Hãy tạo tài khoản trước.',
  cannot_deactivate_self: 'Không thể tự khóa tài khoản của mình.',
  last_owner: 'Doanh nghiệp phải còn ít nhất một chủ.',
  currency_mismatch: 'Khác tiền tệ, không gán được.',
  booking_not_found: 'Không tìm thấy booking.',
  note_required: 'Cần ghi lý do.',
  too_many_rows: 'File vượt quá 5.000 dòng.',
  connection_not_found: 'Không tìm thấy tài khoản kênh.',
  job_not_found: 'Không tìm thấy lượt nhập.',
  batch_not_found: 'Không tìm thấy bảng thanh toán.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  duplicate_code: 'Mã này đã tồn tại, hãy chọn mã khác.',
  already_linked: 'Sản phẩm này đã được ghép với một gói.',
  option_not_found: 'Không tìm thấy gói dịch vụ.',
  tour_not_found: 'Không tìm thấy tour.',
  product_not_linked: 'Sản phẩm chưa được ghép với gói nội bộ.',
  product_removed: 'Sản phẩm đã gỡ khỏi kênh, không tạo chuyến từ lịch cũ.',
  not_mock: 'Thao tác này chỉ dùng cho kết nối mô phỏng.',
  stale_ignored: 'Sự kiện cũ hơn dữ liệu hiện có nên được bỏ qua.',
}

export function resultMessage(code: string | null | undefined): string {
  if (code && RESULT_CODES[code]) return RESULT_CODES[code]!
  return 'Không thực hiện được. Vui lòng thử lại hoặc liên hệ quản trị viên.'
}
