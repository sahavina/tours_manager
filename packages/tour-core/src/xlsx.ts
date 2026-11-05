// Đọc bảng từ file .xlsx. Chỉ lấy giá trị ô, không chạy công thức. Viết tay trên XML vì chỉ cần phần này và
// các thư viện xlsx đầy đủ quá nặng cho một app nội bộ.
import { strFromU8, unzipSync } from 'fflate'

export type XlsxSheet = { name: string; headers: string[]; rows: Array<Record<string, string>> }

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1]

const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => decode(m[1] ?? '')).join('')

function columnIndex(ref: string): number {
  let n = 0
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const out: string[][] = []
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = []
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? ''
      const body = c[2] ?? ''
      const type = attr(attrs, 't')
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(body) : decode(v ?? '')
      cells[columnIndex(attr(attrs, 'r') ?? '')] = value
    }
    out.push(Array.from(cells, (x) => x ?? ''))
  }
  return out
}

export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  const files = unzipSync(bytes)
  const read = (path: string) => (files[path] ? strFromU8(files[path]!) : '')
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ''))
  const rels = new Map(
    [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1] ?? '', 'Id'), attr(m[1] ?? '', 'Target')]),
  )
  const sheets: XlsxSheet[] = []
  for (const s of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const target = rels.get(attr(s[1] ?? '', 'r:id'))
    if (!target) continue
    const grid = parseSheet(read(target.startsWith('/') ? target.slice(1) : `xl/${target}`), shared)
    const headers = (grid[0] ?? []).map((h) => h.trim())
    const rows = grid.slice(1)
      .filter((r) => r.some((c) => c.trim() !== ''))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h)))
    sheets.push({ name: decode(attr(s[1] ?? '', 'name') ?? ''), headers, rows })
  }
  return sheets
}

/** Số serial ngày giờ của Excel thành chuỗi, giữ nguyên giờ ghi trong ô, không đổi múi giờ. */
export function excelSerialToParts(value: string): { date: string; time: string } | null {
  const serial = Number(value)
  if (value.trim() === '' || !Number.isFinite(serial) || serial <= 0) return null
  // Mốc 1899-12-30 là cách Excel tính; làm tròn về giây để bỏ sai số dấu phẩy động.
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) }
}
