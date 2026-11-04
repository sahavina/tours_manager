import { parseAmountInput, type ColumnMap } from './booking-import'

export const SETTLEMENT_FIELDS = [
  { key: 'external_ref', label: 'Mã booking', required: true, aliases: ['booking reference', 'reference', 'booking ref', 'mã booking'] },
  { key: 'currency', label: 'Tiền tệ', required: true, aliases: ['currency', 'tiền tệ'] },
  { key: 'gross', label: 'Giá trị bán', required: false, aliases: ['gross', 'gross amount', 'retail', 'giá trị bán'] },
  { key: 'fee', label: 'Phí kênh', required: false, aliases: ['fee', 'commission', 'phí', 'phí kênh'] },
  { key: 'net', label: 'Thực nhận', required: true, aliases: ['net', 'net amount', 'payout', 'thực nhận'] },
] as const

/** Dòng lỗi vẫn được gửi lên để server đưa vào hàng chờ, không bị vứt ở trình duyệt. */
export function normalizeSettlementRow(row: Record<string, string>, map: ColumnMap, rowNo: number) {
  const get = (key: string) => {
    const col = map[key]
    return col ? (row[col] ?? '').trim() : ''
  }
  const amount = (key: string) => {
    const raw = get(key)
    return raw === '' ? null : (parseAmountInput(raw) ?? raw)
  }
  return {
    row_no: rowNo,
    external_ref: get('external_ref'),
    currency: get('currency').toUpperCase(),
    gross: amount('gross'),
    fee: amount('fee'),
    net: amount('net'),
    raw: row,
  }
}
