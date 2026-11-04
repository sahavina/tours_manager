// Đối chiếu tĩnh giao diện với schema thật. Tên cột hay tham số RPC sai chỉ lộ ra lúc người dùng bấm nút,
// nên bài này quét mã nguồn apps/admin và hỏi thẳng catalog của Postgres:
//   * mọi rpc('ten', {p_x}) phải tồn tại, authenticated được EXECUTE, tên tham số khớp;
//   * mọi .from('bang').select('...') phải có cột, quan hệ nhúng phải có khóa ngoại;
//   * mọi cột trong câu select được authenticated phép đọc (channel_connections chỉ cấp theo cột).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, owner } from './test/harness'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', '..', '..', 'apps', 'admin', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}
const files = walk(srcDir).map((p) => ({ path: relative(srcDir, p), text: readFileSync(p, 'utf8') }))

/** Tách theo dấu phẩy ở cấp ngoài cùng, giữ nguyên phần trong ngoặc. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const columns = new Map<string, Set<string>>()
const fkPairs = new Set<string>()
const allowed = new Set<string>()
const functions = new Map<string, { args: string[]; canExec: boolean }>()

beforeAll(async () => {
  for (const r of await owner<{ t: string; c: string; ok: boolean }>(`
    select c.table_name t, c.column_name c,
      has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select') ok
    from information_schema.columns c where c.table_schema = 'public'`)) {
    if (!columns.has(r.t)) columns.set(r.t, new Set())
    columns.get(r.t)!.add(r.c)
    if (r.ok) allowed.add(`${r.t}.${r.c}`)
  }
  for (const r of await owner<{ a: string; b: string }>(`
    select a.relname a, b.relname b from pg_constraint k
    join pg_class a on a.oid = k.conrelid join pg_class b on b.oid = k.confrelid
    where k.contype = 'f' and a.relnamespace = 'public'::regnamespace and b.relnamespace = 'public'::regnamespace`)) {
    fkPairs.add(`${r.a}>${r.b}`)
    fkPairs.add(`${r.b}>${r.a}`)
  }
  for (const r of await owner<{ name: string; args: string[] | null; ok: boolean }>(`
    select p.proname "name", p.proargnames args, has_function_privilege('authenticated', p.oid, 'execute') ok
    from pg_proc p where p.pronamespace = 'public'::regnamespace`)) {
    functions.set(r.name, { args: r.args ?? [], canExec: r.ok })
  }
})
afterAll(closePool)

// View được PostgREST suy quan hệ từ bảng gốc; các view của app chỉ select cột phẳng nên không cần khai.
function checkSelect(table: string, select: string, where: string, errors: string[]) {
  const cols = columns.get(table)
  if (!cols) return errors.push(`${where}: không có bảng ${table}`)
  for (const part of splitTop(select)) {
    if (part === '*') continue
    const embed = /^(\w+)\((.*)\)$/s.exec(part)
    if (embed) {
      const child = embed[1]!
      if (!columns.has(child)) errors.push(`${where}: nhúng bảng không tồn tại ${child}`)
      else {
        if (!fkPairs.has(`${table}>${child}`)) errors.push(`${where}: ${table} và ${child} không có khóa ngoại`)
        checkSelect(child, embed[2]!, where, errors)
      }
    } else if (!cols.has(part)) {
      errors.push(`${where}: ${table} không có cột ${part}`)
    } else if (!allowed.has(`${table}.${part}`)) {
      errors.push(`${where}: authenticated không được đọc ${table}.${part}`)
    }
  }
}

describe('hợp đồng giao diện với database', () => {
  it('bộ quét thực sự tìm thấy lời gọi', () => {
    const all = files.map((f) => f.text).join('\n')
    expect((all.match(/rpc(?:Ok)?(?:<[^>]*>)?\('/g) ?? []).length).toBeGreaterThan(40)
    expect((all.match(/\.from\('/g) ?? []).length).toBeGreaterThan(40)
  })

  it('mọi RPC tồn tại, được phép gọi, đúng tên tham số', () => {
    const errors: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/\brpc(?:Ok)?(?:<[^(]*?>)?\(\s*'(\w+)'(?:\s*,\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\})?/g)) {
        const name = m[1]!
        const fn = functions.get(name)
        if (!fn) {
          errors.push(`${f.path}: không có hàm ${name}`)
          continue
        }
        if (!fn.canExec) errors.push(`${f.path}: authenticated không gọi được ${name}`)
        for (const k of (m[2] ?? '').matchAll(/\b(p_\w+)\s*:/g)) {
          if (!fn.args.includes(k[1]!)) errors.push(`${f.path}: ${name} không có tham số ${k[1]}`)
        }
      }
    }
    expect(errors).toEqual([])
  })

  it('mọi fn động trong act.mutate cũng tồn tại, đúng tham số', () => {
    const errors: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/fn:\s*'(\w+)',\s*args:\s*\{([^}]*)\}/g)) {
        const fn = functions.get(m[1]!)
        if (!fn) {
          errors.push(`${f.path}: không có hàm ${m[1]}`)
          continue
        }
        if (!fn.canExec) errors.push(`${f.path}: authenticated không gọi được ${m[1]}`)
        for (const k of m[2]!.matchAll(/\b(p_\w+)\s*:/g)) {
          if (!fn.args.includes(k[1]!)) errors.push(`${f.path}: ${m[1]} không có tham số ${k[1]}`)
        }
      }
    }
    expect(errors).toEqual([])
  })

  it('mọi câu select có đúng cột và quan hệ', () => {
    const errors: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/\.from\('(\w+)'\)\s*\.select\(\s*(?:'([^']*)'|(CONNECTION_COLUMNS))/g)) {
        if (m[3]) continue
        checkSelect(m[1]!, m[2]!, f.path, errors)
      }
    }
    // Hằng số dùng chung.
    const shared = files.find((f) => f.path.endsWith('supabase.ts'))!.text
    const cols = /CONNECTION_COLUMNS =\s*'([^']+)'/.exec(shared)![1]!
    checkSelect('channel_connections', cols, 'CONNECTION_COLUMNS', errors)
    expect(errors).toEqual([])
  })

  it('mọi bộ lọc .eq trên bảng được nêu ngay trong chuỗi lệnh dùng cột có thật', () => {
    const errors: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/\.from\('(\w+)'\)\s*\.select\([^)]*(?:\([^)]*\)[^)]*)*\)((?:\s*\.(?:eq|gte|lte|gt|is|in|ilike|order)\('\w+'[^)]*\)|\s*\.or\([^)]*\))+)/g)) {
        const cols = columns.get(m[1]!)
        if (!cols) continue
        for (const k of m[2]!.matchAll(/\.(?:eq|gte|lte|gt|is|in|ilike|order)\('(\w+)'/g)) {
          if (!cols.has(k[1]!)) errors.push(`${f.path}: ${m[1]} không có cột lọc ${k[1]}`)
        }
      }
    }
    expect(errors).toEqual([])
  })

  it('quan hệ nhúng mà giao diện đọc như một đối tượng phải là 1-1 thật (PostgREST mới trả object)', async () => {
    // Giao diện đọc `b.booking_financials?.expected_payout`: nếu thành mảng thì ra undefined, không lỗi.
    const [r] = await owner<{ ok: boolean }>(`
      select exists (
        select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
        where c.relname = 'booking_financials' and k.contype in ('u', 'p')
          and (select array_agg(a.attname order by a.attname) from pg_attribute a
               where a.attrelid = k.conrelid and a.attnum = any (k.conkey)) = array['booking_id', 'organization_id']::name[]
      ) as ok`)
    expect(r!.ok).toBe(true)
  })

  it('khóa API không đi qua giao diện: không select credential_ref', () => {
    for (const f of files) {
      if (/select\([^)]*credential_ref/.test(f.text)) throw new Error(`${f.path} đọc credential_ref`)
    }
  })
})
