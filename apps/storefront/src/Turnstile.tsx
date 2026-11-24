// Ô kiểm tra Cloudflare Turnstile (render tường minh) cho form đặt tour.
// Token chỉ dùng được một lần: sau mỗi lần gửi, form gọi reset() để lấy token mới trước khi cho gửi lại.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<void> | null = null
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { loading = null; reject(new Error('turnstile')) }
    document.head.appendChild(s)
  })
  return loading
}

export type TurnstileHandle = { reset: () => void }

// onUnavailable: Turnstile không tải được, báo lỗi, hoặc quá 8 giây chưa có token. Form khi đó vẫn cho gửi
// (Worker chuyển yêu cầu bằng khóa công khai; database chặn nếu doanh nghiệp đã bật bắt buộc xác minh).
export const Turnstile = forwardRef<TurnstileHandle, { sitekey: string; action: string; lang: string; onToken: (t: string | null) => void; onUnavailable?: () => void }>(
  function Turnstile({ sitekey, action, lang, onToken, onUnavailable }, ref) {
    const box = useRef<HTMLDivElement>(null)
    const id = useRef<string | null>(null)
    const cb = useRef(onToken)
    cb.current = onToken
    const fail = useRef(onUnavailable)
    fail.current = onUnavailable

    useImperativeHandle(ref, () => ({
      reset: () => {
        cb.current(null)
        if (id.current && window.turnstile) window.turnstile.reset(id.current)
      },
    }), [])

    useEffect(() => {
      let cancelled = false
      let got = false
      const timer = window.setTimeout(() => { if (!got) fail.current?.() }, 8000)
      loadScript().then(() => {
        if (cancelled || !box.current || !window.turnstile) return
        id.current = window.turnstile.render(box.current, {
          sitekey, action, language: lang === 'vi' ? 'vi' : 'en', appearance: 'interaction-only',
          callback: (t: string) => { got = true; cb.current(t) },
          'expired-callback': () => cb.current(null),
          'error-callback': () => { cb.current(null); fail.current?.() },
        })
      }).catch(() => { cb.current(null); fail.current?.() })
      return () => {
        cancelled = true
        window.clearTimeout(timer)
        if (id.current && window.turnstile) window.turnstile.remove(id.current)
        id.current = null
      }
    }, [sitekey, action, lang])

    return <div ref={box} className="turnstile" />
  },
)
