import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { api, configured } from './api'
import { HomePage } from './HomePage'
import { I18nProvider, useI18n } from './i18n'
import { TourPage } from './TourPage'
import './styles.css'

function Shell() {
  const { lang, setLang, t } = useI18n()
  // Tên doanh nghiệp lấy từ database, dùng cho mọi trang (kể cả khi mở thẳng trang một tour).
  const [brand, setBrand] = useState('')
  useEffect(() => {
    if (!configured) return
    api.storefront().then((d) => setBrand(d.name)).catch(() => setBrand(''))
  }, [])
  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-in">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>◆</span>
            <span>{brand || t.ourTours}</span>
          </Link>
          <span className="tagline">{t.tagline}</span>
          <div className="lang" role="group" aria-label="Language">
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
            <button className={lang === 'vi' ? 'on' : ''} onClick={() => setLang('vi')}>VI</button>
          </div>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/tour/:code" element={<TourPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <footer className="footer"><div className="wrap">{t.footer}</div></footer>
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
