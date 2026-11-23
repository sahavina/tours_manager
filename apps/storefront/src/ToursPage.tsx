import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError, configured, type Storefront } from './api'
import { displayName, localized, useI18n } from './i18n'
import { durationGroup, TourCardView } from './ui'

export function ToursPage() {
  const { t, lang, place } = useI18n()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<Storefront | null>(null)
  const [error, setError] = useState<string | null>(configured ? null : 'not_configured')
  const dest = params.get('dest') ?? ''
  const dur = params.get('dur') ?? ''
  const q = params.get('q') ?? ''
  const date = params.get('date') ?? undefined

  useEffect(() => {
    if (!configured) return
    api.storefront()
      .then((d) => {
        setData(d)
        document.title = `${t.allTours} · ${d.name}`
      })
      .catch((e: ApiError) => setError(e.code === 'not_found' ? 'empty' : e.code))
  }, [t.allTours])

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const destinations = useMemo(() => [...new Set((data?.tours ?? []).map((x) => x.destination).filter(Boolean) as string[])], [data])
  const needle = q.trim().toLowerCase()
  const list = (data?.tours ?? []).filter((x) =>
    (!dest || x.destination === dest) &&
    (!dur || durationGroup(x) === dur) &&
    (!needle || `${x.code} ${displayName(localized(lang, x.name, x.vi?.name))} ${x.summary}`.toLowerCase().includes(needle)))

  return (
    <main className="wrap section">
      <h1 className="page-title">{t.allTours}</h1>
      <div className="filters">
        <div className="pills" role="group" aria-label={t.destinations}>
          <button className={!dest ? 'on' : ''} onClick={() => set('dest', '')}>{t.filterAll}</button>
          {destinations.map((d) => <button key={d} className={dest === d ? 'on' : ''} onClick={() => set('dest', d)}>{place(d)}</button>)}
        </div>
        <div className="filters-row">
          <select value={dur} onChange={(e) => set('dur', e.target.value)} aria-label={t.durationAny}>
            <option value="">{t.durationAny}</option>
            <option value="short">{t.durationShort}</option>
            <option value="day">{t.durationDay}</option>
            <option value="multi">{t.durationMulti}</option>
          </select>
          <input type="search" placeholder={t.searchTours} value={q} onChange={(e) => set('q', e.target.value)} />
        </div>
      </div>
      {error === 'empty' && <p className="notice">{t.noTours}</p>}
      {error && error !== 'empty' && <p className="notice notice-error">{error === 'not_configured' ? t.notConfigured : t.loadError}</p>}
      {!data && !error && <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" />)}</div>}
      {data && (list.length === 0
        ? <p className="notice">{t.noMatch} <button className="linkbtn" onClick={() => setParams({}, { replace: true })}>{t.clearFilters}</button></p>
        : <>
            <p className="muted small">{t.toursCount(list.length)}</p>
            <div className="grid">{list.map((tour) => <TourCardView key={tour.code} tour={tour} date={date} />)}</div>
          </>)}
    </main>
  )
}
