// Trang khách chỉ gọi bốn hàm public_* bằng khóa anon; không đọc bảng nào trực tiếp.
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

export type TourCard = {
  code: string; name: string; summary: string; destination: string | null; duration_minutes: number | null
  image_url: string | null; price_from: number | null; currency: string | null; has_private: boolean; has_transfer: boolean
}
export type Option = {
  code: string; name: string; is_private: boolean; has_transfer: boolean; language: string; duration_minutes: number | null
  price_adult: number | null; price_child: number | null; currency: string
}
export type Category = { code: string; name: string; min_age: number | null; max_age: number | null; counts_as_seat: boolean }
export type TourDetail = {
  tour: { code: string; name: string; description: string | null; destination: string | null; duration_minutes: number | null
    image_url: string | null; itinerary: (string | { title?: string; description?: string })[]; inclusions: string[]; exclusions: string[]
    joining_instructions: string | null; timezone: string }
  options: Option[]
  categories: Category[]
}
export type Slot = { date: string; time: string; available: number }
export type BookingResult = { booking_code: string; reference: string; date: string; time: string; amount: number | null; currency: string | null }

export const api = {
  storefront: () => call<{ name: string; tours: TourCard[] }>('public_storefront', { p_slug: ORG }),
  tour: (code: string) => call<TourDetail>('public_tour', { p_slug: ORG, p_tour_code: code }),
  availability: (option: string, from: string, to: string) =>
    call<{ slots: Slot[] }>('public_availability', { p_slug: ORG, p_option_code: option, p_from: from, p_to: to }),
  request: (a: { option: string; date: string; time: string; pax: Record<string, number>; contact: { name: string; email: string; phone?: string }; hotel?: string; note?: string }) =>
    call<BookingResult>('public_booking_request', {
      p_slug: ORG, p_option_code: a.option, p_date: a.date, p_time: a.time, p_pax: a.pax,
      p_contact: a.contact, p_hotel: a.hotel || null, p_note: a.note || null,
    }),
}
