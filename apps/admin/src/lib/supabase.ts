import { createClient } from '@supabase/supabase-js'
import { resultMessage } from '@tours/core'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anonKey)

// Chỉ khóa anon ở trình duyệt. Mọi quyền nằm ở RLS và RPC phía database.
export const supabase = createClient(url ?? 'http://localhost:55421', anonKey ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true },
})

/** Hàng dữ liệu từ PostgREST. Kiểu được giữ lỏng ở ranh giới này: lược đồ nằm ở migrations. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

/** Không đưa thông báo của Postgres ra giao diện: tra bảng mã, mã lạ rơi về câu chung. */
export function friendlyError(error: { code?: string; message?: string; hint?: string } | null | undefined): string {
  if (!error) return resultMessage(null)
  if (error.code === '42501' || error.message === 'forbidden') return resultMessage('forbidden')
  if (error.code === '23505') return 'Dữ liệu này đã tồn tại (trùng mã).'
  if (error.code === '23503') return 'Dữ liệu liên quan không hợp lệ.'
  if (error.code === 'PGRST116') return 'Không tìm thấy dữ liệu.'
  if (typeof error.message === 'string' && /fetch/i.test(error.message)) return 'Không kết nối được máy chủ dữ liệu.'
  return resultMessage(error.message)
}

export class AppError extends Error {}

export async function rpc<T = Row>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new AppError(friendlyError(error))
  return data as T
}

/** RPC trả {ok, code}: ok=false là kết quả nghiệp vụ bình thường, chuyển thành lỗi có câu tiếng Việt. */
export async function rpcOk<T extends Row = Row>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await rpc<T>(fn, args)
  if (res && res.ok === false) throw new AppError(resultMessage(res.code as string))
  return res
}

/** Danh sách qua PostgREST, luôn ném lỗi đã dịch thay vì trả rỗng. */
export function unwrap<T>(res: { data: T | null; error: { code?: string; message?: string } | null }): T {
  if (res.error) throw new AppError(friendlyError(res.error))
  return res.data as T
}

export const CONNECTION_COLUMNS =
  'id, organization_id, channel, account_name, supplier_account_ref, mode, status, approval_status, capabilities, hold_ttl_seconds, has_credentials, last_success_at, last_simulated_at, last_error, last_error_at, stale_after_minutes, catalog_sync_enabled, catalog_sync_interval_minutes, catalog_last_attempt_at, catalog_last_synced_at, catalog_last_error, mock_catalog_version'
