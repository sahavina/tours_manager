import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, configured, type TourCard } from './api'
import { money, useI18n } from './i18n'

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

export function HomePage() {
  const { t, lang } = useI18n()
  const [data, setData] = useState<{ name: string; tours: TourCard[] } | null>(null)
  const [error, setError] = useState<string | null>(configured ? null : 'not_configured')

  useEffect(() => {
    if (!configured) return
    api.storefront()
      .then((d) => {
        setData(d)
        document.title = d.name
      })
      .catch((e: ApiError) => setError(e.code === 'not_found' ? 'empty' : e.code))
  }, [])

  return (
    <main>
      <section className="hero">
        <div className="wrap">
          <h1>{t.heroTitle}</h1>
          <p>{t.heroText}</p>
        </div>
      </section>
      <section className="wrap section">
        <h2>{t.ourTours}</h2>
        {error === 'empty' && <p className="notice">{t.noTours}</p>}
        {error && error !== 'empty' && <p className="notice notice-error">{error === 'not_configured' ? t.notConfigured : t.loadError}</p>}
        {!data && !error && <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" />)}</div>}
        {data && data.tours.length === 0 && <p className="notice">{t.noTours}</p>}
        {data && (
          <div className="grid">
            {data.tours.map((tour) => (
              <Link key={tour.code} to={`/tour/${encodeURIComponent(tour.code)}`} className="card">
                <Cover url={tour.image_url} title={tour.name} />
                <div className="card-body">
                  <div className="chips">
                    {tour.destination && <span className="chip">{tour.destination}</span>}
                    {tour.duration_minutes && <span className="chip">{t.hours(Math.round((tour.duration_minutes / 60) * 10) / 10)}</span>}
                    {tour.has_private && <span className="chip">{t.privateAvailable}</span>}
                    {tour.has_transfer && <span className="chip">{t.pickup}</span>}
                  </div>
                  <h3>{tour.name}</h3>
                  {tour.summary && <p className="muted clamp">{tour.summary}</p>}
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
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
