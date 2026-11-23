import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const ORG = (import.meta.env.VITE_STOREFRONT_ORG as string | undefined) || 'hanoi-jeep'
export const configured = Boolean(url && key)

const client = configured ? createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } }) : null

export class ApiError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!client) throw new ApiError('not_configured')
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new ApiError(/fetch/i.test(error.message) ? 'network' : 'server')
  if (data && (data as { ok?: boolean }).ok === false) throw new ApiError((data as { code: string }).code)
  return data as T
}

export type WhyItem = { icon: string; title: string; text: string; vi?: { title?: string; text?: string } }
// Điểm đánh giá trên trang ngoài (TripAdvisor...), doanh nghiệp tự cập nhật; trang chỉ hiện số và link, không chép đánh giá.
export type ReviewBadge = {
  provider: string; name?: string; url: string; write_url?: string; rating?: number; count?: number; award?: string
  ranking?: string; categories?: string[]; location?: string; image?: string
}
export type Settings = {
  cancel_free_hours?: number
  contact?: { whatsapp?: string; zalo?: string; email?: string; phone?: string }
  // Khối "Vì sao chọn chúng tôi" trên trang chủ, do doanh nghiệp nhập. Không có thì trang tự ghi các điều có thật.
  why?: WhyItem[]
  reviews?: ReviewBadge[]
  // Widget chính thức TripAdvisor (mã do doanh nghiệp lấy ở tripadvisor.com/Widgets): loại, locationId, uniq.
  review_widgets?: ReviewWidget[]
}
export type ReviewWidget = { provider: 'tripadvisor'; type: string; location_id: string; uniq: string; lang?: string }
export type TourCard = {
  code: string; name: string; summary: string; destination: string | null; duration_minutes: number | null
  duration_label: string | null; group_max: number | null
  image_url: string | null; price_from: number | null; currency: string | null; has_private: boolean; has_transfer: boolean
  vi: { name?: string | null; summary?: string | null; duration_label?: string | null }
}
export type GroupPrice = { min: number | null; max: number | null; per_person: number }
export type Option = {
  code: string; name: string; is_private: boolean; has_transfer: boolean; language: string; duration_minutes: number | null
  price_adult: number | null; price_child: number | null; currency: string
  group_prices: GroupPrice[]; child_note: string | null; from_price: number | null
  vi: { public_name?: string; child_note?: string }
}
export type Category = { code: string; name: string; min_age: number | null; max_age: number | null; counts_as_seat: boolean }
export type Step = string | { title?: string; description?: string }
export type TourContent = {
  name: string; description: string | null; duration_label: string | null; highlights: string[]; itinerary: Step[]
  inclusions: string[]; exclusions: string[]; joining_instructions: string | null; what_to_bring: string[]; good_to_know: string[]
}
export type TourDetail = {
  settings: Settings
  tour: TourContent & {
    code: string; destination: string | null; duration_minutes: number | null; image_url: string | null; gallery: string[]
    group_max: number | null; timezone: string; vi: Partial<TourContent>
  }
  options: Option[]
  categories: Category[]
}
export type Slot = { date: string; time: string; available: number }
export type BookingResult = { booking_code: string; reference: string; date: string; time: string; amount: number | null; currency: string | null }
export type Storefront = { name: string; settings: Settings; tours: TourCard[] }

// Danh sách tour dùng ở nhiều trang (khung, trang chủ, danh sách, tour liên quan): tải một lần.
let storefrontPromise: Promise<Storefront> | null = null

export const api = {
  storefront: () => (storefrontPromise ??= call<Storefront>('public_storefront', { p_slug: ORG }).catch((e) => {
    storefrontPromise = null
    throw e
  })),
  tour: (code: string) => call<TourDetail>('public_tour', { p_slug: ORG, p_tour_code: code }),
  availability: (option: string, from: string, to: string) =>
    call<{ slots: Slot[] }>('public_availability', { p_slug: ORG, p_option_code: option, p_from: from, p_to: to }),
  quote: (option: string, pax: Record<string, number>) =>
    call<{ amount: number | null; currency: string }>('public_quote', { p_slug: ORG, p_option_code: option, p_pax: pax }),
  request: (a: { option: string; date: string; time: string; pax: Record<string, number>; contact: { name: string; email: string; phone?: string }; hotel?: string; note?: string }) =>
    call<BookingResult>('public_booking_request', {
      p_slug: ORG, p_option_code: a.option, p_date: a.date, p_time: a.time, p_pax: a.pax,
      p_contact: a.contact, p_hotel: a.hotel || null, p_note: a.note || null,
    }),
}
