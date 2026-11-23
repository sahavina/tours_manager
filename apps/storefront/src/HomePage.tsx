import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, configured, type Storefront } from './api'
import { useI18n } from './i18n'
import { Cover, TourCardView, WhyBlock } from './ui'

export { Cover } from './ui'

const todayIso = () => new Date().toISOString().slice(0, 10)

export function HomePage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { hash } = useLocation()
  const [data, setData] = useState<Storefront | null>(null)
  const [error, setError] = useState<string | null>(configured ? null : 'not_configured')
  const [dest, setDest] = useState('')
  const [date, setDate] = useState('')
  const [guests, setGuests] = useState(2)

  useEffect(() => {
    if (!configured) return
    api.storefront()
      .then((d) => {
        setData(d)
        document.title = d.name
      })
      .catch((e: ApiError) => setError(e.code === 'not_found' ? 'empty' : e.code))
  }, [])

  // Link "#destinations", "#faq" từ menu: cuộn tới khi trang đã có dữ liệu.
  useEffect(() => {
    if (hash && data) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' })
  }, [hash, data])

  const destinations = useMemo(() => {
    const m = new Map<string, { count: number; image: string | null }>()
    for (const x of data?.tours ?? []) {
      if (!x.destination) continue
      const cur = m.get(x.destination) ?? { count: 0, image: null }
      m.set(x.destination, { count: cur.count + 1, image: cur.image ?? x.image_url })
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [data])

  const hero = data?.tours.find((x) => x.image_url)?.image_url ?? null
  const featured = (data?.tours ?? []).filter((x) => x.image_url).slice(0, 6)
  const maxGroup = Math.max(0, ...(data?.tours ?? []).map((x) => x.group_max ?? 0))
  const settings = data?.settings ?? {}
  const cancelHours = settings.cancel_free_hours

  const search = (e: FormEvent) => {
    e.preventDefault()
    const q = new URLSearchParams()
    if (dest) q.set('dest', dest)
    if (date) q.set('date', date)
    if (guests !== 2) q.set('guests', String(guests))
    navigate(`/tours${q.size ? `?${q}` : ''}`)
  }

  return (
    <main>
      <section className="hero" style={hero ? { backgroundImage: `linear-gradient(180deg, rgba(16,32,22,.55), rgba(16,32,22,.75)), url("${hero}")` } : undefined}>
        <div className="wrap">
          <h1>{t.heroTitle}</h1>
          <p>{t.heroText}</p>
          {data && data.tours.length > 0 && (
            <form className="search" onSubmit={search}>
              <label>
                <span>{t.searchDestination}</span>
                <select value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="">{t.anyDestination}</option>
                  {destinations.map(([d]) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label>
                <span>{t.searchDate}</span>
                <input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label>
                <span>{t.searchGuests(guests)}</span>
                <input type="number" min={1} max={20} value={guests} onChange={(e) => setGuests(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
              </label>
              <button className="btn">{t.findTours}</button>
            </form>
          )}
        </div>
      </section>

      {error === 'empty' && <section className="wrap section"><p className="notice">{t.noTours}</p></section>}
      {error && error !== 'empty' && <section className="wrap section"><p className="notice notice-error">{error === 'not_configured' ? t.notConfigured : t.loadError}</p></section>}
      {!data && !error && <section className="wrap section"><div className="grid">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" />)}</div></section>}

      {data && (
        <WhyBlock brand={data.name} items={settings.why?.length ? settings.why : [
          ...(cancelHours != null ? [{ icon: 'calendar', title: t.whyCancelTitle, text: t.whyCancel(cancelHours) }] : []),
          { icon: 'shield', title: t.whyNoPayTitle, text: t.whyNoPay },
          ...(maxGroup > 0 ? [{ icon: 'group', title: t.whySmallTitle, text: t.whySmall(maxGroup) }] : []),
          ...(settings.contact?.whatsapp ? [{ icon: 'chat', title: t.whyChatTitle, text: t.whyChat }] : []),
        ]} />
      )}

      {data && destinations.length > 0 && (
        <section className="wrap section" id="destinations">
          <h2>{t.destinations}</h2>
          <div className="dest-grid">
            {destinations.map(([d, v]) => (
              <Link key={d} to={`/tours?dest=${encodeURIComponent(d)}`} className="dest">
                <Cover url={v.image} title={d} className="dest-img" />
                <span className="dest-name">{d}</span>
                <span className="dest-count">{t.toursCount(v.count)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {data && featured.length > 0 && (
        <section className="wrap section">
          <div className="section-head">
            <h2>{t.ourTours}</h2>
            <Link to="/tours" className="cta">{t.viewAll(data.tours.length)} →</Link>
          </div>
          <div className="grid">{featured.map((tour) => <TourCardView key={tour.code} tour={tour} />)}</div>
        </section>
      )}

      {data && (
        <section className="wrap section" id="faq">
          <h2>{t.faqTitle}</h2>
          <div className="faq">
            {t.faq
              .filter(([, a]) => cancelHours != null || !a.includes('{h}'))
              .map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p>{a.replace('{h}', String(cancelHours))}</p>
                </details>
              ))}
          </div>
        </section>
      )}
    </main>
  )
}
