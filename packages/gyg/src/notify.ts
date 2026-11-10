// Chiều ngược lại, BẮT BUỘC theo GetYourGuide: báo số chỗ mới mỗi khi chỗ thay đổi.
// POST {base}/1/notify-availability-update, HTTP Basic bằng thông tin GetYourGuide cấp.
import { toGygDateTime, type DbAvailability } from './protocol.ts'

export type NotifyTarget = { connection_id: string; product_id: string; items: DbAvailability[] }
export type NotifyConfig = { baseUrl: string; username: string; password: string; timeoutMs?: number }
export type NotifyResult = { ok: boolean; status: number; errorCode?: string }

export function notifyBody(t: NotifyTarget) {
  return {
    data: {
      productId: t.product_id,
      availabilities: t.items.map((i) => ({ dateTime: toGygDateTime(i.local_date, i.local_time, i.starts_at), vacancies: Math.max(0, i.vacancies) })),
    },
  }
}

export async function sendAvailabilityUpdate(cfg: NotifyConfig, t: NotifyTarget, fetchFn: typeof fetch = fetch): Promise<NotifyResult> {
  const res = await fetchFn(`${cfg.baseUrl.replace(/\/+$/, '')}/1/notify-availability-update`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
    },
    body: JSON.stringify(notifyBody(t)),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
  })
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
  let errorCode: string | undefined
  try {
    errorCode = ((await res.json()) as { errorCode?: string }).errorCode
  } catch {
    errorCode = undefined
  }
  return { ok: false, status: res.status, errorCode }
}
