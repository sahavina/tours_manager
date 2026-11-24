// SEO và xem trước khi chia sẻ link cho trang đặt tour (SPA dựng bằng JavaScript).
// Worker chèn vào index.html: tiêu đề, mô tả, canonical, Open Graph (Facebook/Zalo), Twitter, dữ liệu có cấu trúc
// (JSON-LD) theo từng trang; phục vụ /sitemap.xml và /robots.txt.
// Lập chỉ mục do doanh nghiệp bật trong admin (storefront_settings.seo_index); chưa bật thì giữ noindex và
// robots.txt chặn hết, nhưng xem trước khi chia sẻ link vẫn có.

// Kiểu tối thiểu của HTMLRewriter (có sẵn trong runtime Workers).
declare const HTMLRewriter: {
  new (): {
    on(selector: string, handlers: { element: (el: { setInnerContent(c: string): void; setAttribute(n: string, v: string): void; append(c: string, o: { html: boolean }): void }) => void }): InstanceType<typeof HTMLRewriter>
    transform(r: Response): Response
  }
}

export interface SeoEnv {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  SUPABASE_URL: string
  SUPABASE_ANON_KEY?: string
  STOREFRONT_ORG?: string
}

type Settings = { seo_index?: boolean; contact?: { email?: string; whatsapp?: string } }
type Card = { code: string; name: string; summary: string | null; destination: string | null; image_url: string | null; price_from: number | null; currency: string | null }
type Store = { name: string; settings: Settings; tours: Card[] }
type Detail = {
  settings: Settings
  tour: { code: string; name: string; description: string | null; destination: string | null; image_url: string | null; gallery: string[]; duration_label: string | null; highlights: string[] }
  options: { from_price: number | null; currency: string }[]
}

const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'via'])
/** Tên viết HOA toàn bộ đổi sang dạng thường dễ đọc (giống trang khách). */
export function displayName(name: string) {
  const letters = name.replace(/[^A-Za-z]/g, '')
  const upper = letters.replace(/[^A-Z]/g, '').length
  if (!letters || upper / letters.length < 0.7) return name
  return name.toLowerCase().split(/(\s+)/).map((w, i) => {
    if (/\d/.test(w) || /^\s+$/.test(w)) return w.toUpperCase()
    if (i > 0 && SMALL.has(w)) return w
    return w.replace(/(^|[-/(])([a-zà-ỹ])/g, (_, p, c) => p + c.toUpperCase())
  }).join('')
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Gọi hàm công khai của database, lưu đệm 5 phút ở edge để không gọi mỗi lần có người mở trang.
async function rpc<T>(env: SeoEnv, fn: string, args: Record<string, unknown>): Promise<T | null> {
  if (!env.SUPABASE_ANON_KEY) return null
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}`
  const cacheKey = new Request(`${url}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))}`)
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default
  const hit = cache ? await cache.match(cacheKey) : undefined
  if (hit) return (await hit.json()) as T
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!r.ok) return null
    const body = await r.text()
    const data = JSON.parse(body) as T & { ok?: boolean }
    if (data && data.ok === false) return null
    if (cache) await cache.put(cacheKey, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } }))
    return data
  } catch {
    return null
  }
}

const store = (env: SeoEnv) => rpc<Store>(env, 'public_storefront', { p_slug: env.STOREFRONT_ORG || 'hanoi-jeep' })

type Meta = { title: string; description: string; image: string | null; canonical: string; index: boolean; jsonLd: unknown[] }

function headTags(m: Meta, siteName: string) {
  const t = [
    `<meta name="description" content="${esc(m.description)}" />`,
    `<link rel="canonical" href="${esc(m.canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(siteName)}" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:url" content="${esc(m.canonical)}" />`,
    `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(m.title)}" />`,
    `<meta name="twitter:description" content="${esc(m.description)}" />`,
  ]
  if (m.image) t.push(`<meta property="og:image" content="${esc(m.image)}" />`, `<meta name="twitter:image" content="${esc(m.image)}" />`)
  for (const j of m.jsonLd) t.push(`<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`)
  return t.join('\n    ')
}

async function metaFor(url: URL, env: SeoEnv): Promise<{ meta: Meta; siteName: string } | null> {
  const s = await store(env)
  if (!s) return null
  const site = s.name
  const origin = url.origin
  const index = Boolean(s.settings?.seo_index)
  const tourMatch = url.pathname.match(/^\/tour\/([^/]+)\/?$/)
  if (tourMatch) {
    const code = decodeURIComponent(tourMatch[1]!)
    const d = await rpc<Detail>(env, 'public_tour', { p_slug: env.STOREFRONT_ORG || 'hanoi-jeep', p_tour_code: code })
    if (!d) return null
    const name = displayName(d.tour.name)
    const prices = d.options.map((o) => o.from_price).filter((p): p is number => p != null)
    const from = prices.length ? Math.min(...prices) : null
    const currency = d.options.find((o) => o.from_price != null)?.currency ?? 'USD'
    const lead = from != null ? `From ${from} ${currency} per person. ` : ''
    const desc = clip(lead + (d.tour.description || d.tour.highlights.join('. ') || `${name} with ${site}`), 160)
    const image = d.tour.gallery[0] ?? d.tour.image_url
    const canonical = `${origin}/tour/${encodeURIComponent(d.tour.code)}`
    const trip: Record<string, unknown> = {
      '@context': 'https://schema.org', '@type': 'TouristTrip', name, description: desc, url: canonical,
      ...(image ? { image: d.tour.gallery.length ? d.tour.gallery.slice(0, 6) : [image] } : {}),
      ...(d.tour.destination ? { itinerary: { '@type': 'Place', name: d.tour.destination } } : {}),
      provider: { '@type': 'TravelAgency', name: site, url: origin },
      ...(from != null ? { offers: { '@type': 'Offer', price: from, priceCurrency: currency, url: canonical, availability: 'https://schema.org/InStock' } } : {}),
    }
    const crumbs = {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: site, item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: 'Tours', item: `${origin}/tours` },
        { '@type': 'ListItem', position: 3, name, item: canonical },
      ],
    }
    const title = `${clip(name, 68)} | ${site}`
    return { siteName: site, meta: { title, description: desc, image, canonical, index, jsonLd: [trip, crumbs] } }
  }
  const first = s.tours.find((t) => t.image_url)?.image_url ?? null
  if (url.pathname === '/tours' || url.pathname === '/tours/') {
    const dests = [...new Set(s.tours.map((t) => t.destination).filter(Boolean))].join(', ')
    return {
      siteName: site,
      meta: {
        title: `All tours | ${site}`, description: clip(`${s.tours.length} tours${dests ? ` in ${dests}` : ''}. Pick a date with free seats and book directly with ${site}.`, 160),
        image: first, canonical: `${origin}/tours`, index, jsonLd: [],
      },
    }
  }
  if (url.pathname === '/') {
    const org = { '@context': 'https://schema.org', '@type': 'TravelAgency', name: site, url: `${origin}/`, ...(first ? { image: first } : {}),
      ...(s.settings?.contact?.email ? { email: s.settings.contact.email } : {}), ...(s.settings?.contact?.whatsapp ? { telephone: s.settings.contact.whatsapp } : {}) }
    return {
      siteName: site,
      meta: {
        title: `${site} – Book jeep, motorbike and day tours directly`, description: clip(`Book ${s.tours.length} small-group and private tours directly with ${site}: pick a date with free seats, no payment needed until confirmed.`, 160),
        image: first, canonical: `${origin}/`, index, jsonLd: [org],
      },
    }
  }
  return null
}

/** Trang HTML (/, /tours, /tour/:code): index.html đã chèn thẻ SEO. */
export async function seoPage(req: Request, env: SeoEnv): Promise<Response> {
  const url = new URL(req.url)
  const base = await env.ASSETS.fetch(new Request(new URL('/', url).toString(), { headers: req.headers }))
  const info = await metaFor(url, env).catch(() => null)
  if (!info || !base.ok) return base
  const { meta, siteName } = info
  const res = new HTMLRewriter()
    .on('title', { element: (el) => { el.setInnerContent(meta.title) } })
    .on('meta[name="robots"]', { element: (el) => { el.setAttribute('content', meta.index ? 'index,follow' : 'noindex,nofollow') } })
    .on('head', { element: (el) => { el.append(headTags(meta, siteName), { html: true }) } })
    .transform(base)
  const headers = new Headers(res.headers)
  headers.set('cache-control', 'public, max-age=0, must-revalidate')
  return new Response(res.body, { status: 200, headers })
}

export async function robots(url: URL, env: SeoEnv): Promise<Response> {
  const s = await store(env)
  const body = s?.settings?.seo_index
    ? `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url.origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n'
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}

export async function sitemap(url: URL, env: SeoEnv): Promise<Response> {
  const s = await store(env)
  const urls = [`${url.origin}/`, `${url.origin}/tours`, ...(s?.tours ?? []).map((t) => `${url.origin}/tour/${encodeURIComponent(t.code)}`)]
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
