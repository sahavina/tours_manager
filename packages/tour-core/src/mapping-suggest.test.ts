import { describe, expect, it } from 'vitest'
import { channelTitles, durationFromText, privacyFromText, suggestMapping, type MappingCandidate } from './index'

// Toàn bộ là dữ liệu giả, dựng theo kiểu tên trên báo cáo thật.
const jeep = (id: string, name: string, minutes: number | null, priv: boolean): MappingCandidate =>
  ({ id, code: id, name, tour_id: 'T-JEEP', tour_name: 'Hanoi Jeep Tour', duration_minutes: minutes, is_private: priv })
const options = [
  jeep('GHEP-4H', 'Jeep ghép 4 tiếng', 240, false),
  jeep('GHEP-2H', 'Jeep ghép 2 tiếng', 120, false),
  jeep('RIENG-4H', 'Jeep riêng 4 tiếng', 240, true),
  jeep('RIENG-2H', 'Jeep riêng 2 tiếng', 120, true),
  { id: 'FOOD', code: 'FOOD', name: 'Tiếng Anh', tour_id: 'T-FOOD', tour_name: 'Food tour phố cổ', duration_minutes: 180, is_private: false },
]

describe('gợi ý ghép mã', () => {
  it('đọc thời lượng và riêng hay ghép từ tên tiếng Anh và tiếng Việt', () => {
    expect(durationFromText('Group Jeep 4-Hour Tour')).toBe(240)
    expect(durationFromText('Tour 2.0 tiếng')).toBe(120)
    expect(durationFromText('Tour 3,5 giờ')).toBe(210)
    expect(durationFromText('City highlights')).toBeNull()
    expect(privacyFromText('Private Jeep Tour')).toBe('private')
    expect(privacyFromText('Tour riêng 2 tiếng')).toBe('private')
    expect(privacyFromText('Shared 2-Hour Jeep Tour')).toBe('shared')
    expect(privacyFromText('Tour jeep city ghép')).toBe('shared')
    expect(privacyFromText('Hanoi by night')).toBeNull()
  })

  it('đủ thời lượng và kiểu tour thì gợi ý tin cậy cao', () => {
    const s = suggestMapping({ product_code: 'P1', option_code: 'TG9', product_title: 'Hanoi Jeep Tour', option_title: 'Shared 2-Hour Jeep Tour' }, options)
    expect(s).toMatchObject({ option_id: 'GHEP-2H', confidence: 'high' })
    expect(s.reasons).toContain('Cùng thời lượng 2 tiếng')
  })

  it('không bao giờ gợi ý gói sai thời lượng hoặc sai riêng/ghép', () => {
    const s = suggestMapping({ product_code: 'P1', option_code: 'X', option_title: 'Private 4-Hour Jeep Tour' }, options)
    expect(s.option_id).toBe('RIENG-4H')
    const onlyWrong = suggestMapping({ product_code: 'P1', option_code: 'X', option_title: 'Private 3-Hour Jeep Tour' }, options)
    expect(onlyWrong).toMatchObject({ option_id: null, confidence: 'none' })
  })

  it('hai gói ngang điểm thì không chọn hộ', () => {
    const s = suggestMapping({ product_code: 'P1', option_code: 'Tour 2.0 tiếng', product_title: 'Hanoi Jeep Tour', option_title: 'Tour 2.0 tiếng' }, options)
    expect(s).toMatchObject({ option_id: null, confidence: 'none' })
    expect(s.alternatives.sort()).toEqual(['GHEP-2H', 'RIENG-2H'])
  })

  it('mã khác của cùng sản phẩm đã ghép là căn cứ chọn tour', () => {
    const s = suggestMapping({ product_code: 'P9', option_code: 'TG1', option_title: 'English food walk' }, options, ['T-FOOD'])
    expect(s.option_id).toBe('FOOD')
    expect(s.reasons).toContain('Mã khác của cùng sản phẩm đã ghép vào tour này')
  })

  it('hiểu tên tiếng Anh trên kênh so với tên gói tiếng Việt', () => {
    const food = [
      { id: 'HNF-EN', code: 'HNF-EN', name: 'Tiếng Anh, điểm hẹn', tour_id: 'HNF', tour_name: 'Food tour phố cổ Hà Nội', duration_minutes: 210, is_private: false },
      { id: 'HNF-PRV', code: 'HNF-PRV', name: 'Tour riêng', tour_id: 'HNF', tour_name: 'Food tour phố cổ Hà Nội', duration_minutes: 210, is_private: true },
    ]
    const s = suggestMapping({ product_code: 'V1', option_code: 'TG1', product_title: 'Hanoi Street Food Walk', option_title: 'English food walk 3.5 hours' }, food)
    expect(s.option_id).toBe('HNF-EN')
    expect(s.reasons).toContain('Tên gần giống')
  })

  it('không có tên thì không gợi ý', () => {
    expect(suggestMapping({ product_code: 'P1', option_code: '' }, options)).toMatchObject({ option_id: null, confidence: 'none' })
  })

  it('tách tên sản phẩm và lựa chọn khỏi báo cáo', () => {
    expect(channelTitles('gyg', { Product: '1234567 [T-1234567] Hanoi Jeep Tour', Option: '[Tour riêng 2 tiếng] Private tour' }))
      .toEqual({ product_title: 'Hanoi Jeep Tour', option_title: 'Tour riêng 2 tiếng · Private tour' })
    expect(channelTitles('gyg', { Product: '1147291 [JEEP-HNCITY-01] Hanoi Military Jeep Tour', Option: '[HN Jeep City Ghép] Shared 4-Hour Tour' }))
      .toEqual({ product_title: 'Hanoi Military Jeep Tour', option_title: 'HN Jeep City Ghép · Shared 4-Hour Tour' })
    expect(channelTitles('gyg', { Product: '1 [T-1] X', Option: '[Chỉ tên nội bộ]' })).toEqual({ product_title: 'X', option_title: 'Chỉ tên nội bộ' })
    // Phần sau ngoặc ghi thời lượng và kiểu tour: đủ để gợi ý dù tên nội bộ không nói gì.
    const s = suggestMapping({ product_code: 'JEEP-X', option_code: 'Jeepcity', ...channelTitles('gyg', { Product: '1 [JEEP-X] Hanoi Jeep Tour', Option: '[Jeepcity] Private 4-Hour Tour - City Highlights' }) }, options)
    expect(s.option_id).toBe('RIENG-4H')
    expect(channelTitles('viator', { 'Product Name': 'Hanoi Jeep Tour', 'Tour Grade Title': 'Shared 2-Hour Jeep Tour 13:00' }))
      .toEqual({ product_title: 'Hanoi Jeep Tour', option_title: 'Shared 2-Hour Jeep Tour 13:00' })
    expect(channelTitles(undefined, { Product: 'x' })).toEqual({})
  })
})
