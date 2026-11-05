import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { excelSerialToParts, isGygExport, normalizeGygRow, readXlsx } from './index'

// Toàn bộ là dữ liệu giả.
const base: Record<string, string> = {
  'Booking Ref #': 'GYGFAKE00001',
  Date: '46331.541666666664',
  'Purchase Date (local time)': '46329.27082175926',
  Product: '1272618 [T-1272618] Tour giả',
  Option: '[Tour 2.0 tiếng ] Shared Tour (2 Hours)',
  "Traveler's First Name": 'Khach',
  "Traveler's Last Name": 'Gia',
  Email: 'khach@example.invalid',
  Phone: '+10000000000',
  Adult: '2.0',
  Child: '',
  Price: '1260000.00 VND',
  'Net Price': '882000.00 VND',
  Language: 'English',
  'Additional Information': "'",
}

function makeXlsx(sheets: Array<{ name: string; grid: Array<Array<string | number>> }>) {
  const shared: string[] = []
  const files: Record<string, Uint8Array> = {}
  const col = (i: number) => String.fromCharCode(65 + i)
  sheets.forEach((s, si) => {
    const rows = s.grid.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      const ref = `${col(c)}${r + 1}`
      if (v === '') return ''
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
      shared.push(v)
      return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`
    }).join('')}</row>`).join('')
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)
  })
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`)
  files['xl/workbook.xml'] = strToU8(`<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  return zipSync(files)
}

describe('đọc xlsx', () => {
  it('đọc nhiều sheet theo thứ tự, chuỗi dùng chung, số, ô trống và ký tự đặc biệt', () => {
    const sheets = readXlsx(makeXlsx([
      { name: '05-11-2026', grid: [['A', 'B', 'C'], ['x & y', '', 1.5]] },
      { name: '06-11-2026', grid: [['A', 'B', 'C'], ['tiếng Việt', 'b', 2], ['', '', '']] },
    ]))
    expect(sheets.map((s) => s.name)).toEqual(['05-11-2026', '06-11-2026'])
    expect(sheets[0]!.rows).toEqual([{ A: 'x & y', B: '', C: '1.5' }])
    expect(sheets[1]!.rows).toEqual([{ A: 'tiếng Việt', B: 'b', C: '2' }])
  })

  it('đổi số serial Excel đúng ngày giờ ghi trong ô', () => {
    expect(excelSerialToParts('46331.541666666664')).toEqual({ date: '2026-11-05', time: '13:00:00' })
    expect(excelSerialToParts('46331.520833333336')).toEqual({ date: '2026-11-05', time: '12:30:00' })
    expect(excelSerialToParts('')).toBeNull()
    expect(excelSerialToParts('abc')).toBeNull()
  })
})

describe('báo cáo GetYourGuide', () => {
  it('nhận diện đúng theo cột, file thiếu cột thì không nhận', () => {
    expect(isGygExport(Object.keys(base))).toBe(true)
    expect(isGygExport(['Booking Ref #', 'Date'])).toBe(false)
  })

  it('tách mã sản phẩm, gói, giờ, số khách, tiền và phí', () => {
    const r = normalizeGygRow(base)
    expect(r.errors).toEqual([])
    expect(r.normalized).toMatchObject({
      external_ref: 'GYGFAKE00001', status: 'confirmed', gross_amount: '1260000.00', currency: 'VND',
      booked_at: '2026-11-03T06:29:59+07:00',
      financials: { channel_fee: '378000', expected_payout: '882000.00' },
      lead: { name: 'Khach Gia', email: 'khach@example.invalid' },
      items: [{ product_code: 'T-1272618', option_code: 'Tour 2.0 tiếng', local_date: '2026-11-05', local_time: '13:00:00', pax: { adult: 2 } }],
    })
  })

  it('dấu nháy đơn của ô trống không thành yêu cầu đặc biệt, nội dung thật thì giữ', () => {
    expect(normalizeGygRow(base).normalized?.special_requests).toBeUndefined()
    expect(normalizeGygRow({ ...base, 'Additional Information': 'Ăn chay' }).normalized?.special_requests).toBe('Ăn chay')
  })

  it('thiếu giá thực nhận hoặc khác tiền tệ thì phí để trống, không thành 0', () => {
    expect(normalizeGygRow({ ...base, 'Net Price': '' }).normalized?.financials).toEqual({ channel_fee: undefined, expected_payout: undefined })
    expect(normalizeGygRow({ ...base, 'Net Price': '100.00 USD' }).normalized?.financials).toEqual({ channel_fee: undefined, expected_payout: '100.00' })
  })

  it('báo đủ lỗi và không đoán bừa', () => {
    const r = normalizeGygRow({ ...base, 'Booking Ref #': '', Date: 'x', Product: 'Không có mã', Adult: 'hai', Price: 'miễn phí' })
    expect(r.normalized).toBeNull()
    expect(r.errors.join('|')).toMatch(/Thiếu mã booking.*Ngày đi.*mã sản phẩm.*Adult.*Giá/)
    expect(normalizeGygRow({ ...base, Adult: '0' }).errors).toContain('Số khách phải lớn hơn 0')
  })
})
