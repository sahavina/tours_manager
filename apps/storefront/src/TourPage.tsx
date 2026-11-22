import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, type BookingResult, type Slot, type TourDetail } from './api'
import { Cover } from './HomePage'
import { money, useI18n } from './i18n'

const WINDOW = 14
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export function TourPage() {
  const { code = '' } = useParams()
  const { t, lang } = useI18n()
  const [detail, setDetail] = useState<TourDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [option, setOption] = useState<string | null>(null)
  const [start, setStart] = useState(() => new Date())
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [pax, setPax] = useState<Record<string, number>>({})
  const [form, setForm] = useState({ name: '', email: '', phone: '', hotel: '', note: '' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<BookingResult | null>(null)

  useEffect(() => {
    api.tour(code)
      .then((d) => {
        setDetail(d)
        document.title = d.tour.name
        setOption(d.options[0]?.code ?? null)
        setPax(d.categories.some((c) => c.code === 'adult') ? { adult: 2 } : {})
      })
      .catch((e: ApiError) => setLoadError(e.code))
  }, [code])

  useEffect(() => {
    if (!option) return
    setSlots(null)
    setSlot(null)
    let alive = true
    api.availability(option, iso(start), iso(addDays(start, WINDOW - 1)))
      .then((r) => alive && setSlots(r.slots))
      .catch(() => alive && setSlots([]))
    return () => {
      alive = false
    }
  }, [option, start])

  const opt = detail?.options.find((o) => o.code === option) ?? null
  const seatsNeeded = useMemo(
    () => Object.entries(pax).reduce((s, [k, n]) => s + (detail?.categories.find((c) => c.code === k)?.counts_as_seat === false ? 0 : n), 0),
    [pax, detail],
  )
  const travelers = Object.values(pax).reduce((a, b) => a + b, 0)
  const total = useMemo(() => {
    if (!opt || opt.price_adult == null) return null
    return Object.entries(pax).reduce((s, [k, n]) => s + n * (k === 'infant' ? 0 : k === 'child' ? (opt.price_child ?? opt.price_adult!) : opt.price_adult!), 0)
  }, [opt, pax])

  const byDate = useMemo(() => {
    const m = new Map<string, Slot[]>()
    for (const s of slots ?? []) m.set(s.date, [...(m.get(s.date) ?? []), s])
    return m
  }, [slots])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!option || !slot || seatsNeeded < 1) {
      setError(t.pickFirst)
      return
    }
    setSending(true)
    try {
      const r = await api.request({
        option, date: slot.date, time: slot.time, pax,
        contact: { name: form.name, email: form.email, phone: form.phone || undefined }, hotel: form.hotel, note: form.note,
      })
      setDone(r)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'server'
      setError(t.errors[c] ?? t.errors.server ?? null)
      if (c === 'no_availability') setStart(new Date(start))
    } finally {
      setSending(false)
    }
  }

  if (loadError) return <main className="wrap section"><p className="notice notice-error">{t.errors[loadError] ?? t.loadError}</p><Link to="/">← {t.back}</Link></main>
  if (!detail) return <main className="wrap section"><div className="card skeleton tall" /></main>
  const tour = detail.tour

  if (done) {
    return (
      <main className="wrap section">
        <div className="confirm">
          <div className="confirm-mark" aria-hidden>✓</div>
          <h1>{t.thanks}</h1>
          <p>{t.thanksText}</p>
          <p className="ref">{done.booking_code}</p>
          <p className="muted">{tour.name} · {opt?.name} · {done.date} {done.time}
            {done.amount != null && done.currency ? ` · ${money(done.amount, done.currency, lang)}` : ''}</p>
          <Link to="/" className="btn">{t.bookAnother}</Link>
        </div>
      </main>
    )
  }

  const days = Array.from({ length: WINDOW }, (_, i) => addDays(start, i))
  const today = new Date()
  const canPrev = iso(start) > iso(today)

  return (
    <main>
      <Cover url={tour.image_url} title={tour.name} className="banner" />
      <div className="wrap tour-layout">
        <article className="tour-main">
          <Link to="/" className="back">← {t.back}</Link>
          <h1>{tour.name}</h1>
          <div className="chips">
            {tour.destination && <span className="chip">{tour.destination}</span>}
            {tour.duration_minutes && <span className="chip">{t.hours(Math.round((tour.duration_minutes / 60) * 10) / 10)}</span>}
          </div>
          {tour.description && <section><h2>{t.about}</h2><p className="prose">{tour.description}</p></section>}
          {tour.itinerary.length > 0 && (
            <section><h2>{t.itinerary}</h2>
              <ol className="timeline">{tour.itinerary.map((s, i) => <li key={i}>{typeof s === 'string' ? s : <><b>{s.title}</b>{s.description && <p className="muted">{s.description}</p>}</>}</li>)}</ol>
            </section>
          )}
          {(tour.inclusions.length > 0 || tour.exclusions.length > 0) && (
            <section className="two">
              {tour.inclusions.length > 0 && <div><h2>{t.included}</h2><ul className="ticks">{tour.inclusions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              {tour.exclusions.length > 0 && <div><h2>{t.excluded}</h2><ul className="crosses">{tour.exclusions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            </section>
          )}
          {tour.joining_instructions && <section><h2>{t.meeting}</h2><p className="prose">{tour.joining_instructions}</p></section>}
        </article>

        <aside className="book">
          <form onSubmit={submit} className="book-card">
            <h3>{t.chooseOption}</h3>
            <div className="options">
              {detail.options.map((o) => (
                <label key={o.code} className={`option ${option === o.code ? 'on' : ''}`}>
                  <input type="radio" name="option" checked={option === o.code} onChange={() => setOption(o.code)} />
                  <span className="option-name">{o.name}</span>
                  <span className="muted small">{o.is_private ? t.private : t.shared}{o.has_transfer ? ` · ${t.pickup}` : ''}</span>
                  <span className="option-price">{o.price_adult != null ? money(o.price_adult, o.currency, lang) : t.priceOnRequest}</span>
                </label>
              ))}
            </div>

            <h3>{t.chooseDate}</h3>
            <div className="date-nav">
              <button type="button" disabled={!canPrev} onClick={() => setStart(addDays(start, -WINDOW) < today ? today : addDays(start, -WINDOW))}>← {t.prev}</button>
              <span className="muted small">{iso(start)} – {iso(addDays(start, WINDOW - 1))}</span>
              <button type="button" onClick={() => setStart(addDays(start, WINDOW))}>{t.next} →</button>
            </div>
            {slots === null ? <div className="skeleton line" /> : byDate.size === 0 ? <p className="muted small">{t.noSlots}</p> : (
              <div className="days">
                {days.filter((d) => byDate.has(iso(d))).map((d) => (
                  <div key={iso(d)} className="day">
                    <div className="day-label">{d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                    <div className="times">
                      {byDate.get(iso(d))!.map((s) => {
                        const full = s.available < Math.max(1, seatsNeeded)
                        const on = slot?.date === s.date && slot.time === s.time
                        return (
                          <button type="button" key={s.time} disabled={full} className={`time ${on ? 'on' : ''}`} onClick={() => setSlot(s)}
                            title={t.seatsLeft(s.available)}>
                            {s.time}<small>{full ? '—' : t.seatsLeft(s.available)}</small>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h3>{t.travelers}</h3>
            {detail.categories.map((c) => (
              <div key={c.code} className="stepper">
                <span>{t.category[c.code] ?? c.name} <small className="muted">{[t.age(c.min_age, c.max_age), c.counts_as_seat ? '' : t.noSeat].filter(Boolean).join(' · ')}</small></span>
                <span className="step">
                  <button type="button" aria-label="-" onClick={() => setPax({ ...pax, [c.code]: Math.max(0, (pax[c.code] ?? 0) - 1) })}>−</button>
                  <b>{pax[c.code] ?? 0}</b>
                  <button type="button" aria-label="+" disabled={travelers >= 20} onClick={() => setPax({ ...pax, [c.code]: (pax[c.code] ?? 0) + 1 })}>+</button>
                </span>
              </div>
            ))}

            <h3>{t.yourDetails}</h3>
            <div className="fields">
              <input required minLength={2} maxLength={100} placeholder={t.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
              <input required type="email" maxLength={200} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
              <input maxLength={40} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
              <input maxLength={200} placeholder={t.hotel} value={form.hotel} onChange={(e) => setForm({ ...form, hotel: e.target.value })} />
              <textarea maxLength={1000} rows={2} placeholder={t.note} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>

            <div className="total">
              <span>{t.total}</span>
              <b>{total != null && opt ? money(total, opt.currency, lang) : t.priceOnRequest}</b>
            </div>
            <p className="muted small">{t.totalNote}</p>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            <button className="btn btn-block" disabled={sending}>{sending ? t.sending : t.send}</button>
          </form>
        </aside>
      </div>
    </main>
  )
}
