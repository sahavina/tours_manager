// Cloudflare Worker: cổng công khai cho GetYourGuide. Bí mật đặt bằng `wrangler secret put`, không có trong Git.
//   SUPABASE_URL                 https://<ref>.supabase.co (biến thường)
//   GYG_CONNECTION_ID            id dòng channel_connections của kết nối GetYourGuide (biến thường)
//   SUPABASE_SERVICE_ROLE_KEY    bí mật
//   GYG_INBOUND_USERNAME         bí mật: tên đăng nhập mình cấp cho GetYourGuide gọi vào
//   GYG_INBOUND_PASSWORD         bí mật
import { createGateway, type Rpc } from '@tours/gyg'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GYG_CONNECTION_ID: string
  GYG_INBOUND_USERNAME: string
  GYG_INBOUND_PASSWORD: string
  /** Binding ratelimits trong wrangler.jsonc; thiếu thì không giới hạn. */
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
}

// GetYourGuide ngắt sau 10 giây với reserve/book; dừng sớm hơn để còn trả INTERNAL_SYSTEM_FAILURE.
const RPC_TIMEOUT_MS = 8_000

export function postgrestRpc(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>, fetchFn: typeof fetch = fetch): Rpc {
  return async (fn, args) => {
    const res = await fetchFn(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`rpc ${fn}: HTTP ${res.status}`)
    return res.json()
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // Màn Kết nối API gọi từ trình duyệt để kiểm tra cổng còn chạy. Chỉ trả "ok", không có dữ liệu.
    if (url.pathname === '/health') return new Response('ok', { headers: { 'access-control-allow-origin': '*' } })
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.GYG_CONNECTION_ID) {
      return new Response(JSON.stringify({ errorCode: 'INTERNAL_SYSTEM_FAILURE', errorMessage: 'Gateway is not configured.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const gateway = createGateway({
      connectionId: env.GYG_CONNECTION_ID,
      username: env.GYG_INBOUND_USERNAME,
      password: env.GYG_INBOUND_PASSWORD,
      rpc: postgrestRpc(env),
      log: (e) => console.log(JSON.stringify(e)),
      allow: env.RATE_LIMITER ? async (key) => (await env.RATE_LIMITER!.limit({ key })).success : undefined,
    })
    return gateway(req)
  },
}
