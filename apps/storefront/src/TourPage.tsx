import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, TURNSTILE_SITEKEY, type BookingResult, type Option, type Slot, type Step, type TourCard, type TourDetail } from './api'
import { displayName, durationText, localized, money, useI18n } from './i18n'
import { Turnstile, type TurnstileHandle } from './Turnstile'
import { Cover, TourCardView, waLink } from './ui'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
const parseIso = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null)

// Giá tạm tính tại trình duyệt, giống _storefront_price ở database; server vẫn báo giá lại.
function localPrice(o: Option | null, pax: Record<string, number>) {
  if (!o) return null
  const paying = Object.entries(pax).reduce((s, [k, n]) => s + (k === 'infant' ? 0 : n), 0)
  if (o.group_prices.length > 0) {
    const tier = [...o.group_prices].sort((a, b) => (b.min ?? 1) - (a.min ?? 1))
      .find((g) => paying >= (g.min ?? 1) && (g.max == null || paying <= g.max))
    if (tier) return tier.per_person * paying
  }
  if (o.price_adult == null) return null
  return Object.entries(pax).reduce((s, [k, n]) => s + n * (k === 'infant' ? 0 : k === 'child' ? (o.price_child ?? o.price_adult!) : o.price_adult!), 0)
}

function Gallery({ images, title }: { images: string[]; title: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    if (open == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
      if (e.key === 'ArrowRight') setOpen((i) => (i! + 1) % images.length)
      if (e.key === 'ArrowLeft') setOpen((i) => (i! - 1 + images.length) % images.length)
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, images.length])
  if (images.length <= 1) return <Cover url={images[0] ?? null} title={title} className="banner" />
  const shown = images.slice(0, 5)
  return (
    <>
      <div className={`gallery wrap g${shown.length}`}>
        {shown.map((src, i) => (
          <button key={src} className="g-item" onClick={() => setOpen(i)} aria-label={`${title} ${i + 1}`}>
            <img src={src} alt="" loading={i ? 'lazy' : 'eager'} />
            {i === shown.length - 1 && images.length > shown.length && <span className="g-more">{t.photos(images.length - shown.length)}</span>}
          </button>
        ))}
      </div>
      {open != null && (
        <div className="lightbox" role="dialog" aria-label={t.showPhotos} onClick={() => setOpen(null)}>
          <button className="lb-close" aria-label={t.close} onClick={() => setOpen(null)}>×</button>
          <button className="lb-nav lb-prev" aria-label="←" onClick={(e) => { e.stopPropagation(); setOpen((open - 1 + images.length) % images.length) }}>‹</button>
          <img src={images[open]} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lb-nav lb-next" aria-label="→" onClick={(e) => { e.stopPropagation(); setOpen((open + 1) % images.length) }}>›</button>
          <span className="lb-count">{open + 1} / {images.length}</span>
        </div>
      )}
    </>
  )
}

function List({ items, className }: { items: string[]; className?: string }) {
  return <ul className={className}>{items.map((x) => <li key={x}>{x}</li>)}</ul>
}

export function TourPage() {
  const { code = '' } = useParams()
  const [params] = useSearchParams()
  const { t, lang, place } = useI18n()
  const [detail, setDetail] = useState<TourDetail | null>(null)
  const [related, setRelated] = useState<TourCard[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [option, setOption] = useState<string | null>(null)
  const initialDate = parseIso(params.get('date'))
  const [month, setMonth] = useState(() => monthStart(initialDate ?? new Date()))
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [day, setDay] = useState<string | null>(initialDate ? iso(initialDate) : null)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [pax, setPax] = useState<Record<string, number>>({})
  const [quote, setQuote] = useState<number | null>(null)
  const [step, setStep] = useState<'select' | 'details'>('select')
  const [form, setForm] = useState({ name: '', email: '', phone: '', hotel: '', note: '' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<BookingResult | null>(null)
  // Token Turnstile (khi trang có sitekey): dùng một lần, gửi xong thì reset để lấy token mới.
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaDown, setCaptchaDown] = useState(false)
  const captchaRef = useRef<TurnstileHandle>(null)
  const bookRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDetail(null)
    setLoadError(null)
    setDone(null)
    setStep('select')
    api.tour(code)
      .then((d) => {
        setDetail(d)
        setOption(d.options[0]?.code ?? null)
        const guests = Number(params.get('guests')) || 2
        setPax(d.categories.some((c) => c.code === 'adult') ? { adult: Math.min(20, Math.max(1, guests)) } : {})
        api.storefront()
          .then((s) => setRelated(s.tours.filter((x) => x.code !== d.tour.code && x.destination === d.tour.destination && x.image_url).slice(0, 3)))
          .catch(() => setRelated([]))
      })
      .catch((e: ApiError) => setLoadError(e.code))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const tour = detail?.tour
  const name = tour ? displayName(localized(lang, tour.name, tour.vi?.name)) : ''
  useEffect(() => {
    if (name) document.title = name
  }, [name])

  // Lịch còn chỗ của cả tháng đang xem (không xem ngày đã qua).
  useEffect(() => {
    if (!option) return
    setSlots(null)
    let alive = true
    const today = new Date()
    const from = month < monthStart(today) ? today : month < today ? today : month
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 0)
    if (to < today) {
      setSlots([])
      return
    }
    api.availability(option, iso(from), iso(to))
      .then((r) => alive && setSlots(r.slots))
      .catch(() => alive && setSlots([]))
    return () => {
      alive = false
    }
  }, [option, month])

  const opt = detail?.options.find((o) => o.code === option) ?? null
  const seatsNeeded = useMemo(
    () => Object.entries(pax).reduce((s, [k, n]) => s + (detail?.categories.find((c) => c.code === k)?.counts_as_seat === false ? 0 : n), 0),
    [pax, detail],
  )
  const travelers = Object.values(pax).reduce((a, b) => a + b, 0)
  const estimate = localPrice(opt, pax)

  // Báo giá từ server (đúng như lúc đặt); trong lúc chờ hiện số tạm tính.
  useEffect(() => {
    setQuote(null)
    if (!option || travelers === 0) return
    let alive = true
    const h = setTimeout(() => {
      api.quote(option, pax).then((r) => alive && setQuote(r.amount)).catch(() => {})
    }, 250)
    return () => {
      alive = false
      clearTimeout(h)
    }
  }, [option, pax, travelers])
  const total = quote ?? estimate

  const byDate = useMemo(() => {
    const m = new Map<string, Slot[]>()
    for (const s of slots ?? []) m.set(s.date, [...(m.get(s.date) ?? []), s])
    return m
  }, [slots])

  // Chọn sẵn ngày đầu tiên còn chỗ của tháng nếu ngày đang chọn không có chuyến.
  useEffect(() => {
    if (!slots) return
    if (day && byDate.has(day)) return
    const first = slots.find((s) => s.available >= Math.max(1, seatsNeeded))
    setDay(first?.date ?? null)
    setSlot(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots])

  useEffect(() => {
    if (slot && slot.available < seatsNeeded) setSlot(null)
  }, [seatsNeeded, slot])

  // Ngày chỉ có một giờ chạy còn đủ chỗ thì chọn sẵn giờ đó.
  useEffect(() => {
    if (!day || slot?.date === day) return
    const open = (byDate.get(day) ?? []).filter((s) => s.available >= Math.max(1, seatsNeeded))
    if (open.length === 1) setSlot(open[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, byDate])

  if (loadError) return <main className="wrap section"><p className="notice notice-error">{t.errors[loadError] ?? t.loadError}</p><Link to="/tours">← {t.back}</Link></main>
  if (!detail || !tour) return <main className="wrap section"><div className="card skeleton tall" /></main>

  const L = <T,>(base: T, key: keyof typeof tour.vi) => localized(lang, base, tour.vi?.[key])
  const description = L(tour.description, 'description')
  const highlights = L(tour.highlights, 'highlights')
  const itinerary = L<Step[]>(tour.itinerary, 'itinerary')
  const inclusions = L(tour.inclusions, 'inclusions')
  const exclusions = L(tour.exclusions, 'exclusions')
  const meeting = L(tour.joining_instructions, 'joining_instructions')
  const bring = L(tour.what_to_bring, 'what_to_bring')
  const notes = L(tour.good_to_know, 'good_to_know')
  const duration = durationText(t, L(tour.duration_label, 'duration_label'), tour.duration_minutes)
  const settings = detail.settings ?? {}
  const contact = settings.contact ?? {}
  const images = tour.gallery.length ? tour.gallery : tour.image_url ? [tour.image_url] : []
  const fromPrice = Math.min(...detail.options.map((o) => o.from_price ?? Infinity))
  const currency = detail.options.find((o) => o.from_price != null)?.currency ?? 'USD'
  const childNote = opt ? localized(lang, opt.child_note, opt.vi?.child_note) : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!option || !slot || seatsNeeded < 1) {
      setError(t.pickFirst)
      setStep('select')
      return
    }
    setSending(true)
    try {
      const r = await api.request({
        option, date: slot.date, time: slot.time, pax,
        contact: { name: form.name, email: form.email, phone: form.phone || undefined }, hotel: form.hotel, note: form.note,
        token: captcha ?? undefined,
      })
      setDone(r)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'server'
      setError(t.errors[c] ?? t.errors.server ?? null)
      if (c === 'no_availability') {
        setStep('select')
        setMonth(new Date(month))
      }
    } finally {
      setSending(false)
      captchaRef.current?.reset()
    }
  }

  const goDetails = () => {
    setError(null)
    if (!slot || seatsNeeded < 1) {
      setError(t.pickFirst)
      return
    }
    setStep('details')
  }

  if (done) {
    return (
      <main className="wrap section">
        <div className="confirm">
          <div className="confirm-mark" aria-hidden>✓</div>
          <h1>{t.thanks}</h1>
          <p>{t.thanksText}</p>
          <p className="ref">{done.booking_code}</p>
          <p className="muted">{name} · {opt ? (opt.is_private ? t.private : t.join) : ''} · {done.date} {done.time}
            {done.amount != null && done.currency ? ` · ${money(done.amount, done.currency, lang)}` : ''}</p>
          <Link to="/tours" className="btn">{t.bookAnother}</Link>
        </div>
      </main>
    )
  }

  // Lịch tháng, tuần bắt đầu thứ Hai.
  const today = iso(new Date())
  const first = month
  const lead = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => iso(new Date(first.getFullYear(), first.getMonth(), i + 1)))]
  const canPrev = month > monthStart(new Date())
  const monthLabel = month.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { month: 'long', year: 'numeric' })
  const daySlots = day ? byDate.get(day) ?? [] : []

  return (
    <main className="tour-page">
      <Gallery images={images} title={name} />
      <div className="wrap tour-layout">
        <article className="tour-main">
          <Link to="/tours" className="back">← {t.back}</Link>
          <h1>{name}</h1>
          <div className="facts">
            {tour.destination && <span>📍 {place(tour.destination)}</span>}
            {duration && <span>⏱ {duration}</span>}
            {tour.group_max && <span>👥 {t.maxPeople(tour.group_max)}</span>}
            {detail.options[0]?.language && <span>💬 {t.language(detail.options[0].language)}</span>}
            {detail.options.some((o) => o.has_transfer) && <span>🚐 {t.pickup}</span>}
          </div>
          {description && <section><h2>{t.about}</h2><p className="prose">{description}</p></section>}
          {highlights.length > 0 && <section><h2>{t.highlights}</h2><List items={highlights} className="ticks" /></section>}
          {itinerary.length > 0 && (
            <section><h2>{t.itinerary}</h2>
              <ol className="timeline">{itinerary.map((s, i) => (
                <li key={i}>{typeof s === 'string' ? s : <><b>{s.title}</b>{s.description && <p className="muted">{s.description}</p>}</>}</li>
              ))}</ol>
            </section>
          )}
          {(inclusions.length > 0 || exclusions.length > 0) && (
            <section className="two">
              {inclusions.length > 0 && <div><h2>{t.included}</h2><List items={inclusions} className="ticks" /></div>}
              {exclusions.length > 0 && <div><h2>{t.excluded}</h2><List items={exclusions} className="crosses" /></div>}
            </section>
          )}
          {meeting && <section><h2>{t.meeting}</h2><p className="prose">{meeting}</p></section>}
          {bring.length > 0 && <section><h2>{t.whatToBring}</h2><List items={bring} className="dots" /></section>}
          {notes.length > 0 && <section><h2>{t.goodToKnow}</h2><List items={notes} className="dots" /></section>}
          <section className="policy">
            <h2>{t.policies}</h2>
            {settings.cancel_free_hours != null && <p>✓ {t.policyCancel(settings.cancel_free_hours)}</p>}
            <p>✓ {t.policyPay}</p>
            {contact.whatsapp && <p><a href={waLink(contact.whatsapp)} target="_blank" rel="noreferrer">{t.chatWhatsapp} · {contact.whatsapp}</a></p>}
          </section>
        </article>

        <aside className="book" ref={bookRef} id="book">
          <div className="book-card">
            <div className="book-price">
              {Number.isFinite(fromPrice)
                ? <><small>{t.from}</small> <b>{money(fromPrice, currency, lang)}</b> <small>{t.perPerson}</small></>
                : <small>{t.priceOnRequest}</small>}
            </div>

            {step === 'select' && (
              <>
                {detail.options.length > 1 && (
                  <>
                    <h3>{t.tourType}</h3>
                    <div className="seg">
                      {detail.options.map((o) => (
                        <button type="button" key={o.code} className={option === o.code ? 'on' : ''} onClick={() => setOption(o.code)}>
                          <span>{o.is_private ? t.private : t.join}</span>
                          <small>{o.from_price != null ? `${t.from} ${money(o.from_price, o.currency, lang)}` : t.priceOnRequest}</small>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {opt && opt.group_prices.length > 0 && (
                  <table className="tiers">
                    <caption>{t.groupPrices}</caption>
                    <tbody>
                      {opt.group_prices.map((g) => (
                        <tr key={`${g.min}-${g.max}`}><td>{t.peopleRange(g.min, g.max)}</td><td>{money(g.per_person, opt.currency, lang)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3>{t.chooseDate}</h3>
                <div className="cal">
                  <div className="cal-head">
                    <button type="button" disabled={!canPrev} onClick={() => setMonth(addMonths(month, -1))} aria-label="←">‹</button>
                    <span>{monthLabel}</span>
                    <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="→">›</button>
                  </div>
                  <div className="cal-grid">
                    {t.weekdays.map((w) => <span key={w} className="cal-wd">{w}</span>)}
                    {cells.map((c, i) => {
                      if (!c) return <span key={`e${i}`} />
                      const s = byDate.get(c)
                      const best = s ? Math.max(...s.map((x) => x.available)) : 0
                      const ok = !!s && best >= Math.max(1, seatsNeeded) && c >= today
                      return (
                        <button type="button" key={c} disabled={!ok} className={`cal-day${day === c ? ' on' : ''}${ok && best <= 3 ? ' low' : ''}`}
                          onClick={() => { setDay(c); setSlot(null) }}>
                          {Number(c.slice(8))}
                        </button>
                      )
                    })}
                  </div>
                  {slots === null && <div className="skeleton line" />}
                  {slots !== null && byDate.size === 0 && <p className="muted small">{t.noSlots}</p>}
                </div>

                {daySlots.length > 0 && (
                  <>
                    <h3>{t.chooseTime}</h3>
                    <div className="times">
                      {daySlots.map((s) => {
                        const full = s.available < Math.max(1, seatsNeeded)
                        return (
                          <button type="button" key={s.time} disabled={full} className={`time ${slot?.date === s.date && slot.time === s.time ? 'on' : ''}`}
                            onClick={() => setSlot(s)}>
                            {s.time}<small>{full ? '—' : t.seatsLeft(s.available)}</small>
                          </button>
                        )
                      })}
                    </div>
                  </>
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
                {childNote && <p className="muted small child-note">{childNote}</p>}
              </>
            )}

            {step === 'details' && slot && (
              <div className="summary">
                <div><b>{opt?.is_private ? t.private : t.join}</b> · {new Date(`${slot.date}T00:00:00`).toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · {slot.time}</div>
                <div className="muted small">{Object.entries(pax).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(t.category[k] ?? k).toLowerCase()}`).join(', ')}</div>
                <button type="button" className="linkbtn" onClick={() => setStep('select')}>{t.edit}</button>
              </div>
            )}

            <div className="total">
              <span>{t.total}</span>
              <b>{total != null && opt ? money(total, opt.currency, lang) : t.priceOnRequest}</b>
            </div>
            <p className="muted small">{t.totalNote}</p>

            {step === 'select' && (
              <>
                {error && <p className="notice notice-error" role="alert">{error}</p>}
                <button type="button" className="btn btn-block" onClick={goDetails}>{t.continue}</button>
              </>
            )}

            {step === 'details' && (
              <form onSubmit={submit}>
                <h3>{t.yourDetails}</h3>
                <div className="fields">
                  <input required minLength={2} maxLength={100} placeholder={t.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
                  <input required type="email" maxLength={200} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
                  <input maxLength={40} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
                  <input maxLength={200} placeholder={t.hotel} value={form.hotel} onChange={(e) => setForm({ ...form, hotel: e.target.value })} />
                  <textarea maxLength={1000} rows={2} placeholder={t.note} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                </div>
                {error && <p className="notice notice-error" role="alert">{error}</p>}
                {TURNSTILE_SITEKEY && <Turnstile ref={captchaRef} sitekey={TURNSTILE_SITEKEY} action="booking" lang={lang} onToken={(t) => { setCaptcha(t); if (t) setCaptchaDown(false) }} onUnavailable={() => setCaptchaDown(true)} />}
                <button className="btn btn-block" disabled={sending || (Boolean(TURNSTILE_SITEKEY) && !captcha && !captchaDown)}>
                  {sending ? t.sending : TURNSTILE_SITEKEY && !captcha && !captchaDown ? t.verifying : t.send}
                </button>
              </form>
            )}
            {contact.whatsapp && (
              <a className="wa" href={`${waLink(contact.whatsapp)}?text=${encodeURIComponent(`${tour.code} – ${name}`)}`} target="_blank" rel="noreferrer">{t.chatWhatsapp}</a>
            )}
          </div>
        </aside>
      </div>

      {related.length > 0 && (
        <section className="wrap section">
          <h2>{t.related}</h2>
          <div className="grid">{related.map((r) => <TourCardView key={r.code} tour={r} />)}</div>
        </section>
      )}

      <div className="mobile-bar">
        <span>{Number.isFinite(fromPrice) ? <><small>{t.from}</small> <b>{money(fromPrice, currency, lang)}</b></> : <small>{t.priceOnRequest}</small>}</span>
        <button className="btn" onClick={() => bookRef.current?.scrollIntoView({ behavior: 'smooth' })}>{t.checkDates}</button>
      </div>
    </main>
  )
}
