import { describe, expect, it } from 'vitest'
import { buildPickupRoute, geocodeQueries, haversineKm, optimizeOrder, placeNameMatches, routeKm, streetQuery, type LatLng } from './index'

const p = (lat: number, lng: number): LatLng => ({ lat, lng })

describe('tối ưu thứ tự đón', () => {
  it('tính khoảng cách đường chim bay', () => {
    // 0,01 độ vĩ khoảng 1,11 km.
    expect(haversineKm(p(21, 105.85), p(21.01, 105.85))).toBeCloseTo(1.11, 1)
    expect(routeKm([p(21, 105.85)])).toBe(0)
  })

  it('tìm thứ tự ngắn nhất cho các điểm trên một đường thẳng', () => {
    const points = [p(21.03, 105.85), p(21.0, 105.85), p(21.02, 105.85), p(21.01, 105.85)]
    const order = optimizeOrder(points)
    expect([...order].sort()).toEqual([0, 1, 2, 3])
    expect(routeKm(order.map((i) => points[i]!))).toBeCloseTo(routeKm([points[1]!, points[3]!, points[2]!, points[0]!]), 6)
    expect(routeKm(order.map((i) => points[i]!))).toBeLessThan(routeKm(points))
  })

  it('bắt đầu từ điểm xa trung tâm nhóm và đi dần vào khu đông', () => {
    // Ba điểm gần nhau và một điểm xa: điểm xa phải được đón trước.
    const points = [p(21.03, 105.85), p(21.031, 105.85), p(21.032, 105.85), p(21.08, 105.85)]
    expect(optimizeOrder(points)[0]).toBe(3)
  })

  it('giữ nguyên khi có 0 hoặc 1 điểm', () => {
    expect(optimizeOrder([])).toEqual([])
    expect(optimizeOrder([p(21, 105)])).toEqual([0])
  })

  it('xử lý được nhiều hơn 8 điểm và không kém thứ tự ban đầu', () => {
    const points = Array.from({ length: 12 }, (_, i) => p(21 + ((i * 7) % 12) / 100, 105.8 + ((i * 5) % 12) / 100))
    const order = optimizeOrder(points)
    expect(new Set(order).size).toBe(12)
    expect(routeKm(order.map((i) => points[i]!))).toBeLessThanOrEqual(routeKm(points))
  })

  it('bỏ phần lặp trong địa chỉ kênh trước khi tìm tọa độ', () => {
    expect(geocodeQueries('Khách sạn A, Khách sạn A, Phố B, Hoan Kiem, Ha Noi, Vietnam'))
      .toEqual(['Khách sạn A, Phố B, Hoan Kiem, Ha Noi, Vietnam', 'Khách sạn A, Hanoi'])
    expect(geocodeQueries('Khách sạn A')).toEqual(['Khách sạn A', 'Khách sạn A, Hanoi'])
  })
})

describe('kiểm tra kết quả tìm vị trí', () => {
  it('nhận tên đúng dù khác cách viết hoặc sai chính tả', () => {
    expect(placeNameMatches('JW Marriott Hoter Hanoi', 'Khách sạn JW Marriott Hà Nội')).toBe(true)
    expect(placeNameMatches('InterContinental Hà Nội Westlake', 'InterContinental Hanoi Westlake')).toBe(true)
    expect(placeNameMatches('Melia Hanoi', 'Meliá Hà Nội')).toBe(true)
  })

  it('từ chối khách sạn khác dù trùng các từ chung chung', () => {
    expect(placeNameMatches('Hanoi Liliane Hotel and Travel', 'Beryl Signature Hotel and Travel')).toBe(false)
    expect(placeNameMatches('Liliane Hotel Hanoi', 'Minasi HanoiOi Lakeside Hotel')).toBe(false)
    expect(placeNameMatches('Hanoi Hotel', 'Hanoi Hotel')).toBe(false)
    expect(placeNameMatches('Melia Hanoi', null)).toBe(false)
  })

  it('lấy tên phố làm vị trí gần đúng', () => {
    expect(streetQuery('Hanoi Liliane Hotel and Travel, Hanoi Liliane Hotel and Travel, Phố Thuốc Bắc, Old Quarter, Hoan Kiem, Ha Noi, Vietnam')).toBe('Phố Thuốc Bắc, Ha Noi')
    expect(streetQuery('JW Marriott Hoter Hanoi')).toBeNull()
  })
})

describe('sơ đồ đón có tọa độ', () => {
  it('điểm đón mang theo tọa độ và danh sách dòng booking', () => {
    const { lanes } = buildPickupRoute([
      { booking_id: 'b1', item_id: 'i1', code: 'A', pax_total: 2, hotel_name: 'Hotel Một', latitude: '21.03', longitude: '105.85' },
      { booking_id: 'b2', item_id: 'i2', code: 'B', pax_total: 1, hotel_name: 'Hotel Một' },
      { booking_id: 'b3', item_id: 'i3', code: 'C', pax_total: 1, hotel_name: 'Hotel Hai' },
    ])
    expect(lanes[0]!.stops[0]).toMatchObject({ items: ['i1', 'i2'], position: { lat: 21.03, lng: 105.85 } })
    expect(lanes[0]!.stops[1]).toMatchObject({ items: ['i3'], position: undefined })
  })
})
