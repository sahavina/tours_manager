import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

// Trạng thái bảng nằm trên URL (ADR-046 của keodansaha): link chia sẻ được, F5 và nút back giữ ngữ cảnh.
// Giá trị mặc định không ghi lên URL; ghi bằng replace để không làm đầy lịch sử trình duyệt.
export type TableState = { page: number; pageSize: number; sort?: string; desc: boolean; filters: Record<string, string> }

const RESERVED = new Set(['page', 'size', 'sort', 'desc'])

export function useUrlTable(defaultSize = 25) {
  const [params, setParams] = useSearchParams()

  const state = useMemo<TableState>(() => {
    const page = Math.max(1, Number(params.get('page')) || 1)
    const pageSize = [10, 25, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : defaultSize
    const filters: Record<string, string> = {}
    params.forEach((value, key) => {
      if (!RESERVED.has(key) && value !== '') filters[key] = value
    })
    return { page, pageSize, sort: params.get('sort') ?? undefined, desc: params.get('desc') === '1', filters }
  }, [params, defaultSize])

  const patch = useCallback(
    (next: Partial<{ page: number; pageSize: number; sort: string | undefined; desc: boolean }> & { filters?: Record<string, string | undefined> }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          const set = (k: string, v: string | undefined) => (v ? p.set(k, v) : p.delete(k))
          if (next.filters) {
            for (const [k, v] of Object.entries(next.filters)) set(k, v)
            p.delete('page')
          }
          if ('page' in next) set('page', next.page && next.page > 1 ? String(next.page) : undefined)
          if ('pageSize' in next) set('size', next.pageSize !== defaultSize ? String(next.pageSize) : undefined)
          if ('sort' in next) set('sort', next.sort)
          if ('desc' in next) set('desc', next.desc ? '1' : undefined)
          return p
        },
        { replace: true },
      )
    },
    [setParams, defaultSize],
  )

  const replaceFilters = useCallback(
    (filters: Record<string, string>) => {
      setParams(new URLSearchParams(filters), { replace: true })
    },
    [setParams],
  )

  return { ...state, patch, replaceFilters }
}

/** Đọc/ghi localStorage an toàn: trình duyệt riêng tư có thể ném lỗi. */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Chỉ là tiện ích theo người xem; không lưu được thì thôi.
  }
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
