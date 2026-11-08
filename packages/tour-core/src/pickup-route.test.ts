import { describe, expect, it } from 'vitest'
import { buildPickupRoute, placeArea, shortPlaceName, type PickupRow } from './index'

// Toàn bộ là dữ liệu giả.
const row = (code: string, over: Partial<PickupRow> = {}): PickupRow => ({ booking_id: code, code, pax_total: 2, ...over })

describe('sơ đồ tuyến đón', () => {
  it('rút gọn tên và đọc khu vực từ địa chỉ kênh gửi', () => {
    const raw = 'Khách sạn Giả, Khách sạn Giả, Phố Thuốc Bắc, Old Quarter, Hoan Kiem, Ha Noi, Vietnam'
    expect(shortPlaceName(raw)).toBe('Khách sạn Giả')
    expect(placeArea(raw)).toBe('Old Quarter')
    expect(placeArea('Khách sạn Giả')).toBeUndefined()
  })

  it('gộp các booking cùng khách sạn thành một điểm, giữ thứ tự', () => {
    const { lanes } = buildPickupRoute([
      row('A', { hotel_name: 'Hotel Một, Old Quarter', pax_total: 3 }),
      row('B', { hotel_name: 'Hotel Hai' }),
      row('C', { hotel_name: 'HOTEL MỘT', pax_total: 5 }),
    ])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ name: 'Chưa chia xe', pax: 10 })
    expect(lanes[0]!.stops.map((s) => [s.name, s.pax, s.bookings])).toEqual([['Hotel Một', 8, ['A', 'C']], ['Hotel Hai', 2, ['B']]])
  })

  it('mỗi xe một tuyến, xe chưa có khách vẫn hiện, tuyến chưa chia xe nằm cuối', () => {
    const { lanes } = buildPickupRoute([
      row('A', { hotel_name: 'Hotel Một' }),
      row('B', { hotel_name: 'Hotel Hai', vehicle_assignment_id: 'x1', vehicle_name: 'Jeep 1' }),
    ], [{ id: 'x1', name: 'Jeep 1', seats: 6 }, { id: 'x2', name: 'Jeep 2', seats: 6 }])
    expect(lanes.map((l) => [l.name, l.pax, l.stops.length])).toEqual([['Jeep 1', 2, 1], ['Jeep 2', 0, 0], ['Chưa chia xe', 2, 1]])
  })

  it('booking chưa có địa điểm thật được tách riêng', () => {
    const { lanes, missing } = buildPickupRoute([
      row('A'),
      row('B', { hotel_name: 'I will contact the supplier later' }),
      row('C', { hotel_name: 'My hotel is not yet booked: ' }),
      row('D', { hotel_name: 'I will select my pickup location later' }),
      row('E', { address: 'Địa chỉ giả' }),
    ])
    expect(missing.map((m) => [m.code, m.note])).toEqual([
      ['A', undefined], ['B', 'Khách chưa chốt điểm đón'], ['C', 'Khách chưa chốt điểm đón'], ['D', 'Khách chưa chốt điểm đón'],
    ])
    expect(lanes[0]!.stops.map((s) => s.name)).toEqual(['Địa chỉ giả'])
  })

  it('báo giờ đón sai thứ tự, trễ hơn giờ khởi hành hoặc khác nhau trong một điểm', () => {
    const { lanes } = buildPickupRoute([
      row('A', { hotel_name: 'Một', pickup_local_time: '08:00:00' }),
      row('B', { hotel_name: 'Hai', pickup_local_time: '07:30:00' }),
      row('C', { hotel_name: 'Ba', pickup_local_time: '09:00:00' }),
      row('D', { hotel_name: 'Bốn', pickup_local_time: '08:40:00' }),
      row('E', { hotel_name: 'Bốn', pickup_local_time: '08:30:00' }),
    ], [], '08:45:00')
    const s = lanes[0]!.stops
    expect(s.map((x) => x.outOfOrder)).toEqual([false, true, false, true])
    expect(s.map((x) => x.afterDeparture)).toEqual([false, false, true, false])
    expect(s[3]).toMatchObject({ time: '08:30', mixedTimes: true })
  })
})
