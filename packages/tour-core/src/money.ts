// Tiền ở tầng ứng dụng là CHUỖI thập phân, đúng như numeric của Postgres trả về. Không đưa qua Number
// để tính: 0.1 + 0.2 không bằng 0.3. Cộng trừ dùng BigInt ở đơn vị 1/10000, bằng thang numeric(18,4).

const SCALE = 4
const FACTOR = 10n ** BigInt(SCALE)
const ZERO_DECIMAL = new Set(['VND', 'JPY', 'KRW'])

export type Money = { amount: string; currency: string }

export function parseMinor(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!m) throw new Error(`Số tiền không hợp lệ: ${value}`)
  const frac = (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE)
  const abs = BigInt(m[2]!) * FACTOR + BigInt(frac || '0')
  return m[1] ? -abs : abs
}

export function formatMinor(minor: bigint): string {
  const neg = minor < 0n
  const abs = neg ? -minor : minor
  const whole = abs / FACTOR
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** Tổng theo từng tiền tệ. Không có hàm nào trong gói này cộng băng qua tiền tệ. */
export function sumByCurrency(items: ReadonlyArray<{ amount: string | null | undefined; currency: string | null | undefined }>) {
  const totals = new Map<string, { total: bigint; missing: number }>()
  for (const { amount, currency } of items) {
    if (!currency) continue
    const entry = totals.get(currency) ?? { total: 0n, missing: 0 }
    if (amount === null || amount === undefined || amount === '') entry.missing += 1
    else entry.total += parseMinor(amount)
    totals.set(currency, entry)
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, { total, missing }]) => ({ currency, amount: formatMinor(total), missing }))
}

export function addSameCurrency(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Không cộng được ${a.currency} với ${b.currency}`)
  }
  return { amount: formatMinor(parseMinor(a.amount) + parseMinor(b.amount)), currency: a.currency }
}

/** null trở thành "Chưa có dữ liệu", không bao giờ thành 0. */
export function formatMoney(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'Chưa có dữ liệu'
  const text = String(amount)
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return text
  const digits = currency && ZERO_DECIMAL.has(currency) ? 0 : 2
  const frac = (m[3] ?? '').padEnd(digits, '0').slice(0, digits)
  const whole = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const body = `${m[1]}${whole}${frac ? `,${frac}` : ''}`
  return currency ? `${body} ${currency}` : body
}
