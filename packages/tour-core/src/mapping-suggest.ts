// Gợi ý gói nội bộ cho mã sản phẩm kênh chưa được ghép. Chỉ là gợi ý: người dùng phải xác nhận, vì ghép nhầm làm
// booking vào sai chuyến và chiếm chỗ của khách khác.

export type ChannelProductTitle = { product_title?: string; option_title?: string }

/** Tên sản phẩm và lựa chọn trên kênh, đọc từ dòng gốc của báo cáo. CSV ánh xạ tay không có tên nên trả rỗng. */
export function channelTitles(preset: 'gyg' | 'viator' | undefined | null, raw: Record<string, string> | null | undefined): ChannelProductTitle {
  if (!raw) return {}
  if (preset === 'gyg') {
    // "1272618 [T-1272618] Tên sản phẩm" và "[Tên lựa chọn] mô tả thêm".
    const product = raw.Product?.replace(/^[^\]]*\[T-\d+\]\s*/, '').trim()
    const option = (/^\s*\[([^\]]*)\]/.exec(raw.Option ?? '')?.[1] ?? raw.Option ?? '').trim()
    return { product_title: product || undefined, option_title: option || undefined }
  }
  if (preset === 'viator') {
    return { product_title: raw['Product Name']?.trim() || undefined, option_title: raw['Tour Grade Title']?.trim() || undefined }
  }
  return {}
}

export type MappingCandidate = {
  id: string
  code: string
  name: string
  tour_id: string
  tour_name: string
  duration_minutes?: number | null
  is_private: boolean
}

export type UnmappedCode = { product_code: string; option_code: string } & ChannelProductTitle

export type MappingSuggestion = {
  option_id: string | null
  confidence: 'high' | 'medium' | 'none'
  reasons: string[]
  score: number
  /** Các gói điểm ngang nhau khi không đủ căn cứ để chọn một. */
  alternatives: string[]
}

const STOP = new Set(['tour', 'tours', 'the', 'and', 'a', 'an', 'of', 'with', 'in', 'from', 'by', 'to', 'for', 'on', 'va', 'cua', 'tu', 'trong', 'voi', 'option', 'goi'])

export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9.,]+/g, ' ').trim()
}

// Tên gói thường viết tiếng Việt, tên trên kênh viết tiếng Anh: quy về một cách viết trước khi so chữ.
const PHRASES: [RegExp, string][] = [
  [/\bha noi\b/g, 'hanoi'], [/\bha long\b/g, 'halong'], [/\bhoi an\b/g, 'hoian'], [/\bninh binh\b/g, 'ninhbinh'], [/\bsa pa\b/g, 'sapa'],
  [/\btieng anh\b/g, 'english'], [/\btieng phap\b/g, 'french'], [/\btieng han\b/g, 'korean'], [/\btieng viet\b/g, 'vietnamese'],
  [/\bvinh\b/g, 'bay'], [/\bpho co\b/g, 'old quarter'], [/\bam thuc\b/g, 'food'],
]
// Thời lượng đã được chấm riêng, nên bỏ các chữ chỉ đơn vị giờ để không cộng điểm hai lần.
const UNIT = new Set(['h', 'hr', 'hrs', 'hour', 'hours', 'gio', 'tieng', 'ngay', 'day'])

const tokens = (s: string) => {
  let t = foldText(s).replace(/[.,]/g, ' ')
  for (const [re, to] of PHRASES) t = t.replace(re, to)
  return new Set(t.split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !UNIT.has(w) && !/^\d+$/.test(w)))
}

/** "4 hours", "2.0 tiếng", "4h", "3,5 giờ" thành số phút. */
export function durationFromText(s: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|gio|tieng)\b/.exec(foldText(s))
  if (!m) return null
  const minutes = Math.round(Number(m[1]!.replace(',', '.')) * 60)
  return minutes > 0 ? minutes : null
}

export function privacyFromText(s: string): 'private' | 'shared' | null {
  const t = foldText(s)
  if (/\b(private|privately|rieng)\b/.test(t)) return 'private'
  if (/\b(shared|ghep|join|joined|group)\b/.test(t)) return 'shared'
  return null
}

const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const t of a) if (b.has(t)) common += 1
  return (2 * common) / (a.size + b.size)
}

/**
 * Chấm điểm từng gói theo: chữ trùng giữa tên trên kênh và tên gói, thời lượng, riêng hay ghép, và các mã khác của
 * cùng sản phẩm đã ghép vào tour nào. Sai thời lượng hoặc sai riêng/ghép thì loại hẳn, vì đó là lỗi gây hại nhất.
 */
export function suggestMapping(
  code: UnmappedCode,
  candidates: MappingCandidate[],
  sameProductTours: string[] = [],
): MappingSuggestion {
  const text = [code.product_title, code.option_title].filter(Boolean).join(' ')
  const extTokens = tokens(text)
  const extDuration = text ? durationFromText(code.option_title ?? '') ?? durationFromText(text) : null
  const extPrivacy = text ? privacyFromText(code.option_title ?? '') ?? privacyFromText(text) : null

  const scored = candidates.map((c) => {
    const reasons: string[] = []
    let score = 0
    let excluded = false

    const similarity = dice(extTokens, tokens(`${c.tour_name} ${c.name}`))
    score += similarity * 0.6
    if (similarity >= 0.3) reasons.push('Tên gần giống')

    if (sameProductTours.includes(c.tour_id)) {
      score += 0.25
      reasons.push('Mã khác của cùng sản phẩm đã ghép vào tour này')
    }

    const candDuration = c.duration_minutes ?? durationFromText(c.name)
    if (extDuration && candDuration) {
      if (extDuration === candDuration) {
        score += 0.2
        reasons.push(`Cùng thời lượng ${extDuration / 60} tiếng`)
      } else excluded = true
    }

    if (extPrivacy) {
      const candPrivacy = c.is_private ? 'private' : 'shared'
      if (extPrivacy === candPrivacy) {
        score += 0.15
        reasons.push(c.is_private ? 'Cùng là tour riêng' : 'Cùng là tour ghép')
      } else excluded = true
    }

    return { c, score, reasons, excluded }
  }).filter((s) => !s.excluded).sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best || best.score < 0.3) return { option_id: null, confidence: 'none', reasons: [], score: best?.score ?? 0, alternatives: [] }
  const runnerUp = scored[1]?.score ?? 0
  // Hai gói gần như ngang điểm, ví dụ tên chỉ ghi "2 tiếng" mà không nói riêng hay ghép: không chọn hộ.
  if (best.score - runnerUp < 0.05) {
    const tied = scored.filter((s) => best.score - s.score < 0.05).map((s) => s.c.id)
    return { option_id: null, confidence: 'none', reasons: [`${tied.length} gói điểm ngang nhau, cần chọn tay`], score: best.score, alternatives: tied }
  }
  const confidence = best.score >= 0.55 && best.score - runnerUp >= 0.15 ? 'high' : 'medium'
  if (confidence === 'medium' && runnerUp > 0 && best.score - runnerUp < 0.15) best.reasons.push('Có gói khác điểm gần bằng')
  return { option_id: best.c.id, confidence, reasons: best.reasons, score: best.score, alternatives: [] }
}
