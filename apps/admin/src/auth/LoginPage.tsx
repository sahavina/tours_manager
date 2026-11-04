import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { isConfigured, supabase } from '../lib/supabase'

export function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (values: { email: string; password: string }) => {
    setLoading(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword(values)
    setLoading(false)
    if (err) setError(/fetch/i.test(err.message) ? 'Không kết nối được máy chủ dữ liệu.' : 'Email hoặc mật khẩu không đúng.')
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>SAHA Tour Hub</Typography.Title>
        <Typography.Paragraph type="secondary">Quản lý booking và điều hành tour đa kênh</Typography.Paragraph>
        {!isConfigured && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }}
            message="Thiếu cấu hình" description="Chưa đặt VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY cho app." />
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email', message: 'Nhập email hợp lệ' }]}>
            <Input autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, message: 'Nhập mật khẩu' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>Đăng nhập</Button>
        </Form>
      </Card>
    </div>
  )
}
