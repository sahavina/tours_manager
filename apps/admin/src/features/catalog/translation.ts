// Mức độ dịch tiếng Việt của tour: đếm các mục trong content_vi có nội dung so với các mục bản gốc (tiếng Anh) có nội dung.
import type { Row } from '../../lib/supabase'

export const VI_KEYS = ['name', 'duration_label', 'description', 'highlights', 'itinerary', 'inclusions', 'exclusions',
  'joining_instructions', 'what_to_bring', 'good_to_know'] as const

const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)

export function viProgress(tour: Row): { done: number; total: number } {
  const vi = (tour.content_vi ?? {}) as Row
  // Chỉ tính mục mà bản gốc có nội dung (bản gốc trống thì không cần dịch).
  const keys = VI_KEYS.filter((k) => filled(tour[k]))
  return { done: keys.filter((k) => filled(vi[k])).length, total: keys.length }
}
