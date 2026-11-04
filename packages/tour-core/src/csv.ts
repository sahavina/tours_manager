// CSV theo RFC 4180 (ngoặc kép, xuống dòng trong ô). Tự viết vì chỉ cần phần này và cần kiểm soát
// chống công thức khi xuất.

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_IMPORT_ROWS = 5000

export type ParsedCsv = { headers: string[]; rows: Array<Record<string, string>>; delimiter: string }

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string) => first.split(ch).length - 1
  return [',', ';', '\t'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',')
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^﻿/, '')
  const delimiter = detectDelimiter(text)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      record.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      record.push(field)
      field = ''
      records.push(record)
      record = []
    } else {
      field += ch
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }

  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''))
  const headerRow = nonEmpty[0]
  if (!headerRow) return { headers: [], rows: [], delimiter }

  const headers = headerRow.map((h) => h.trim())
  const rows = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { headers, rows, delimiter }
}

/** Ô bắt đầu bằng = + - @ hay ký tự điều khiển bị Excel coi là công thức: thêm dấu nháy để vô hiệu hóa. */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  const isPlainNumber = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(text)
  if (/^[=+\-@\t\r]/.test(text) && !isPlainNumber) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns?: readonly string[]): string {
  const headers = columns ?? (rows[0] ? Object.keys(rows[0]) : [])
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) lines.push(headers.map((h) => escapeCsvCell(row[h])).join(','))
  // BOM để Excel đọc đúng tiếng Việt.
  return `﻿${lines.join('\r\n')}\r\n`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
