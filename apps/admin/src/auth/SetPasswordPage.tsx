// Màn hình đặt mật khẩu: người dùng mở link đặt mật khẩu (tài khoản mới hoặc đặt lại) thì vào đây trước.
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function SetPasswordPage({ email, onDone }: { email?: string; onDone: () => void }) {
  const { message } = App.useApp()
  const [saving, setSaving] = useState(false)
  const submit = async (v: { password: string }) => {
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: v.password })
    setSaving(false)
    if (error) return message.error(error.message.includes('different') ? 'Mật khẩu mới phải khác mật khẩu cũ.' : 'Không đặt được mật khẩu, thử lại.')
    message.success('Đã đặt mật khẩu. Lần sau đăng nhập bằng email và mật khẩu này.')
    onDone()
  }
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f5f7f8', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 400 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>Đặt mật khẩu</Typography.Title>
        {email && <Typography.Paragraph type="secondary">Tài khoản: <b>{email}</b></Typography.Paragraph>}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="password" label="Mật khẩu mới" rules={[{ required: true, min: 8, message: 'Ít nhất 8 ký tự' }]}>
            <Input.Password autoComplete="new-password" autoFocus />
          </Form.Item>
          <Form.Item name="confirm" label="Nhập lại mật khẩu" dependencies={['password']} rules={[
            { required: true, message: 'Nhập lại mật khẩu' },
            ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('Hai mật khẩu chưa khớp'))) }),
          ]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>Lưu mật khẩu</Button>
        </Form>
      </Card>
    </div>
  )
}
