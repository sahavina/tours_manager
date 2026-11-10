// Cổng HTTP nhận yêu cầu của GetYourGuide. Viết theo Fetch API nên chạy được trên Cloudflare Workers và
// trong test Node. Không ghi log dữ liệu khách: chỉ đường dẫn, mã lỗi và thời gian.
import {
  fromDbResult,
  gygError,
  isBookingItems,
  isDateTime,
  parseLocalDateTime,
  tickets,
  toAvailability,
  type GygError,
} from './protocol.ts'

/** Gọi RPC PostgREST bằng service_role, tham số theo tên. Lỗi mạng hoặc HTTP thì ném. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>

export type GatewayConfig = {
  connectionId: string
  username: string
  password: string
  rpc: Rpc
  log?: (entry: Record<string, unknown>) => void
  /** Trả false khi khóa (thường là IP) đã vượt giới hạn. Kiểm tra trước cả mật khẩu để chặn dò mật khẩu. */
  allow?: (key: string) => Promise<boolean>
}

const MAX_BODY = 64 * 1024

function json(body: unknown): Response {
  // Lỗi nghiệp vụ cũng trả HTTP 200: tài liệu GetYourGuide chỉ mô tả mã 200 cho các endpoint này.
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** So mật khẩu không lộ thời gian: so hai bản băm cùng độ dài. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

async function authorized(req: Request, cfg: GatewayConfig): Promise<boolean> {
  if (!cfg.username || !cfg.password) return false
  const h = req.headers.get('authorization') ?? ''
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h)
  if (!m) return false
  let decoded: string
  try {
    decoded = atob(m[1]!)
  } catch {
    return false
  }
  const i = decoded.indexOf(':')
  if (i < 0) return false
  const [userOk, passOk] = await Promise.all([
    sameSecret(decoded.slice(0, i), cfg.username),
    sameSecret(decoded.slice(i + 1), cfg.password),
  ])
  return userOk && passOk
}

async function readData(req: Request): Promise<Record<string, any> | null> {
  const text = await req.text()
  if (text.length > MAX_BODY) return null
  try {
    const body = JSON.parse(text)
    return body && typeof body.data === 'object' && body.data !== null ? body.data : null
  } catch {
    return null
  }
}

const invalid = (msg: string) => gygError('VALIDATION_FAILURE', msg)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 255

type Route = (req: Request, url: URL, cfg: GatewayConfig, params: Record<string, string>) => Promise<unknown>

const routes: { method: string; pattern: RegExp; keys: string[]; run: Route }[] = [
  {
    method: 'GET',
    pattern: /^\/1\/get-availabilities\/?$/,
    keys: [],
    run: async (_req, url, cfg) => {
      const productId = url.searchParams.get('productId')
      const from = url.searchParams.get('fromDateTime')
      const to = url.searchParams.get('toDateTime')
      if (!nonEmpty(productId) || !isDateTime(from) || !isDateTime(to)) return invalid('productId, fromDateTime and toDateTime are required (ISO 8601).')
      const r = await cfg.rpc('gateway_gyg_availability', { p_connection: cfg.connectionId, p_product: productId, p_from: from, p_to: to })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: { availabilities: toAvailability(productId, r.items) } }
    },
  },
  {
    method: 'POST',
    pattern: /^\/1\/reserve\/?$/,
    keys: [],
    run: async (req, _url, cfg) => {
      const d = await readData(req)
      const at = parseLocalDateTime(d?.dateTime)
      if (!d || !nonEmpty(d.productId) || !at || !nonEmpty(d.gygBookingReference) || !isBookingItems(d.bookingItems)) {
        return invalid('productId, dateTime, bookingItems and gygBookingReference are required.')
      }
      const r = await cfg.rpc('gateway_gyg_reserve', {
        p_connection: cfg.connectionId,
        p_product: d.productId,
        p_local_date: at.date,
        p_local_time: at.time,
        p_items: d.bookingItems,
        p_gyg_ref: d.gygBookingReference,
      })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: { reservationReference: r.reference, reservationExpiration: new Date(r.expires_at).toISOString().replace(/\.\d{3}Z$/, '+00:00') } }
    },
  },
  {
    method: 'POST',
    pattern: /^\/1\/cancel-reservation\/?$/,
    keys: [],
    run: async (req, _url, cfg) => {
      const d = await readData(req)
      if (!d || !nonEmpty(d.reservationReference) || !nonEmpty(d.gygBookingReference)) return invalid('reservationReference and gygBookingReference are required.')
      const r = await cfg.rpc('gateway_gyg_cancel_reservation', { p_connection: cfg.connectionId, p_reference: d.reservationReference })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: {} }
    },
  },
  {
    method: 'POST',
    pattern: /^\/1\/book\/?$/,
    keys: [],
    run: async (req, _url, cfg) => {
      const d = await readData(req)
      const at = parseLocalDateTime(d?.dateTime)
      if (!d || !nonEmpty(d.productId) || !at || !nonEmpty(d.reservationReference) || !nonEmpty(d.gygBookingReference) || !isBookingItems(d.bookingItems)) {
        return invalid('productId, dateTime, bookingItems, reservationReference and gygBookingReference are required.')
      }
      const lead = Array.isArray(d.travelers) && d.travelers[0] && typeof d.travelers[0] === 'object' ? d.travelers[0] : {}
      const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined)
      const r = await cfg.rpc('gateway_gyg_book', {
        p_connection: cfg.connectionId,
        p_reference: d.reservationReference,
        p_product: d.productId,
        p_local_date: at.date,
        p_local_time: at.time,
        p_items: d.bookingItems,
        p_gyg_ref: d.gygBookingReference,
        p_details: {
          lead: { first_name: str(lead.firstName, 100), last_name: str(lead.lastName, 100), email: str(lead.email, 200), phone: str(lead.phoneNumber, 50) },
          currency: str(d.currency, 3),
          language: str(d.language, 10),
          hotel: str(d.travelerHotel),
          comment: str(d.comment, 2000),
        },
      })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: { bookingReference: r.booking_code, tickets: tickets(r.booking_code, d.bookingItems) } }
    },
  },
  {
    method: 'POST',
    pattern: /^\/1\/cancel-booking\/?$/,
    keys: [],
    run: async (req, _url, cfg) => {
      const d = await readData(req)
      if (!d || !nonEmpty(d.bookingReference) || !nonEmpty(d.gygBookingReference) || !nonEmpty(d.productId)) {
        return invalid('bookingReference, gygBookingReference and productId are required.')
      }
      const r = await cfg.rpc('gateway_gyg_cancel_booking', {
        p_connection: cfg.connectionId,
        p_booking_code: d.bookingReference,
        p_gyg_ref: d.gygBookingReference,
      })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: {} }
    },
  },
  {
    method: 'GET',
    pattern: /^\/1\/suppliers\/([^/]+)\/products\/?$/,
    keys: ['supplierId'],
    run: async (_req, _url, cfg, p) => {
      const r = await cfg.rpc('gateway_gyg_products', { p_connection: cfg.connectionId, p_supplier: p.supplierId })
      if (!r?.ok) return fromDbResult(r ?? {})
      return { data: { supplierId: p.supplierId, supplierName: r.supplier_name, products: r.products } }
    },
  },
]

export function createGateway(cfg: GatewayConfig): (req: Request) => Promise<Response> {
  return async (req) => {
    const started = Date.now()
    const url = new URL(req.url)
    let result: unknown
    let route = 'unknown'
    const key = req.headers.get('cf-connecting-ip') ?? 'unknown'
    if (cfg.allow && !(await cfg.allow(key).catch(() => true))) {
      // Bộ đếm lỗi thì cho qua: thà nhận thêm lệnh còn hơn chặn nhầm booking thật.
      cfg.log?.({ method: req.method, path: url.pathname, route, errorCode: 'RATE_LIMIT_EXCEEDED', ms: Date.now() - started })
      return new Response(JSON.stringify(gygError('RATE_LIMIT_EXCEEDED', 'Too many requests, please retry later.')), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      })
    }
    if (!(await authorized(req, cfg))) {
      result = gygError('AUTHORIZATION_FAILURE', 'The provided authentication credentials are not valid.')
    } else {
      const hit = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))
      if (!hit) {
        return new Response(JSON.stringify(gygError('VALIDATION_FAILURE', 'Unknown endpoint.')), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      route = hit.pattern.source
      const m = hit.pattern.exec(url.pathname)!
      const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]))
      try {
        result = await hit.run(req, url, cfg, params)
      } catch {
        // Lỗi database, mạng hoặc timeout: GetYourGuide sẽ tự gửi lại booking theo lịch retry.
        result = gygError('INTERNAL_SYSTEM_FAILURE', 'Temporary failure, please retry.')
      }
    }
    cfg.log?.({
      method: req.method,
      path: url.pathname,
      route,
      errorCode: (result as GygError | undefined)?.errorCode ?? null,
      ms: Date.now() - started,
    })
    return json(result)
  }
}
