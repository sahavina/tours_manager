// Worker của trang đặt tour: phục vụ file tĩnh (SPA) và một API duy nhất POST /api/booking-request.
// API kiểm tra Cloudflare Turnstile (siteverify) rồi mới gọi hàm public_booking_request bằng khóa service,
// để khi doanh nghiệp bật require_verified_booking thì chỉ yêu cầu đã qua Turnstile mới tạo được booking.
//
// Biến môi trường (vars): SUPABASE_URL, SUPABASE_ANON_KEY, TURNSTILE_HOSTNAMES (tên miền trang khách, cách nhau dấu phẩy).
// Turnstile qua: gọi bằng khóa service. Không qua: gọi bằng khóa công khai, nên khi doanh nghiệp chưa bật
// require_verified_booking khách vẫn đặt được (chỉ ghi log lý do), bật rồi thì database trả verification_required.
// Bí mật (secrets): TURNSTILE_SECRET, SUPABASE_SERVICE_ROLE_KEY.

import { robots, seoPage, sitemap } from './seo'

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  SUPABASE_URL: string
  TURNSTILE_HOSTNAMES: string
  TURNSTILE_SECRET?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  // Khóa công khai (cũng có trong trang khách): dùng khi Turnstile không qua, để database tự quyết theo require_verified_booking.
  SUPABASE_ANON_KEY?: string
  STOREFRONT_ORG?: string
}

const ACTION = 'booking'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

type Body = {
  token?: unknown
  slug?: unknown; option?: unknown; date?: unknown; time?: unknown; pax?: unknown
  contact?: unknown; hotel?: unknown; note?: unknown
}

async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<boolean> {
  const hostnames = new Set(env.TURNSTILE_HOSTNAMES.split(',').map((h) => h.trim()).filter(Boolean))
  if (!env.TURNSTILE_SECRET || hostnames.size === 0 || token.length === 0 || token.length > 2048) {
    console.warn('turnstile skipped', JSON.stringify({ secret: Boolean(env.TURNSTILE_SECRET), tokenLength: token.length }))
    return false
  }
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token })
    if (ip) form.set('remoteip', ip)
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: form, signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return false
    const v = (await r.json()) as { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[]; metadata?: { result_with_testing_key?: boolean } }
    // Ghi mã lỗi của siteverify (không có secret/token) để chẩn đoán, ví dụ invalid-input-secret là secret đặt sai.
    // Khóa thử của Cloudflare (chỉ dùng ở dev) không trả action; secret thật luôn phải khớp action.
    const actionOk = v.action === ACTION || v.metadata?.result_with_testing_key === true
    const ok = v.success === true && actionOk && typeof v.hostname === 'string' && hostnames.has(v.hostname)
    // Ghi lý do bị từ chối (không có secret/token) để chẩn đoán trong log Worker.
    if (!ok) console.warn('turnstile rejected', JSON.stringify({ success: v.success, codes: v['error-codes'] ?? [], action: v.action ?? null, hostname: v.hostname ?? null }))
    return ok
  } catch (e) {
    console.warn('turnstile error', String(e))
    return false // lỗi mạng hoặc phản hồi lạ: coi như không qua
  }
}

async function bookingRequest(req: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, code: 'server' }, 500)
  let b: Body
  try {
    b = (await req.json()) as Body
  } catch {
    return json({ ok: false, code: 'invalid_input' }, 400)
  }
  const verified = typeof b.token === 'string' && (await verifyTurnstile(env, b.token, req.headers.get('CF-Connecting-IP')))
  const key = verified ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY
  if (!key) return json({ ok: false, code: 'verification_failed' }, 403)
  const str = (x: unknown) => (typeof x === 'string' ? x : null)
  // Kiểm tra nội dung chi tiết nằm trong hàm database; ở đây chỉ chuyển tiếp đúng tham số.
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/public_booking_request`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      p_slug: str(b.slug), p_option_code: str(b.option), p_date: str(b.date), p_time: str(b.time),
      p_pax: b.pax ?? null, p_contact: b.contact ?? null, p_hotel: str(b.hotel), p_note: str(b.note),
    }),
  })
  if (!r.ok) {
    // Ghi mã lỗi và đoạn đầu phản hồi của database (không chứa khóa) để xem trong log Worker.
    console.error('public_booking_request failed', r.status, (await r.text()).slice(0, 300))
    return json({ ok: false, code: 'server' }, 502)
  }
  const out = (await r.json()) as { ok?: boolean; code?: string }
  // Database chặn vì chưa xác minh: báo cho khách làm lại bước kiểm tra.
  if (out.ok === false && out.code === 'verification_required') return json({ ok: false, code: 'verification_failed' }, 403)
  return json(out)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/booking-request') {
      if (req.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405)
      return bookingRequest(req, env)
    }
    if (req.method === 'GET') {
      if (url.pathname === '/robots.txt') return robots(url, env)
      if (url.pathname === '/sitemap.xml') return sitemap(url, env)
      // Trang HTML có thẻ SEO riêng (các đường dẫn khác vẫn là file tĩnh hoặc SPA như cũ).
      if (url.pathname === '/' || url.pathname === '/tours' || url.pathname === '/tours/' || /^\/tour\/[^/]+\/?$/.test(url.pathname)) {
        try {
          return await seoPage(req, env)
        } catch (e) {
          console.error('seo page failed', String(e))
          return env.ASSETS.fetch(req)
        }
      }
    }
    return env.ASSETS.fetch(req)
  },
}
