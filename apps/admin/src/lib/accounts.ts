// Gọi API tài khoản của Worker trang quản trị (tạo tài khoản, link đặt mật khẩu). Gửi kèm phiên đăng nhập
// để Worker kiểm tra quyền member.manage bằng chính phiên của người gọi.
import { supabase } from './supabase'

export type AccountResult = { created: boolean; link?: string }

const MESSAGES: Record<string, string> = {
  forbidden: 'Bạn không có quyền quản lý tài khoản.',
  unauthorized: 'Phiên đăng nhập đã hết, hãy đăng nhập lại.',
  invalid_email: 'Email chưa đúng.',
  not_member: 'Email này chưa là thành viên của doanh nghiệp.',
  server: 'Máy chủ tài khoản đang lỗi, thử lại sau.',
}

export async function accountsApi(org: string, email: string, mode: 'ensure' | 'reset'): Promise<AccountResult> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error(MESSAGES.unauthorized)
  let res: Response
  try {
    res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ org, email, mode }),
    })
  } catch {
    throw new Error('Lỗi kết nối, thử lại.')
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; created?: boolean; link?: string } | null
  if (!body) throw new Error(res.status === 404 ? 'Bản chạy thử ở máy chưa có API tài khoản (chỉ có trên bản đã deploy).' : MESSAGES.server)
  if (!body.ok) throw new Error(MESSAGES[body.code ?? 'server'] ?? MESSAGES.server)
  return { created: Boolean(body.created), link: body.link }
}
