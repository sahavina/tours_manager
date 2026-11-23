import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { ReviewBadge, ReviewWidget, TourCard, WhyItem } from './api'
import { displayName, durationText, localized, money, useI18n } from './i18n'

// Biểu tượng nét mảnh cho khối "Vì sao chọn": vẽ tay bằng SVG, không tải thư viện ngoài.
const ICONS: Record<string, ReactNode> = {
  local: <><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></>,
  jeep: <><path d="M3 15V11l2-4h9l2 4h3a2 2 0 0 1 2 2v2" /><circle cx="7" cy="16" r="2" /><circle cx="17" cy="16" r="2" /><path d="M9 16h6M5 11h14" /></>,
  group: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.2A5 5 0 0 1 21 19" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="m9 15 2 2 4-4" /></>,
  chat: <><path d="M4 18.5 5.3 15A8 8 0 1 1 9 18.7Z" /><path d="M9 10h6M9 13h4" /></>,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  heart: <path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z" />,
  food: <><path d="M4 11h16a8 8 0 0 1-16 0Z" /><path d="M8 7c0-1 1-1.5 1-2.5M12 7c0-1 1-1.5 1-2.5M16 7c0-1 1-1.5 1-2.5" /></>,
}

export function WhyBlock({ brand, items }: { brand: string; items: WhyItem[] }) {
  const { t, lang } = useI18n()
  if (!items.length) return null
  return (
    <section className="wrap section why2">
      <h2 className="why2-title">{t.whyChoose} <span>{brand}</span></h2>
      <div className="why2-grid">
        {items.map((it, i) => (
          <div key={i} className="why2-item">
            <span className={`why2-icon tone-${i % 4}`} aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[it.icon] ?? ICONS.heart}
              </svg>
            </span>
            <div>
              <h3>{localized(lang, it.title, it.vi?.title)}</h3>
              <p>{localized(lang, it.text, it.vi?.text)}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export const waLink = (phone: string) => `https://wa.me/${phone.replace(/[^\d]/g, '')}`

export function Cover({ url, title, className = 'cover' }: { url: string | null; title: string; className?: string }) {
  // Chưa có ảnh thì dùng nền màu kèm chữ cái đầu, không dùng ảnh minh họa giả.
  if (url) return <div className={className} style={{ backgroundImage: `url("${url}")` }} role="img" aria-label={title} />
  const hue = [...title].reduce((a, c) => a + c.charCodeAt(0), 0) % 60
  return (
    <div className={`${className} cover-empty`} style={{ ['--h' as string]: String(140 + hue) }} aria-hidden>
      <span>{title.trim().charAt(0)}</span>
    </div>
  )
}

export function TourCardView({ tour, date }: { tour: TourCard; date?: string }) {
  const { t, lang } = useI18n()
  const name = displayName(localized(lang, tour.name, tour.vi?.name))
  const summary = localized(lang, tour.summary, tour.vi?.summary)
  const dur = durationText(t, localized(lang, tour.duration_label, tour.vi?.duration_label), tour.duration_minutes)
  return (
    <Link to={`/tour/${encodeURIComponent(tour.code)}${date ? `?date=${date}` : ''}`} className="card">
      <Cover url={tour.image_url} title={name} />
      <div className="card-body">
        <div className="chips">
          {tour.destination && <span className="chip">{tour.destination}</span>}
          {dur && <span className="chip">{dur}</span>}
          {tour.has_private && <span className="chip">{t.privateAvailable}</span>}
          {tour.has_transfer && <span className="chip">{t.pickup}</span>}
        </div>
        <h3>{name}</h3>
        {summary && <p className="muted clamp">{summary}</p>}
        <div className="card-foot">
          <span className="price">
            {tour.price_from != null && tour.currency
              ? <><small>{t.from}</small> {money(tour.price_from, tour.currency, lang)} <small>{t.perPerson}</small></>
              : <small>{t.priceOnRequest}</small>}
          </span>
          <span className="cta">{t.view} →</span>
        </div>
      </div>
    </Link>
  )
}

function AwardRow({ award }: { award: string }) {
  const { t } = useI18n()
  return (
    <div className="rc-award">
      <span className="rc-laurel" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 21c-4-1.5-7-5-7-10M12 21c4-1.5 7-5 7-10M5 11c0-1.5.5-3 1.5-4M19 11c0-1.5-.5-3-1.5-4M7.5 15.5 5 16M16.5 15.5 19 16M6.2 12.5 4 12.5M17.8 12.5 20 12.5" />
          <circle cx="12" cy="9" r="3" />
        </svg>
      </span>
      <span><small>{t.awardTitle}</small><b>{award}</b></span>
    </div>
  )
}

// Khối điểm đánh giá trên trang ngoài, đặt ở chân trang. Bong bóng tô theo điểm (làm tròn 0,5).
export function ReviewBadges({ items }: { items: ReviewBadge[] }) {
  const { t, lang } = useI18n()
  if (!items.length) return null
  return (
    <div className="reviews">
      {items.map((r) => {
        const rating = Math.max(0, Math.min(5, r.rating ?? 0))
        const halves = Math.round(rating * 2)
        const label = r.provider === 'tripadvisor' ? 'Tripadvisor' : r.provider
        return (
          <div key={r.url} className="review-card">
            {r.image && (
              <a href={r.url} target="_blank" rel="noreferrer" className="rc-photo" style={{ backgroundImage: `url("${r.image}")` }} aria-label={r.name ?? label} />
            )}
            <div className="rc-body">
              <div className="rc-provider">{label}</div>
              {r.name && <a className="rc-name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>}
              {rating > 0 && (
                <div className="rc-score" aria-label={`${rating} / 5`}>
                  <span className="rb-bubbles" aria-hidden>
                    {[0, 1, 2, 3, 4].map((i) => <i key={i} className={halves >= (i + 1) * 2 ? 'full' : halves === i * 2 + 1 ? 'half' : ''} />)}
                  </span>
                  {r.count != null && (
                    <a className="rc-count" href={r.url} target="_blank" rel="noreferrer">{t.reviewCount(r.count.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US'))}</a>
                  )}
                </div>
              )}
              {r.ranking && <div className="rc-ranking">{r.ranking}</div>}
              {!!r.categories?.length && <div className="rc-cats">{r.categories.join(' • ')}</div>}
              {r.location && <div className="rc-location">📍 {r.location}</div>}
              {r.award && <AwardRow award={r.award} />}
              <div className="rc-links">
                <a href={r.url} target="_blank" rel="noreferrer">{t.readReviews(label)} →</a>
                {r.write_url && <a href={r.write_url} target="_blank" rel="noreferrer">{t.writeReview}</a>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Widget TripAdvisor: dựng khung giống mã nhúng của TripAdvisor rồi nạp script jscache.com một lần.
// React không chạy thẻ <script> trong JSX nên phải thêm script bằng DOM.
function TripadvisorWidget({ w, photo, count, links }: { w: ReviewWidget; photo?: { image: string; url: string; name?: string }; count?: { text: string; url: string; halves: number; location?: string; ranking?: string; categories?: string[]; award?: string }; links?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  // Chỗ chèn số đánh giá ngay dưới tên trong widget (nội dung do script TripAdvisor vẽ, nên chèn bằng portal sau khi vẽ xong).
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const id = `TA_${w.type}${w.uniq}`
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!el.dataset.loaded) {
      el.dataset.loaded = '1'
      el.dataset.fallback = el.innerHTML
      const s = document.createElement('script')
      s.async = true
      s.src = `https://www.jscache.com/wejs?wtype=${encodeURIComponent(w.type)}&uniq=${encodeURIComponent(w.uniq)}&locationId=${encodeURIComponent(w.location_id)}&lang=${encodeURIComponent(w.lang ?? 'en_US')}&display_version=2`
      s.setAttribute('data-loadtrk', '')
      s.onload = () => { (s as HTMLScriptElement & { loadtrk?: boolean }).loadtrk = true }
      el.after(s)
    }
    // Script TripAdvisor chỉ vẽ widget trong window.onload; trang một-trang đã qua onload nên tự gọi taValidate
    // khi script của họ đã đăng ký xong, đến khi khung có nội dung thật (tối đa khoảng 15 giây).
    const fallback = el.dataset.fallback ?? el.innerHTML
    let tries = 0
    const timer = window.setInterval(() => {
      const ta = window as Window & { taValidate?: () => void; taValIndex?: number }
      tries++
      if (el.innerHTML !== fallback || tries > 30) {
        window.clearInterval(timer)
        const link = el.querySelector('.widWRLLink')
        if (link) {
          let s = el.querySelector<HTMLElement>('.ta-count-slot')
          if (!s) {
            s = document.createElement('div')
            s.className = 'ta-count-slot'
            link.after(s)
          }
          setSlot(s)
        }
        return
      }
      if (typeof ta.taValidate === 'function' && (ta.taValIndex ?? 0) > 0) {
        try {
          ta.taValidate()
        } catch {
          /* widget của bên ngoài, lỗi thì giữ link dự phòng */
        }
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [w.type, w.uniq, w.location_id, w.lang])
  return (
    <div className={`ta-card${photo ? ' has-photo' : ''}`}>
      {photo && <a href={photo.url} target="_blank" rel="noreferrer" className="rc-photo" style={{ backgroundImage: `url("${photo.image}")` }} aria-label={photo.name ?? 'Tripadvisor'} />}
      <div id={id} className={`TA_${w.type} ta-widget`} ref={box}>
        <ul className="TA_links">
          <li><a target="_blank" rel="noreferrer" href="https://www.tripadvisor.com/">Tripadvisor</a></li>
        </ul>
      </div>
      {links}
      {slot && count && createPortal(<>
        <div className="rc-score" aria-label={count.halves ? `${count.halves / 2} / 5` : undefined}>
          {count.halves > 0 && (
            <span className="rb-bubbles" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => <i key={i} className={count.halves >= (i + 1) * 2 ? 'full' : count.halves === i * 2 + 1 ? 'half' : ''} />)}
            </span>
          )}
          <a className="rc-count" href={count.url} target="_blank" rel="noreferrer">{count.text}</a>
        </div>
        {count.ranking && <div className="rc-ranking">{count.ranking}</div>}
        {!!count.categories?.length && <div className="rc-cats">{count.categories.join(' • ')}</div>}
        {count.location && <div className="rc-location">📍 {count.location}</div>}
        {count.award && <AwardRow award={count.award} />}
      </>, slot)}
    </div>
  )
}

// Ảnh đầu khung widget: ảnh riêng của widget, nếu không có thì lấy ảnh của thẻ đánh giá cùng địa điểm TripAdvisor (d<locationId>).
export function ReviewWidgets({ items, badges = [] }: { items: ReviewWidget[]; badges?: ReviewBadge[] }) {
  const { t, lang } = useI18n()
  if (!items.length) return null
  return (
    <div className="review-widgets">
      {items.filter((w) => w.provider === 'tripadvisor').map((w) => {
        const card = badges.find((b) => b.url.includes(`-d${w.location_id}-`))
        // Trường của widget ưu tiên, trống thì lấy từ thẻ đánh giá cùng địa điểm (cả hai nhập trong admin).
        const pick = <K extends keyof ReviewBadge>(k: K) => (w[k as keyof ReviewWidget] ?? card?.[k]) as ReviewBadge[K] | undefined
        const url = pick('url') ?? `https://www.tripadvisor.com/${w.location_id}`
        const writeUrl = pick('write_url')
        const image = pick('image')
        const photo = image ? { image, url, name: pick('name') } : undefined
        const n = pick('count')
        const count = n != null
          ? { text: t.reviewCount(n.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US')), url, location: pick('location'), ranking: pick('ranking'), categories: pick('categories'), award: pick('award'), halves: Math.round(Math.max(0, Math.min(5, pick('rating') ?? 0)) * 2) }
          : undefined
        // Hai link "Xem đánh giá" và "Viết đánh giá" giống thẻ đánh giá, đặt dưới cùng khung widget.
        const links = (pick('url') || writeUrl) && (
          <div className="rc-links ta-links">
            {pick('url') && <a href={url} target="_blank" rel="noreferrer">{t.readReviews('Tripadvisor')} →</a>}
            {writeUrl && <a href={writeUrl} target="_blank" rel="noreferrer">{t.writeReview}</a>}
          </div>
        )
        return <TripadvisorWidget key={`${w.type}${w.uniq}`} w={w} photo={photo} count={count} links={links} />
      })}
    </div>
  )
}

// Nhóm thời lượng để lọc: tối đa 4 giờ, cả ngày, nhiều ngày (theo nhãn "2 days" hoặc số phút).
export function durationGroup(tour: Pick<TourCard, 'duration_label' | 'duration_minutes'>): 'short' | 'day' | 'multi' | null {
  const label = (tour.duration_label ?? '').toLowerCase()
  if (/\b[2-9]\s*days?\b/.test(label)) return 'multi'
  if (tour.duration_minutes != null) return tour.duration_minutes <= 300 ? 'short' : 'day'
  if (/full day|day trip/.test(label)) return 'day'
  if (/hour/.test(label)) return 'short'
  return null
}
