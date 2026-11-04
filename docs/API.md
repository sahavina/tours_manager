# API nội bộ

Giao diện gọi PostgREST: `POST /rest/v1/rpc/<tên>` với JSON tham số, hoặc đọc bảng/view qua `GET /rest/v1/<bảng>`. Xác thực bằng JWT của Supabase Auth.

## Quy ước

- **Kết quả nghiệp vụ** trả HTTP 200 với `{ "ok": false, "code": "no_seats" }`. Giao diện dịch mã qua `resultMessage` (`packages/tour-core/src/labels.ts`).
- **Sai quyền** trả lỗi Postgres `42501`, `message = "forbidden"`.
- **Danh sách** phân trang bằng `range` và `Prefer: count=exact`, sắp xếp bằng `order`, lọc theo cú pháp PostgREST.
- Bảng booking, chuyến, chỗ không ghi trực tiếp được, chỉ qua RPC.

## Đọc

| Nguồn | Quyền | Ghi chú |
|---|---|---|
| `v_booking_list` | `booking.read` | Danh sách booking, có `search_text` |
| `v_departure_availability` | `departure.read` | Chuyến kèm số chỗ, không bị RLS làm thiếu |
| `bookings`, `booking_items`, `booking_changes`... | `booking.read` | Chỉ đọc |
| `booking_financials`, `expenses`, `settlement_*` | `finance.read` | |
| `booking_source_snapshots` | `booking.source_read` | Payload đã che |
| `integration_events`, `sync_jobs`, `channel_product_mappings` | `connection.read` | |
| `audit_logs` | `audit.read` | Chỉ ghi thêm |

## Ghi trực tiếp qua RLS

| Bảng | Quyền |
|---|---|
| `tours`, `tour_options`, `traveler_categories` | `catalog.manage` |
| `customers` | `customer.manage` |
| `guides`, `vehicles`, `suppliers` | `resource.manage` |
| `expenses` | `finance.manage` |
| `saved_filters` | Của chính mình |

Xóa mềm bằng `deleted_at`. RLS chặn UPDATE là khớp 0 dòng, không báo lỗi: phải `select` lại và đếm.

## RPC

### Booking

| Hàm | Quyền | Mã lỗi |
|---|---|---|
| `create_manual_booking(p_org, p_data)` | `booking.manage` | `missing_lead`, `departure_not_found`, `invalid_pax`, `no_seats` |
| `update_booking_internal(p_booking, p_patch)` | `booking.manage` | |
| `add_booking_note(p_booking, p_body)` | `booking.manage` | |
| `update_item_pax(p_item, p_pax)` | `booking.manage` | `booking_cancelled`, `invalid_pax`, `no_seats` |
| `cancel_booking_internal(p_booking, p_reason)` | `booking.manage` | Trả `channel_action_required` |
| `set_channel_request_status(p_change, p_status)` | `booking.manage` | |
| `move_booking_item(p_item, p_departure)` | `ops.manage` | `no_seats`, `booking_cancelled`, `departure_not_found` |
| `export_bookings(p_org, p_filters)` | `booking.export` | Có ghi nhật ký, tối đa 10.000 dòng |
| `quick_search(p_org, p_query)` | Theo từng loại | |

**Sửa nội bộ, yêu cầu trên kênh, kết quả từ kênh là ba việc khác nhau.** `move_booking_item` trên booking từ kênh trả `channel_request_status: manual_required`, không báo đã cập nhật sang kênh.

### Chuyến và sức chứa

| Hàm | Quyền | Mã lỗi |
|---|---|---|
| `create_departure(p_org, p_tour, p_option, p_date, p_time, p_timezone, p_capacity, p_pool)` | `departure.manage` | `duplicate_departure`, `invalid_capacity` |
| `generate_departures(..., p_weekdays, p_times, ..., p_dry_run)` | `departure.manage` | `invalid_range`. `p_weekdays` theo ISO, 1 là thứ Hai |
| `set_departure_sale(p_departure, p_open)` | `departure.manage` | |
| `update_pool_capacity(p_pool, p_capacity, p_blocked)` | `departure.manage` | `below_committed` |
| `complete_departure(p_departure, p_outcome)` | `ops.manage` | |

### Điều hành

| Hàm | Quyền | Mã lỗi |
|---|---|---|
| `ops_board(p_org, p_from, p_to)` | `ops.read` | |
| `departure_manifest(p_departure)` | `ops.read` hoặc `departure.read` | |
| `assign_guide`, `unassign_guide` | `ops.manage` | |
| `assign_vehicle`, `unassign_vehicle` | `ops.manage` | `vehicle_not_found`, `has_allocations` |
| `allocate_passengers(p_assignment, p_item)` | `ops.manage` | `vehicle_full`, `different_departure`, `no_committed_seats` |
| `deallocate_passengers(p_item)` | `ops.manage` | |
| `set_pickup(p_item, p_patch)`, `reorder_pickups(p_departure, p_items)` | `ops.manage` | |
| `set_assignment_ack(p_kind, p_id, p_field, p_value)`, `set_supplier_confirmed` | `ops.manage` | |
| `set_attendance`, `report_incident` | `ops.manage` hoặc HDV được giao | `not_on_departure` |
| `guide_my_departures(p_from, p_to)`, `guide_manifest(p_departure)` | HDV | Không có chuyến thì trả mảng rỗng |

### Kênh

Từ người dùng chỉ gọi được trên kết nối `mock`, cần `connection.simulate`. Kết nối thật chỉ nhận `service_role`.

| Hàm | Mã kết quả |
|---|---|
| `ingest_channel_event(p_connection, p_event)` | `duplicate`, `stale_ignored`, `queued`, `unknown_event_type`, `missing_external_ref` |
| `channel_reserve(p_connection, p_departure, p_quantity, p_reference, p_ttl_seconds)` | `held`, `existing`, `no_seats`, `not_on_sale`, `hold_expired` |
| `channel_cancel_reservation(p_connection, p_reference)` | `released`, `already_booked`, `hold_not_found` |
| `channel_book(p_connection, p_reference, p_data)` | `existing`, `hold_expired`, `hold_not_found`, `no_seats`, `invalid_payload` |

`p_event`:

```json
{
  "event_id": "tùy chọn, thiếu thì dùng hash nội dung",
  "type": "booking.created | booking.updated | booking.cancelled",
  "external_ref": "BR-123",
  "version": 2,
  "source_at": "2030-01-01T00:00:00Z",
  "data": { "external_ref": "BR-123", "status": "confirmed", "currency": "USD", "gross_amount": "100.00",
    "lead": { "name": "...", "email": "...", "phone": "..." },
    "financials": { "channel_fee": "25.00", "expected_payout": "75.00" },
    "items": [{ "product_code": "P1", "option_code": "", "local_date": "2030-01-15", "local_time": "08:00:00",
      "pax": { "adult": 2 }, "pickup": { "hotel": "...", "address": "..." } }] }
}
```

### Kết nối và ánh xạ

| Hàm | Quyền | Mã lỗi |
|---|---|---|
| `connection_create`, `connection_update` | `connection.manage` | `duplicate_connection`, `production_needs_approval` |
| `mapping_save(...)` | `connection.manage` | `verified_needs_target`. Trả `placed` |
| `retry_event(p_event)` | `connection.manage` | `not_retryable` |
| `connection_mark_health` | Chỉ `service_role` | |

### Nhập file, đối soát, báo cáo

| Hàm | Quyền | Ghi chú |
|---|---|---|
| `import_preview(...)`, `import_commit(p_job)` | `import.manage` | Commit lặp trả `already_committed` |
| `settlement_preview(...)` | `finance.manage` | Cùng file trả `already_imported` |
| `settlement_confirm(p_batch)` | `finance.manage` | Xác nhận lặp không cộng dồn |
| `settlement_match_line`, `settlement_adjust` | `finance.manage` | Bắt buộc ghi lý do |
| `update_booking_financials(p_booking, p_patch)` | `finance.manage` | Chuỗi rỗng là chưa có dữ liệu |
| `dashboard_summary(p_org, p_from, p_to, p_connection)` | `booking.read` | Tiền theo từng tiền tệ, số tài chính cần `finance.read` |
| `report_profit(p_org, p_from, p_to)` | `finance.read` | `profit` là null khi thiếu dữ liệu |

### Thành viên, khách hàng, thông báo

`member_list`, `member_upsert` (`member.manage`, mã `user_not_found`, `last_owner`, `cannot_deactivate_self`); `customer_duplicate_suggestions` (`customer.read`); `merge_customers` (`customer.manage`); `notifications_mark_read`; `my_org_context`.

## Worker

`GET http://localhost:3102/health` trả 200 khi vòng lặp còn chạy và database trả lời, ngược lại 503.
