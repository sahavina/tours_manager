import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ReviewBadge, TourCard, WhyItem } from './api'
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
              {r.award && (
                <div className="rc-award">
                  <span className="rc-laurel" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 21c-4-1.5-7-5-7-10M12 21c4-1.5 7-5 7-10M5 11c0-1.5.5-3 1.5-4M19 11c0-1.5-.5-3-1.5-4M7.5 15.5 5 16M16.5 15.5 19 16M6.2 12.5 4 12.5M17.8 12.5 20 12.5" />
                      <circle cx="12" cy="9" r="3" />
                    </svg>
                  </span>
                  <span><small>{t.awardTitle}</small><b>{r.award}</b></span>
                </div>
              )}
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

// Nhóm thời lượng để lọc: tối đa 4 giờ, cả ngày, nhiều ngày (theo nhãn "2 days" hoặc số phút).
export function durationGroup(tour: Pick<TourCard, 'duration_label' | 'duration_minutes'>): 'short' | 'day' | 'multi' | null {
  const label = (tour.duration_label ?? '').toLowerCase()
  if (/\b[2-9]\s*days?\b/.test(label)) return 'multi'
  if (tour.duration_minutes != null) return tour.duration_minutes <= 300 ? 'short' : 'day'
  if (/full day|day trip/.test(label)) return 'day'
  if (/hour/.test(label)) return 'short'
  return null
}
