import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Phải import trước mọi thứ chạm tới antd: message/Modal.confirm của antd v5 dùng ReactDOM.render, đã
// bị gỡ khỏi React 19. Thiếu bản vá này thì toast im lặng không hiện và onOk không bao giờ chạy.
import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'
import './app/app.css'
import { App } from './app/App'

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
