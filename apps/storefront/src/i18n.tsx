import { createContext, useContext, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'vi'

const en = {
  tagline: 'Book directly with the operator',
  heroTitle: 'Book your tour directly',
  heroText: 'Pick a tour and a date that still has seats, then send your request. Your seats are held until the team confirms.',
  ourTours: 'Our tours',
  from: 'From',
  perPerson: 'per person',
  priceOnRequest: 'Price on request',
  privateAvailable: 'Private option',
  pickup: 'Hotel pickup',
  hours: (h: number) => `${h} ${h === 1 ? 'hour' : 'hours'}`,
  view: 'See dates',
  noTours: 'No tours are open for booking yet.',
  loadError: 'We could not load the tours. Please try again shortly.',
  notConfigured: 'This site is not connected to the booking system yet.',
  back: 'All tours',
  about: 'About this tour',
  itinerary: 'Itinerary',
  included: 'Included',
  excluded: 'Not included',
  meeting: 'Meeting and pickup',
  chooseOption: '1. Choose an option',
  chooseDate: '2. Choose a date and time',
  travelers: '3. Travelers',
  yourDetails: '4. Your details',
  private: 'Private',
  shared: 'Small group',
  noSlots: 'No departures with free seats in this period.',
  seatsLeft: (n: number) => (n <= 3 ? `${n} left` : 'Available'),
  prev: 'Earlier',
  next: 'Later',
  age: (min: number | null, max: number | null) => (min != null && max != null ? `Age ${min}-${max}` : min != null ? `Age ${min}+` : max != null ? `Up to ${max}` : ''),
  noSeat: 'no seat',
  // Nhóm khách quen thuộc dịch theo ngôn ngữ trang; nhóm khác dùng tên doanh nghiệp đặt.
  category: { adult: 'Adult', child: 'Child', infant: 'Infant' } as Record<string, string>,
  name: 'Full name',
  email: 'Email',
  phone: 'Phone (WhatsApp/Zalo)',
  hotel: 'Hotel or pickup address',
  note: 'Requests (diet, language...)',
  total: 'Estimated total',
  totalNote: 'Paid on confirmation. No card needed now.',
  send: 'Request booking',
  sending: 'Sending…',
  pickFirst: 'Choose an option, a time and at least one traveler.',
  thanks: 'Request received',
  thanksText: 'Your seats are held while our team confirms. Keep this reference:',
  bookAnother: 'Back to tours',
  footer: 'Bookings are confirmed by the operator. Prices in the currency shown.',
  errors: {
    no_availability: 'Those seats were just taken. Please pick another time.',
    invalid_email: 'Please enter a valid email.',
    invalid_name: 'Please enter your full name.',
    invalid_pax: 'Please check the number of travelers (1 to 20).',
    invalid_date: 'That date can no longer be booked.',
    too_many_requests: 'Too many requests from this email. Please contact us directly.',
    too_long: 'One of the fields is too long.',
    not_found: 'This tour is no longer available.',
    network: 'Connection problem. Please try again.',
    server: 'Something went wrong. Please try again.',
    not_configured: 'This site is not connected to the booking system yet.',
  } as Record<string, string>,
}

const vi: typeof en = {
  tagline: 'Đặt trực tiếp với đơn vị tổ chức',
  heroTitle: 'Đặt tour trực tiếp',
  heroText: 'Chọn tour và ngày còn chỗ rồi gửi yêu cầu. Chỗ của bạn được giữ cho đến khi đội ngũ xác nhận.',
  ourTours: 'Các tour',
  from: 'Từ',
  perPerson: 'mỗi khách',
  priceOnRequest: 'Giá liên hệ',
  privateAvailable: 'Có tour riêng',
  pickup: 'Đón tại khách sạn',
  hours: (h: number) => `${h} giờ`,
  view: 'Xem lịch',
  noTours: 'Chưa có tour nào mở bán.',
  loadError: 'Không tải được danh sách tour. Vui lòng thử lại sau.',
  notConfigured: 'Trang chưa được nối với hệ thống đặt chỗ.',
  back: 'Tất cả tour',
  about: 'Giới thiệu',
  itinerary: 'Lịch trình',
  included: 'Bao gồm',
  excluded: 'Không bao gồm',
  meeting: 'Điểm hẹn và đón',
  chooseOption: '1. Chọn gói',
  chooseDate: '2. Chọn ngày giờ',
  travelers: '3. Số khách',
  yourDetails: '4. Thông tin liên hệ',
  private: 'Tour riêng',
  shared: 'Nhóm nhỏ',
  noSlots: 'Không có chuyến còn chỗ trong khoảng này.',
  seatsLeft: (n: number) => (n <= 3 ? `Còn ${n} chỗ` : 'Còn chỗ'),
  prev: 'Trước',
  next: 'Sau',
  age: (min: number | null, max: number | null) => (min != null && max != null ? `${min}-${max} tuổi` : min != null ? `Từ ${min} tuổi` : max != null ? `Dưới ${max} tuổi` : ''),
  noSeat: 'không chiếm chỗ',
  category: { adult: 'Người lớn', child: 'Trẻ em', infant: 'Em bé' },
  name: 'Họ tên',
  email: 'Email',
  phone: 'Điện thoại (WhatsApp/Zalo)',
  hotel: 'Khách sạn hoặc địa chỉ đón',
  note: 'Yêu cầu thêm (ăn uống, ngôn ngữ...)',
  total: 'Tạm tính',
  totalNote: 'Thanh toán khi được xác nhận. Không cần thẻ lúc này.',
  send: 'Gửi yêu cầu đặt',
  sending: 'Đang gửi…',
  pickFirst: 'Chọn gói, giờ chạy và ít nhất một khách.',
  thanks: 'Đã nhận yêu cầu',
  thanksText: 'Chỗ của bạn đang được giữ trong lúc đội ngũ xác nhận. Mã tham chiếu:',
  bookAnother: 'Về danh sách tour',
  footer: 'Booking được đơn vị tổ chức xác nhận. Giá theo đơn vị tiền tệ hiển thị.',
  errors: {
    no_availability: 'Chỗ vừa được người khác đặt. Vui lòng chọn giờ khác.',
    invalid_email: 'Email chưa hợp lệ.',
    invalid_name: 'Vui lòng nhập họ tên.',
    invalid_pax: 'Kiểm tra lại số khách (1 đến 20).',
    invalid_date: 'Ngày này không còn đặt được.',
    too_many_requests: 'Email này đã gửi quá nhiều yêu cầu. Vui lòng liên hệ trực tiếp.',
    too_long: 'Có ô nhập quá dài.',
    not_found: 'Tour này không còn mở bán.',
    network: 'Lỗi kết nối. Vui lòng thử lại.',
    server: 'Có lỗi xảy ra. Vui lòng thử lại.',
    not_configured: 'Trang chưa được nối với hệ thống đặt chỗ.',
  },
}

const DICT = { en, vi }
const Ctx = createContext<{ lang: Lang; t: typeof en; setLang: (l: Lang) => void }>({ lang: 'en', t: en, setLang: () => {} })

function initial(): Lang {
  try {
    const saved = localStorage.getItem('storefront.lang')
    return saved === 'vi' ? 'vi' : 'en'
  } catch {
    return 'en'
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(initial)
  const setLang = (l: Lang) => {
    set(l)
    document.documentElement.lang = l
    try {
      localStorage.setItem('storefront.lang', l)
    } catch {
      /* chỉ là tiện ích, không lưu được cũng không sao */
    }
  }
  return <Ctx.Provider value={{ lang, t: DICT[lang], setLang }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)

export function money(amount: number, currency: string, lang: Lang) {
  try {
    return new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: currency === 'VND' ? 0 : 2 }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}
