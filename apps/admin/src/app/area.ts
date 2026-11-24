// Hai khu của trang quản trị: "Điều hành" (vận hành, booking, tour) và "Website" (trang đặt tour cho khách).
// Khu xác định theo đường dẫn: /web/... là Website. Nhớ khu dùng gần nhất để lần sau mở lại đúng khu.
export type Area = 'ops' | 'web'
const KEY = 'admin.area'

export const areaOf = (pathname: string): Area => (pathname === '/web' || pathname.startsWith('/web/') ? 'web' : 'ops')

export function lastArea(): Area | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'web' || v === 'ops' ? v : null
  } catch {
    return null
  }
}

export function rememberArea(a: Area) {
  try {
    localStorage.setItem(KEY, a)
  } catch {
    /* chỉ là tiện ích */
  }
}
