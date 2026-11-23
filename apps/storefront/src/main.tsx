import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import { api, configured, type Storefront } from './api'
import { HomePage } from './HomePage'
import { I18nProvider, useI18n } from './i18n'
import { ToursPage } from './ToursPage'
import { TourPage } from './TourPage'
import { ReviewBadges, waLink } from './ui'
import './styles.css'

function ScrollTop() {
  const { pathname } = useLocation()
  // Không trả giá trị của scrollTo ra ngoài: Chrome mới trả về Promise, React sẽ coi là hàm dọn dẹp.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

function Shell() {
  const { lang, setLang, t } = useI18n()
  // Tên doanh nghiệp, liên hệ và điểm đến lấy từ database, dùng cho mọi trang.
  const [store, setStore] = useState<Storefront | null>(null)
  useEffect(() => {
    if (!configured) return
    api.storefront().then(setStore).catch(() => setStore(null))
  }, [])
  const contact = store?.settings.contact ?? {}
  const destinations = [...new Set((store?.tours ?? []).map((x) => x.destination).filter(Boolean) as string[])]

  return (
    <>
      <ScrollTop />
      {(contact.whatsapp || contact.email || contact.phone) && (
        <div className="contactbar">
          <div className="wrap contactbar-in">
            {contact.whatsapp && <a href={waLink(contact.whatsapp)} target="_blank" rel="noreferrer">WhatsApp {contact.whatsapp}</a>}
            {contact.phone && contact.phone !== contact.whatsapp && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}
            {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="wrap topbar-in">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>◆</span>
            <span>{store?.name || t.ourTours}</span>
          </Link>
          <nav className="nav">
            <Link to="/tours">{t.navTours}</Link>
            <Link to="/#destinations">{t.navDestinations}</Link>
            <Link to="/#faq">{t.navFaq}</Link>
            <a href="#contact">{t.navContact}</a>
          </nav>
          <div className="lang" role="group" aria-label="Language">
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
            <button className={lang === 'vi' ? 'on' : ''} onClick={() => setLang('vi')}>VI</button>
          </div>
          <Link to="/tours" className="btn btn-small nav-cta">{t.bookTour}</Link>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/tours" element={<ToursPage />} />
        <Route path="/tour/:code" element={<TourPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <footer className="footer" id="contact">
        <div className="wrap footer-grid">
          <div>
            <div className="footer-brand">{store?.name}</div>
            <p className="muted small">{t.footer}</p>
          </div>
          {destinations.length > 0 && (
            <div>
              <h4>{t.destinations}</h4>
              {destinations.map((d) => <Link key={d} to={`/tours?dest=${encodeURIComponent(d)}`}>{d}</Link>)}
            </div>
          )}
          <div>
            <h4>{t.contactTitle}</h4>
            {contact.whatsapp && <a href={waLink(contact.whatsapp)} target="_blank" rel="noreferrer">WhatsApp {contact.whatsapp}</a>}
            {contact.phone && contact.phone !== contact.whatsapp && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}
            {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
            {store?.settings.cancel_free_hours != null && <span className="muted small">{t.policyCancel(store.settings.cancel_free_hours)}</span>}
          </div>
          {!!store?.settings.reviews?.length && (
            <div className="footer-reviews">
              <h4>{t.reviewsTitle}</h4>
              <ReviewBadges items={store.settings.reviews} />
            </div>
          )}
        </div>
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
)
