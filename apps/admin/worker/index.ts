// Worker của trang quản trị: phục vụ file tĩnh (SPA) và API tài khoản POST /api/accounts.
// Tạo tài khoản đăng nhập và link đặt mật khẩu cần khóa service (GoTrue admin), nên làm ở đây, không ở trình duyệt.
// Người gọi phải đăng nhập và có quyền member.manage trong doanh nghiệp (kiểm tra bằng chính phiên của họ).
//
//   { org, email, mode: 'ensure' }  có tài khoản rồi thì thôi; chưa có thì tạo và trả link đặt mật khẩu.
//   { org, email, mode: 'reset' }   thành viên của doanh nghiệp: trả link đặt lại mật khẩu.
// Link dùng một lần, chuyển về trang quản trị để người đó tự đặt mật khẩu; không ai khác biết mật khẩu.
//
// vars: SUPABASE_URL, SITE_URL. secrets: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  SUPABASE_URL: string
  SITE_URL: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  SUPABASE_ANON_KEY?: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// GoTrue tự cài sau proxy /auth/v1 tạo link dạng <api>/verify?...; đường dẫn đúng qua Caddy là <api>/auth/v1/verify.
export function fixVerifyLink(link: string, supabaseUrl: string): string {
  try {
    const u = new URL(link)
    if (u.pathname === '/verify') {
      const base = new URL(supabaseUrl)
      u.protocol = base.protocol
      u.host = base.host
      u.pathname = '/auth/v1/verify'
    }
    return u.toString()
  } catch {
    return link
  }
}

async function accounts(req: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) return json({ ok: false, code: 'server' }, 500)
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!token) return json({ ok: false, code: 'unauthorized' }, 401)
  let b: { org?: unknown; email?: unknown; mode?: unknown }
  try {
    b = await req.json()
  } catch {
    return json({ ok: false, code: 'invalid_input' }, 400)
  }
  const org = typeof b.org === 'string' ? b.org : ''
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const mode = b.mode === 'reset' ? 'reset' : 'ensure'
  if (!org || !EMAIL.test(email) || email.length > 200) return json({ ok: false, code: 'invalid_email' }, 400)

  const asUser = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const asService = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' }

  // Quyền: hỏi database bằng phiên của người gọi (phiên hết hạn hay giả thì bị từ chối ở đây).
  const perm = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/has_org_permission`, {
    method: 'POST', headers: asUser, body: JSON.stringify({ p_org: org, p_permission: 'member.manage' }),
  })
  if (!perm.ok || (await perm.json()) !== true) return json({ ok: false, code: 'forbidden' }, 403)

  let created = false
  if (mode === 'reset') {
    const list = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_list`, { method: 'POST', headers: asUser, body: JSON.stringify({ p_org: org }) })
    const members = list.ok ? ((await list.json()) as { email?: string }[]) : []
    if (!members.some((m) => (m.email ?? '').toLowerCase() === email)) return json({ ok: false, code: 'not_member' }, 404)
  } else {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST', headers: asService, body: JSON.stringify({ email, email_confirm: true }),
    })
    if (r.ok) created = true
    else if (r.status !== 422) {
      console.error('create user failed', r.status, (await r.text()).slice(0, 200))
      return json({ ok: false, code: 'server' }, 502)
    }
    // 422: đã có tài khoản với email này, dùng luôn (không đổi mật khẩu của họ).
    if (!created) return json({ ok: true, created: false })
  }

  const link = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: asService, body: JSON.stringify({ type: 'recovery', email, redirect_to: env.SITE_URL }),
  })
  if (!link.ok) {
    console.error('generate_link failed', link.status, (await link.text()).slice(0, 200))
    return json({ ok: false, code: 'server', created }, 502)
  }
  const data = (await link.json()) as { action_link?: string; properties?: { action_link?: string } }
  const action = data.action_link ?? data.properties?.action_link
  if (!action) return json({ ok: false, code: 'server', created }, 502)
  return json({ ok: true, created, link: fixVerifyLink(action, env.SUPABASE_URL) })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/accounts') {
      if (req.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405)
      return accounts(req, env)
    }
    return env.ASSETS.fetch(req)
  },
}
