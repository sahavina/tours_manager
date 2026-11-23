import { createContext, useContext, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'vi'

const en = {
  tagline: 'Book directly with the operator',
  navTours: 'Tours',
  navDestinations: 'Destinations',
  navFaq: 'FAQs',
  navContact: 'Contact',
  bookTour: 'Book a tour',
  heroTitle: 'Book your tour directly',
  heroText: 'Pick a tour and a date that still has seats, then send your request. Your seats are held until the team confirms.',
  searchDestination: 'Destination',
  anyDestination: 'All destinations',
  searchDate: 'Date',
  searchGuests: (n: number) => `${n} ${n === 1 ? 'guest' : 'guests'}`,
  findTours: 'Find tours',
  destinations: 'Destinations',
  toursCount: (n: number) => `${n} ${n === 1 ? 'tour' : 'tours'}`,
  ourTours: 'Our tours',
  viewAll: (n: number) => `View all ${n} tours`,
  allTours: 'All tours',
  filterAll: 'All',
  durationAny: 'Any length',
  durationShort: 'Half day (up to 5 hours)',
  durationDay: 'Full day',
  durationMulti: 'Multi-day',
  searchTours: 'Search tours',
  noMatch: 'No tours match these filters.',
  clearFilters: 'Clear filters',
  whyTitle: 'Why book direct',
  whyChoose: 'Why choose',
  whyCancelTitle: 'Free cancellation',
  whyNoPayTitle: 'Pay after confirmation',
  whySmallTitle: 'Small groups',
  whyChatTitle: 'Real people on WhatsApp',
  whyCancel: (h: number) => `Free cancellation up to ${h} hours before the tour`,
  whyNoPay: 'No payment now: you pay after the team confirms',
  whySmall: (n: number) => `Small groups, up to ${n} people`,
  whyChat: 'Questions? Chat with us on WhatsApp',
  faqTitle: 'Frequently asked questions',
  faq: [
    ['How do I book?', 'Choose a tour, a date and the number of travelers, then send your request. Your seats are held while the team confirms by email or WhatsApp.'],
    ['When do I pay?', 'Nothing is charged online. You pay after the team confirms your booking.'],
    ['Can I cancel?', 'Cancellation is free up to {h} hours before the start time. Just reply to the confirmation or message us.'],
    ['Are there prices for children?', 'Each tour shows its own rules for children and infants next to the traveler selection.'],
  ] as [string, string][],
  contactTitle: 'Contact',
  chatWhatsapp: 'Chat on WhatsApp',
  from: 'From',
  perPerson: 'per person',
  priceOnRequest: 'Price on request',
  privateAvailable: 'Private option',
  pickup: 'Hotel pickup',
  hours: (h: number) => `${h} ${h === 1 ? 'hour' : 'hours'}`,
  maxPeople: (n: number) => `Max ${n} people`,
  language: (l: string) => (l === 'en' ? 'English guide' : l),
  view: 'See dates',
  noTours: 'No tours are open for booking yet.',
  loadError: 'We could not load the tours. Please try again shortly.',
  notConfigured: 'This site is not connected to the booking system yet.',
  back: 'All tours',
  photos: (n: number) => `+${n} photos`,
  showPhotos: 'Show all photos',
  close: 'Close',
  about: 'About this tour',
  highlights: 'Highlights',
  itinerary: 'Itinerary',
  included: 'Included',
  excluded: 'Not included',
  meeting: 'Meeting and pickup',
  whatToBring: 'What to bring',
  goodToKnow: 'Good to know',
  policies: 'Booking and cancellation',
  policyCancel: (h: number) => `Free cancellation up to ${h} hours before the start time.`,
  policyPay: 'No payment now. You pay after the team confirms your booking.',
  related: 'You might also like',
  tourType: 'Tour type',
  join: 'Join group',
  private: 'Private',
  shared: 'Small group',
  groupPrices: 'Private price per person',
  peopleRange: (min: number | null, max: number | null) => (max == null ? `${min ?? 1}+ people` : min === max ? `${min} ${min === 1 ? 'person' : 'people'}` : `${min}–${max} people`),
  chooseDate: 'Choose a date',
  chooseTime: 'Choose a time',
  noSlots: 'No departures with free seats this month.',
  seatsLeft: (n: number) => (n <= 3 ? `${n} left` : 'Available'),
  travelers: 'Travelers',
  age: (min: number | null, max: number | null) => (min != null && max != null ? `Age ${min}-${max}` : min != null ? `Age ${min}+` : max != null ? `Up to ${max}` : ''),
  noSeat: 'no seat',
  category: { adult: 'Adult', child: 'Child', infant: 'Infant' } as Record<string, string>,
  continue: 'Continue',
  edit: 'Change',
  yourDetails: 'Your details',
  name: 'Full name',
  email: 'Email',
  phone: 'Phone (WhatsApp/Zalo)',
  hotel: 'Hotel or pickup address',
  note: 'Requests (diet, language...)',
  total: 'Estimated total',
  totalNote: 'Paid on confirmation. No card needed now.',
  send: 'Request booking',
  sending: 'Sending…',
  pickFirst: 'Choose a date, a time and at least one traveler.',
  checkDates: 'Check availability',
  thanks: 'Request received',
  thanksText: 'Your seats are held while our team confirms. Keep this reference:',
  bookAnother: 'Back to tours',
  footer: 'Bookings are confirmed by the operator. Prices in the currency shown.',
  weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
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
  navTours: 'Tour',
  navDestinations: 'Điểm đến',
  navFaq: 'Hỏi đáp',
  navContact: 'Liên hệ',
  bookTour: 'Đặt tour',
  heroTitle: 'Đặt tour trực tiếp',
  heroText: 'Chọn tour và ngày còn chỗ rồi gửi yêu cầu. Chỗ của bạn được giữ cho đến khi đội ngũ xác nhận.',
  searchDestination: 'Điểm đến',
  anyDestination: 'Mọi điểm đến',
  searchDate: 'Ngày',
  searchGuests: (n: number) => `${n} khách`,
  findTours: 'Tìm tour',
  destinations: 'Điểm đến',
  toursCount: (n: number) => `${n} tour`,
  ourTours: 'Các tour',
  viewAll: (n: number) => `Xem cả ${n} tour`,
  allTours: 'Tất cả tour',
  filterAll: 'Tất cả',
  durationAny: 'Mọi thời lượng',
  durationShort: 'Nửa ngày (tối đa 5 giờ)',
  durationDay: 'Cả ngày',
  durationMulti: 'Nhiều ngày',
  searchTours: 'Tìm tour',
  noMatch: 'Không có tour phù hợp bộ lọc.',
  clearFilters: 'Bỏ lọc',
  whyTitle: 'Vì sao đặt trực tiếp',
  whyChoose: 'Vì sao chọn',
  whyCancelTitle: 'Hủy miễn phí',
  whyNoPayTitle: 'Trả tiền sau khi xác nhận',
  whySmallTitle: 'Nhóm nhỏ',
  whyChatTitle: 'Người thật trả lời qua WhatsApp',
  whyCancel: (h: number) => `Hủy miễn phí trước giờ khởi hành ${h} giờ`,
  whyNoPay: 'Chưa cần thanh toán: trả tiền sau khi được xác nhận',
  whySmall: (n: number) => `Nhóm nhỏ, tối đa ${n} người`,
  whyChat: 'Cần hỏi thêm? Nhắn chúng tôi qua WhatsApp',
  faqTitle: 'Câu hỏi thường gặp',
  faq: [
    ['Đặt tour thế nào?', 'Chọn tour, ngày và số khách rồi gửi yêu cầu. Chỗ của bạn được giữ trong lúc đội ngũ xác nhận qua email hoặc WhatsApp.'],
    ['Khi nào tôi thanh toán?', 'Không thu tiền trực tuyến. Bạn thanh toán sau khi booking được xác nhận.'],
    ['Tôi có hủy được không?', 'Hủy miễn phí trước giờ khởi hành {h} giờ. Chỉ cần trả lời thư xác nhận hoặc nhắn cho chúng tôi.'],
    ['Trẻ em có giá riêng không?', 'Mỗi tour ghi quy định giá cho trẻ em và em bé ngay ở phần chọn số khách.'],
  ],
  contactTitle: 'Liên hệ',
  chatWhatsapp: 'Nhắn WhatsApp',
  from: 'Từ',
  perPerson: 'mỗi khách',
  priceOnRequest: 'Giá liên hệ',
  privateAvailable: 'Có tour riêng',
  pickup: 'Đón tại khách sạn',
  hours: (h: number) => `${h} giờ`,
  maxPeople: (n: number) => `Tối đa ${n} người`,
  language: (l: string) => (l === 'en' ? 'Hướng dẫn tiếng Anh' : l),
  view: 'Xem lịch',
  noTours: 'Chưa có tour nào mở bán.',
  loadError: 'Không tải được danh sách tour. Vui lòng thử lại sau.',
  notConfigured: 'Trang chưa được nối với hệ thống đặt chỗ.',
  back: 'Tất cả tour',
  photos: (n: number) => `+${n} ảnh`,
  showPhotos: 'Xem tất cả ảnh',
  close: 'Đóng',
  about: 'Giới thiệu',
  highlights: 'Điểm nổi bật',
  itinerary: 'Lịch trình',
  included: 'Bao gồm',
  excluded: 'Không bao gồm',
  meeting: 'Điểm hẹn và đón',
  whatToBring: 'Nên mang theo',
  goodToKnow: 'Lưu ý',
  policies: 'Đặt chỗ và hủy',
  policyCancel: (h: number) => `Hủy miễn phí trước giờ khởi hành ${h} giờ.`,
  policyPay: 'Chưa cần thanh toán. Bạn trả tiền sau khi booking được xác nhận.',
  related: 'Có thể bạn thích',
  tourType: 'Loại tour',
  join: 'Tour ghép',
  private: 'Tour riêng',
  shared: 'Nhóm nhỏ',
  groupPrices: 'Giá tour riêng mỗi khách',
  peopleRange: (min: number | null, max: number | null) => (max == null ? `Từ ${min ?? 1} người` : min === max ? `${min} người` : `${min}–${max} người`),
  chooseDate: 'Chọn ngày',
  chooseTime: 'Chọn giờ',
  noSlots: 'Tháng này không còn chuyến trống.',
  seatsLeft: (n: number) => (n <= 3 ? `Còn ${n} chỗ` : 'Còn chỗ'),
  travelers: 'Số khách',
  age: (min: number | null, max: number | null) => (min != null && max != null ? `${min}-${max} tuổi` : min != null ? `Từ ${min} tuổi` : max != null ? `Dưới ${max} tuổi` : ''),
  noSeat: 'không chiếm chỗ',
  category: { adult: 'Người lớn', child: 'Trẻ em', infant: 'Em bé' },
  continue: 'Tiếp tục',
  edit: 'Đổi',
  yourDetails: 'Thông tin liên hệ',
  name: 'Họ tên',
  email: 'Email',
  phone: 'Điện thoại (WhatsApp/Zalo)',
  hotel: 'Khách sạn hoặc địa chỉ đón',
  note: 'Yêu cầu thêm (ăn uống, ngôn ngữ...)',
  total: 'Tạm tính',
  totalNote: 'Thanh toán khi được xác nhận. Không cần thẻ lúc này.',
  send: 'Gửi yêu cầu đặt',
  sending: 'Đang gửi…',
  pickFirst: 'Chọn ngày, giờ và ít nhất một khách.',
  checkDates: 'Xem lịch còn chỗ',
  thanks: 'Đã nhận yêu cầu',
  thanksText: 'Chỗ của bạn đang được giữ trong lúc đội ngũ xác nhận. Mã tham chiếu:',
  bookAnother: 'Về danh sách tour',
  footer: 'Booking được đơn vị tổ chức xác nhận. Giá theo đơn vị tiền tệ hiển thị.',
  weekdays: ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'],
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

// Nội dung tiếng Việt của doanh nghiệp: dùng khi khách chọn VI và có bản dịch, không thì dùng bản gốc.
export function localized<T>(lang: Lang, base: T, vi: unknown): T {
  if (lang !== 'vi' || vi == null || (typeof vi === 'string' && !vi.trim()) || (Array.isArray(vi) && vi.length === 0)) return base
  return vi as T
}

// Tên tour viết HOA toàn bộ (như trên website gốc) đổi sang dạng thường dễ đọc; từ có số giữ nguyên (4WD, GAZ69).
const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'via'])
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

export function durationText(t: typeof en, label: string | null | undefined, minutes: number | null | undefined) {
  if (label) return label
  if (minutes) return t.hours(Math.round((minutes / 60) * 10) / 10)
  return null
}
