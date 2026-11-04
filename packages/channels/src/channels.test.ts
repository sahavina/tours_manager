import { describe, expect, it } from 'vitest'
import { DESCRIPTORS, GETYOURGUIDE_MOCK, VIATOR_MOCK, mockAvailability, mockCatalog, simulate } from './index'

const ctx = {
  channel: 'viator' as const,
  productCode: 'P1',
  localDate: '2030-01-01',
  localTime: '08:00:00',
  uid: () => 'abc',
  now: () => new Date('2029-12-01T00:00:00Z'),
}

describe('connector mô phỏng', () => {
  it('được đánh dấu là mô phỏng', () => {
    for (const d of Object.values(DESCRIPTORS)) expect(d.isSimulated).toBe(true)
  })

  it('thời hạn giữ chỗ khác nhau theo từng kênh', () => {
    expect(VIATOR_MOCK.defaultHoldTtlSeconds).not.toBe(GETYOURGUIDE_MOCK.defaultHoldTtlSeconds)
  })

  it('mọi mã sinh ra đều mang tiền tố SIM và email không gửi được', () => {
    const ev = simulate.newBooking(ctx)
    expect(ev.external_ref).toMatch(/SIM/)
    expect(ev.data.lead?.email).toMatch(/@example\.invalid$/)
  })

  it('sự kiện tái tạo được khi tiêm uid và đồng hồ', () => {
    expect(simulate.newBooking(ctx)).toEqual(simulate.newBooking(ctx))
  })

  it('danh mục giả tái tạo được, phiên bản chẵn có thay đổi, thêm và gỡ', () => {
    expect(mockCatalog('viator', 1)).toEqual(mockCatalog('viator', 3))
    const codes = (v: number) => mockCatalog('viator', v).map((p) => p.product_code)
    expect(codes(2)).toContain('SIMV-1005')
    expect(codes(2)).not.toContain('SIMV-1004')
    expect(mockCatalog('viator', 2)[0]!.title).not.toBe(mockCatalog('viator', 1)[0]!.title)
  })

  it('có sản phẩm chỉ gồm mã, tên, trạng thái như tài liệu Viator, và nó không sinh lịch', () => {
    const minimal = mockCatalog('viator', 1).find((p) => !p.start_times)!
    expect(Object.keys(minimal).sort()).toEqual(['product_code', 'status', 'title'])
    expect(mockAvailability([minimal], new Date('2030-01-01T00:00:00Z'))).toEqual([])
  })

  it('lịch giả đúng số ngày, hết chỗ khi không còn chỗ trống', () => {
    const items = mockAvailability(mockCatalog('viator', 1).slice(0, 1), new Date('2030-01-01T00:00:00Z'), 14)
    expect(items).toHaveLength(14)
    expect(items[0]!.local_date).toBe('2030-01-01')
    for (const i of items) expect(i.status === 'sold_out').toBe(i.vacancies === 0)
  })

  it('lịch giả bắt đầu theo ngày địa phương, không theo ngày UTC', () => {
    // 00:30 ngày 05/11 ở Việt Nam vẫn là 17:30 ngày 04/11 theo UTC.
    const lateNight = new Date('2026-11-04T17:30:00Z')
    const items = mockAvailability(mockCatalog('viator', 1).slice(0, 1), lateNight, 2)
    expect(items.map((i) => i.local_date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('múi giờ của sản phẩm được ưu tiên hơn múi giờ mặc định, kể cả qua tháng', () => {
    const product = { product_code: 'SIM-TZ', start_times: ['09:00'], timezone: 'America/New_York' }
    const items = mockAvailability([product], new Date('2026-12-01T02:00:00Z'), 2)
    expect(items.map((i) => i.local_date)).toEqual(['2026-11-30', '2026-12-01'])
  })

  it('không khai khả năng chưa có: sửa từ hệ thống và truy vấn phục hồi', () => {
    expect(VIATOR_MOCK.capabilities.amend_from_system).toBe('unsupported')
    expect(GETYOURGUIDE_MOCK.capabilities.recovery_query).toBe('unsupported')
  })
})
