import { describe, expect, it } from 'vitest'
import { DESCRIPTORS, GETYOURGUIDE_MOCK, VIATOR_MOCK, simulate } from './index'

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

  it('không khai khả năng chưa có: sửa từ hệ thống và truy vấn phục hồi', () => {
    expect(VIATOR_MOCK.capabilities.amend_from_system).toBe('unsupported')
    expect(GETYOURGUIDE_MOCK.capabilities.recovery_query).toBe('unsupported')
  })
})
