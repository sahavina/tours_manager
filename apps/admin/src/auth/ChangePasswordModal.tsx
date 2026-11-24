// Đổi mật khẩu của chính mình khi đang đăng nhập (người dùng tự gõ, không gửi đi đâu ngoài máy chủ đăng nhập).
import { App, Form, Input, Modal } from 'antd'
import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const submit = async (v: { password: string }) => {
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: v.password })
    setSaving(false)
    if (error) {
      message.error(/different/i.test(error.message) ? 'Mật khẩu mới phải khác mật khẩu cũ.'
        : /reauth|recent/i.test(error.message) ? 'Phiên đăng nhập đã lâu, hãy đăng xuất rồi đăng nhập lại trước khi đổi mật khẩu.'
          : 'Không đổi được mật khẩu, thử lại.')
      return
    }
    message.success('Đã đổi mật khẩu')
    form.resetFields()
    onClose()
  }
  return (
    <Modal open={open} title="Đổi mật khẩu" okText="Lưu mật khẩu" cancelText="Hủy" confirmLoading={saving}
      onOk={() => form.submit()} onCancel={() => { form.resetFields(); onClose() }} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item name="password" label="Mật khẩu mới" rules={[{ required: true, min: 8, message: 'Ít nhất 8 ký tự' }]}>
          <Input.Password autoComplete="new-password" autoFocus />
        </Form.Item>
        <Form.Item name="confirm" label="Nhập lại mật khẩu mới" dependencies={['password']} rules={[
          { required: true, message: 'Nhập lại mật khẩu' },
          ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('Hai mật khẩu chưa khớp'))) }),
        ]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
