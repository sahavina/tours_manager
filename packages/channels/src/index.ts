// Giao diện connector và hai connector MÔ PHỎNG. Chưa có connector thật: quyền API của Viator và
// GetYourGuide phụ thuộc hợp đồng và phê duyệt (docs/CHANNEL_INTEGRATION.md).
//
// Đối chiếu tài liệu nhà cung cấp (đọc 2026-11-04): cả hai nền tảng đều GỌI VÀO hệ thống của nhà tổ
// chức tour để kiểm tra chỗ, giữ chỗ và đặt. Tài liệu không nêu API lấy booking theo mã hay lấy lịch
// sử, nên giao diện này không có `listBookings`: thêm nó là tự bịa một khả năng không tồn tại.

export type Capability =
  | 'receive_booking'
  | 'receive_cancellation'
  | 'receive_amendment'
  | 'provide_availability'
  | 'hold'
  | 'confirm_booking'
  | 'update_price'
  | 'recovery_query'
  | 'amend_from_system'

export type CapabilityState = 'supported' | 'unsupported' | 'unverified'
export type CapabilityMap = Record<Capability, CapabilityState>

/** Dữ liệu booking đã chuẩn hóa: đúng định dạng `_apply_booking_data` nhận. */
export type NormalizedBooking = {
  external_ref: string
  status?: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  channel_status?: string
  booked_at?: string
  customer_ref?: string
  lead?: { name?: string; email?: string; phone?: string }
  special_requests?: string
  gross_amount?: string
  currency?: string
  financials?: { discount?: string; channel_fee?: string; expected_payout?: string }
  policy?: Record<string, unknown>
  items: Array<{
    ref?: string
    product_code?: string
    option_code?: string
    local_date: string
    local_time?: string
    timezone?: string
    language?: string
    pax: Record<string, number>
    amount?: string
    pickup?: { hotel?: string; address?: string; lat?: number; lng?: number }
    participants?: Array<{ name?: string; category?: string; is_lead?: boolean }>
  }>
}

export type ChannelEvent = {
  event_id?: string
  type: 'booking.created' | 'booking.updated' | 'booking.cancelled'
  external_ref: string
  source_at?: string
  version?: number
  correlation_id?: string
  data: Partial<NormalizedBooking> & Record<string, unknown>
}

export type ChannelDescriptor = {
  channel: 'viator' | 'getyourguide'
  name: string
  isSimulated: boolean
  /** Thời hạn giữ chỗ mặc định (giây), theo từng kênh; không dùng một giá trị chung. */
  defaultHoldTtlSeconds: number
  capabilities: CapabilityMap
  categoryMap: Record<string, string>
}

/**
 * Mỗi connector dịch từ định dạng của kênh sang dữ liệu chuẩn hóa. Việc nhận và xử lý nằm ở các RPC
 * `ingest_channel_event`, `channel_reserve`, `channel_cancel_reservation`, `channel_book`.
 */
export interface ChannelConnector {
  readonly descriptor: ChannelDescriptor
  /** Chuyển yêu cầu book của kênh thành booking chuẩn hóa. */
  normalizeBooking(raw: unknown): NormalizedBooking
}

const SIMULATED_CAPABILITIES: CapabilityMap = {
  receive_booking: 'supported',
  receive_cancellation: 'supported',
  receive_amendment: 'supported',
  provide_availability: 'supported',
  hold: 'supported',
  confirm_booking: 'supported',
  update_price: 'unsupported',
  recovery_query: 'unsupported',
  amend_from_system: 'unsupported',
}

export const VIATOR_MOCK: ChannelDescriptor = {
  channel: 'viator',
  name: 'Viator (mô phỏng)',
  isSimulated: true,
  // Tài liệu nêu chỗ được giữ tối thiểu 15 phút; nhà cung cấp trả thời hạn trong phản hồi.
  defaultHoldTtlSeconds: 15 * 60,
  capabilities: SIMULATED_CAPABILITIES,
  categoryMap: { ADULT: 'adult', CHILD: 'child', INFANT: 'infant', YOUTH: 'youth', SENIOR: 'senior' },
}

export const GETYOURGUIDE_MOCK: ChannelDescriptor = {
  channel: 'getyourguide',
  name: 'GetYourGuide (mô phỏng)',
  isSimulated: true,
  // Tài liệu nêu mong muốn giữ 60 phút, tối thiểu 15 phút.
  defaultHoldTtlSeconds: 60 * 60,
  capabilities: { ...SIMULATED_CAPABILITIES },
  categoryMap: { ADULT: 'adult', CHILD: 'child', INFANT: 'infant', YOUTH: 'youth', SENIOR: 'senior' },
}

export const DESCRIPTORS = { viator: VIATOR_MOCK, getyourguide: GETYOURGUIDE_MOCK } as const

export type SimulationContext = {
  channel: 'viator' | 'getyourguide'
  productCode: string
  optionCode?: string
  localDate: string
  localTime: string
  timezone?: string
  /** Sinh mã duy nhất. Tiêm vào để test và seed tái tạo được. */
  uid: () => string
  now?: () => Date
}

const FIRST = ['Emma', 'Liam', 'Sophie', 'Noah', 'Mia', 'Lucas', 'Yuki', 'Hana', 'Marco', 'Chloe']
const LAST = ['Smith', 'Müller', 'Tanaka', 'Rossi', 'Dubois', 'Nguyen', 'Kim', 'Garcia', 'Brown', 'Lee']

function simulatedBooking(ctx: SimulationContext, ref: string, pax: Record<string, number>): NormalizedBooking {
  const seed = [...ref].reduce((s, c) => s + c.charCodeAt(0), 0)
  const name = `${FIRST[seed % FIRST.length]} ${LAST[(seed >> 2) % LAST.length]}`
  const total = Object.values(pax).reduce((a, b) => a + b, 0)
  const gross = 40 * total
  return {
    external_ref: ref,
    status: 'confirmed',
    channel_status: 'CONFIRMED',
    booked_at: (ctx.now?.() ?? new Date()).toISOString(),
    lead: { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.invalid`, phone: '+10000000000' },
    gross_amount: gross.toFixed(2),
    currency: 'USD',
    financials: { channel_fee: (gross * 0.25).toFixed(2), expected_payout: (gross * 0.75).toFixed(2) },
    policy: { cancellation: 'Miễn phí trước 24 giờ (dữ liệu mô phỏng)' },
    items: [
      {
        product_code: ctx.productCode,
        option_code: ctx.optionCode ?? '',
        local_date: ctx.localDate,
        local_time: ctx.localTime,
        timezone: ctx.timezone,
        pax,
      },
    ],
  }
}

const prefix = (c: SimulationContext) => (c.channel === 'viator' ? 'BR-SIM' : 'GYG-SIM')

/** Bộ sinh sự kiện mô phỏng. Mọi mã đều có tiền tố SIM để không ai nhầm với booking thật. */
export const simulate = {
  newBooking(ctx: SimulationContext, pax: Record<string, number> = { adult: 2 }): ChannelEvent {
    const ref = `${prefix(ctx)}-${ctx.uid()}`
    return {
      event_id: `${ref}:created`,
      type: 'booking.created',
      external_ref: ref,
      version: 1,
      source_at: (ctx.now?.() ?? new Date()).toISOString(),
      data: simulatedBooking(ctx, ref, pax),
    }
  },

  cancel(ctx: SimulationContext, ref: string, version: number): ChannelEvent {
    return {
      event_id: `${ref}:cancelled:${version}`,
      type: 'booking.cancelled',
      external_ref: ref,
      version,
      source_at: (ctx.now?.() ?? new Date()).toISOString(),
      data: { external_ref: ref, status: 'cancelled', channel_status: 'CANCELLED' },
    }
  },

  amend(ctx: SimulationContext, ref: string, version: number, pax: Record<string, number>): ChannelEvent {
    return {
      event_id: `${ref}:amended:${version}`,
      type: 'booking.updated',
      external_ref: ref,
      version,
      source_at: (ctx.now?.() ?? new Date()).toISOString(),
      data: simulatedBooking(ctx, ref, pax),
    }
  },
}

export const SIMULATION_SCENARIOS = [
  { key: 'new_viator', title: 'Booking mới từ Viator', channel: 'viator' },
  { key: 'new_gyg', title: 'Booking mới từ GetYourGuide', channel: 'getyourguide' },
  { key: 'cancel', title: 'Hủy booking' },
  { key: 'amend', title: 'Thay đổi số khách / ngày đi' },
  { key: 'replay', title: 'Gửi lại cùng sự kiện' },
  { key: 'hold_expire', title: 'Giữ chỗ rồi hết hạn' },
  { key: 'timeout_retry', title: 'Timeout sau khi giao dịch đã thành công' },
  { key: 'race', title: 'Hai yêu cầu cạnh tranh chỗ cuối' },
] as const

export type ScenarioKey = (typeof SIMULATION_SCENARIOS)[number]['key']
