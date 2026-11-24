import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Phải import trước mọi thứ chạm tới antd: message/Modal.confirm của antd v5 dùng ReactDOM.render, đã
// bị gỡ khỏi React 19. Thiếu bản vá này thì toast im lặng không hiện và onOk không bao giờ chạy.
import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'
import './app/app.css'
import { App } from './app/App'

// Sau mỗi lần deploy, tab đang mở vẫn giữ trang cũ và đòi các file đã bị thay (server trả về HTML, trang trắng).
// Khi tải một phần trang thất bại thì tải lại cả trang một lần để lấy bản mới; không lặp vô hạn (cách nhau 30 giây).
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('admin.reloadAt') ?? 0)
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem('admin.reloadAt', String(Date.now()))
  } catch {
    /* không có sessionStorage thì vẫn tải lại */
  }
  e.preventDefault()
  window.location.reload()
})

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
