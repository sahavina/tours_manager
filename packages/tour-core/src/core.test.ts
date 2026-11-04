import { describe, expect, it } from 'vitest'
import {
  addSameCurrency, escapeCsvCell, formatMoney, formatPax, formatMinor, normalizeBookingRow, normalizeSettlementRow,
  parseAmountInput, parseCsv, parseDateInput, parseMinor, parseTimeInput, resultMessage, suggestColumnMap,
  sumByCurrency, toCsv,
} from './index'

describe('tiền', () => {
  it('cộng thập phân không sai số dấu phẩy động', () => {
    expect(formatMinor(parseMinor('0.1') + parseMinor('0.2'))).toBe('0.3')
  })
  it('không cộng khác tiền tệ', () => {
    expect(() => addSameCurrency({ amount: '1', currency: 'USD' }, { amount: '1', currency: 'EUR' })).toThrow(/Không cộng/)
    expect(addSameCurrency({ amount: '1.5', currency: 'USD' }, { amount: '1.25', currency: 'USD' })).toEqual({ amount: '2.75', currency: 'USD' })
  })
  it('tổng tách theo tiền tệ và đếm khoản chưa có dữ liệu', () => {
    expect(sumByCurrency([
      { amount: '10.5', currency: 'USD' }, { amount: '1000', currency: 'VND' },
      { amount: '4.5', currency: 'USD' }, { amount: null, currency: 'USD' },
    ])).toEqual([
      { currency: 'USD', amount: '15', missing: 1 },
      { currency: 'VND', amount: '1000', missing: 0 },
    ])
  })
  it('giá trị chưa biết hiển thị là chưa có dữ liệu, không phải 0', () => {
    expect(formatMoney(null, 'USD')).toBe('Chưa có dữ liệu')
    expect(formatMoney('0', 'USD')).toBe('0,00 USD')
    expect(formatMoney('1234567.5', 'USD')).toBe('1.234.567,50 USD')
    expect(formatMoney('1500000', 'VND')).toBe('1.500.000 VND')
  })
})

describe('CSV', () => {
  it('đọc ngoặc kép, xuống dòng trong ô, BOM và dấu chấm phẩy', () => {
    const p = parseCsv('﻿a;b\r\n"x;1";"dòng\n2"\r\n\r\n')
    expect(p.headers).toEqual(['a', 'b'])
    expect(p.rows).toEqual([{ a: 'x;1', b: 'dòng\n2' }])
  })
  it('vô hiệu hóa công thức khi xuất, không làm hỏng số âm', () => {
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(escapeCsvCell('@cmd')).toBe(`'@cmd`)
    expect(escapeCsvCell('+84123')).toBe(`'+84123`)
    expect(escapeCsvCell('-12.5')).toBe('-12.5')
    expect(escapeCsvCell(null)).toBe('')
    expect(toCsv([{ a: '=1+1' }])).toBe(`﻿a\r\n'=1+1\r\n`)
  })
})

describe('chuẩn hóa dòng nhập', () => {
  const map = suggestColumnMap(['Booking Reference', 'Product Code', 'Travel Date', 'Time', 'Adults', 'Amount', 'Currency', 'Hotel'])
  const base = { 'Booking Reference': 'B1', 'Product Code': 'P1', 'Travel Date': '15/01/2030', Time: '8:30', Adults: '2', Amount: '1.234,50', Currency: 'usd', Hotel: 'KS' }

  it('đoán cột theo tên và chuyển đổi đúng', () => {
    expect(map.external_ref).toBe('Booking Reference')
    const r = normalizeBookingRow(base, map, 'Asia/Ho_Chi_Minh')
    expect(r.errors).toEqual([])
    expect(r.normalized).toMatchObject({
      external_ref: 'B1', status: 'confirmed', gross_amount: '1234.50', currency: 'USD',
      items: [{ local_date: '2030-01-15', local_time: '08:30:00', pax: { adult: 2 }, pickup: { hotel: 'KS' } }],
    })
  })
  it('báo đủ lỗi, không đoán bừa', () => {
    const r = normalizeBookingRow({ ...base, 'Booking Reference': '', 'Travel Date': '31/02/2030', Adults: 'hai', Amount: 'abc', Currency: 'X' }, map)
    expect(r.normalized).toBeNull()
    expect(r.errors.join('|')).toMatch(/Thiếu mã booking/)
    expect(r.errors.join('|')).toMatch(/Ngày đi không hợp lệ/)
    expect(r.errors.join('|')).toMatch(/Số người lớn không hợp lệ/)
    expect(r.errors.join('|')).toMatch(/Số tiền không hợp lệ/)
    expect(r.errors.join('|')).toMatch(/Tiền tệ không hợp lệ/)
  })
  it('có số tiền mà thiếu tiền tệ là lỗi, thiếu số khách là lỗi', () => {
    expect(normalizeBookingRow({ ...base, Currency: '' }, map).errors).toContain('Có số tiền nhưng thiếu tiền tệ')
    expect(normalizeBookingRow({ ...base, Adults: '0' }, map).errors).toContain('Số khách phải lớn hơn 0')
  })
  it('định dạng ngày, giờ, tiền', () => {
    expect(parseDateInput('2030-1-5')).toBe('2030-01-05')
    expect(parseDateInput('01/13/2030')).toBeNull()
    expect(parseTimeInput('25:00')).toBeNull()
    expect(parseAmountInput('1,234.50')).toBe('1234.50')
    expect(parseAmountInput('1.234.567')).toBe('1234567')
    expect(parseAmountInput('1500000')).toBe('1500000')
    expect(parseAmountInput('12,5')).toBe('12.5')
    expect(parseAmountInput('abc')).toBeNull()
  })
  it('dòng đối soát lỗi vẫn giữ giá trị gốc để server đưa vào hàng chờ', () => {
    const r = normalizeSettlementRow({ ref: 'A', cur: 'usd', net: 'lỗi' }, { external_ref: 'ref', currency: 'cur', net: 'net' }, 2)
    expect(r).toMatchObject({ row_no: 2, external_ref: 'A', currency: 'USD', net: 'lỗi', gross: null })
  })
})

describe('nhóm khách', () => {
  it('hiện tên tiếng Việt, mã lạ giữ nguyên để không giấu dữ liệu', () => {
    expect(formatPax({ adult: 2, child: 1 })).toBe('Người lớn 2, Trẻ em 1')
    expect(formatPax({ martian: 1 })).toBe('martian 1')
    expect(formatPax(null)).toBe('')
  })
})

describe('thông điệp', () => {
  it('mã lạ rơi về câu chung, không rò chuỗi thô', () => {
    expect(resultMessage('no_seats')).toMatch(/Không đủ chỗ/)
    expect(resultMessage('42P01: relation missing')).not.toMatch(/relation/)
  })
})
