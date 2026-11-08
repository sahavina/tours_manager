// Tối ưu thứ tự đón theo khoảng cách đường chim bay. Không biết đường một chiều, kẹt xe hay giờ khách hẹn, nên đây là
// đề xuất để điều hành xem xét, không phải tuyến chắc chắn ngắn nhất trên đường thật.

export type LatLng = { lat: number; lng: number }

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function routeKm(points: LatLng[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1]!, points[i]!)
  return total
}

function bestPermutation(points: LatLng[]): number[] {
  let best: number[] = points.map((_, i) => i)
  let bestLen = Infinity
  const walk = (path: number[], used: boolean[], len: number) => {
    if (len >= bestLen) return
    if (path.length === points.length) {
      best = [...path]
      bestLen = len
      return
    }
    for (let i = 0; i < points.length; i += 1) {
      if (used[i]) continue
      used[i] = true
      path.push(i)
      const last = path[path.length - 2]
      walk(path, used, len + (last === undefined ? 0 : haversineKm(points[last]!, points[i]!)))
      path.pop()
      used[i] = false
    }
  }
  walk([], points.map(() => false), 0)
  return best
}

function nearestThenTwoOpt(points: LatLng[]): number[] {
  const lengthOf = (order: number[]) => routeKm(order.map((i) => points[i]!))
  let best: number[] = []
  let bestLen = Infinity
  for (let start = 0; start < points.length; start += 1) {
    const left = new Set(points.map((_, i) => i))
    left.delete(start)
    const order = [start]
    while (left.size) {
      const from = points[order[order.length - 1]!]!
      let next = -1
      let nextLen = Infinity
      for (const i of left) {
        const d = haversineKm(from, points[i]!)
        if (d < nextLen) { next = i; nextLen = d }
      }
      order.push(next)
      left.delete(next)
    }
    let improved = true
    while (improved) {
      improved = false
      for (let i = 0; i < order.length - 1; i += 1) {
        for (let j = i + 1; j < order.length; j += 1) {
          const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)]
          if (lengthOf(candidate) + 1e-9 < lengthOf(order)) {
            order.splice(0, order.length, ...candidate)
            improved = true
          }
        }
      }
    }
    const len = lengthOf(order)
    if (len < bestLen) { best = [...order]; bestLen = len }
  }
  return best
}

/**
 * Thứ tự đi qua các điểm với tổng quãng đường ngắn nhất, không quay về điểm đầu. Tối đa 8 điểm thì thử mọi thứ tự;
 * nhiều hơn thì dùng phương pháp gần đúng. Hai chiều dài bằng nhau nên chọn chiều bắt đầu từ điểm xa trung tâm nhóm
 * hơn, để xe đi dần về khu đông khách.
 */
export function optimizeOrder(points: LatLng[]): number[] {
  if (points.length < 2) return points.map((_, i) => i)
  const order = points.length <= 8 ? bestPermutation(points) : nearestThenTwoOpt(points)
  const center = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length }
  const head = haversineKm(points[order[0]!]!, center)
  const tail = haversineKm(points[order[order.length - 1]!]!, center)
  return tail > head ? [...order].reverse() : order
}

/**
 * Các câu tìm kiếm cho một điểm đón, cụ thể trước. Địa chỉ từ kênh thường lặp tên khách sạn ("A, A, Phố B, Ha Noi"),
 * lặp lại làm dịch vụ tìm kiếm trả rỗng.
 */
export function geocodeQueries(raw: string, city = 'Hanoi'): string[] {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const clean = part.trim()
    const key = clean.toLowerCase()
    if (clean && !seen.has(key)) { seen.add(key); parts.push(clean) }
  }
  const queries = [parts.join(', ')]
  if (parts[0]) queries.push(`${parts[0]}, ${city}`)
  return [...new Set(queries.filter(Boolean))]
}

// Từ quá chung để nhận ra một khách sạn: có trùng cũng không nói lên điều gì.
const GENERIC_WORDS = new Set(['hotel', 'hotels', 'hoter', 'khach', 'san', 'ks', 'hanoi', 'ha', 'noi', 'vietnam', 'viet', 'nam', 'and', 'the', 'by', 'of', 'travel', 'spa', 'boutique', 'premium', 'luxury', 'grand', 'resort', 'apartment', 'apartments', 'suite', 'suites', 'hostel', 'homestay', 'central', 'old', 'quarter', 'house', 'inn', 'pho'])

const distinctiveWords = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1 && !GENERIC_WORDS.has(w))

/**
 * Tên dịch vụ trả về có đúng là khách sạn đang tìm không. Dịch vụ tìm kiếm mờ luôn trả về một kết quả gần nhất, kể cả
 * khách sạn khác hẳn, nên phải khớp ít nhất một nửa số từ đặc trưng; không có từ đặc trưng nào thì không nhận.
 */
export function placeNameMatches(query: string, found: string | null | undefined): boolean {
  const want = distinctiveWords(query)
  if (!want.length || !found) return false
  const have = new Set(distinctiveWords(found))
  const hits = want.filter((w) => have.has(w)).length
  return hits > 0 && hits * 2 >= want.length
}

/** Phần tên phố trong địa chỉ kênh gửi, dùng khi không tìm được chính khách sạn. Kết quả chỉ là vị trí gần đúng. */
export function streetQuery(raw: string, city = 'Ha Noi'): string | null {
  const street = raw.split(',').map((p) => p.trim()).find((p) => /^(ph\u1ed1|ng\u00f5|ng\u00e1ch|\u0111\u01b0\u1eddng|pho|ngo|duong)\s/i.test(p.normalize('NFC')))
  return street ? `${street}, ${city}` : null
}
