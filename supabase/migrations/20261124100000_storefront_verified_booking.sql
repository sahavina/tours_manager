-- Chống bot cho yêu cầu đặt tour từ website.
--
-- Khi storefront_settings.require_verified_booking = true, public_booking_request chỉ nhận lời gọi bằng vai
-- service_role: Worker của trang đặt tour kiểm tra Cloudflare Turnstile trước rồi mới gọi hàm bằng khóa service.
-- Lời gọi thẳng bằng khóa công khai (anon) trả về 'verification_required', không tạo booking, không giữ chỗ.
-- Chưa bật thì hành vi như cũ, nên dev local và doanh nghiệp chưa cấu hình Turnstile không bị ảnh hưởng.
--
-- Cách làm: đổi tên hàm cũ thành _public_booking_request_core (giữ nguyên thân hàm) và đặt một hàm mỏng cùng
-- chữ ký ở tên cũ để kiểm tra rồi chuyển tiếp.

alter function public.public_booking_request(text, text, date, time, jsonb, jsonb, text, text)
  rename to _public_booking_request_core;
revoke all on function public._public_booking_request_core(text, text, date, time, jsonb, jsonb, text, text)
  from public, anon, authenticated;

create function public.public_booking_request(
  p_slug text, p_option_code text, p_date date, p_time time, p_pax jsonb, p_contact jsonb,
  p_hotel text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_required boolean;
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  select coalesce((o.storefront_settings ->> 'require_verified_booking')::boolean, false) into v_required
  from public.organizations o where o.slug = coalesce(p_slug, '');
  if coalesce(v_required, false) and v_role <> 'service_role' then
    return jsonb_build_object('ok', false, 'code', 'verification_required');
  end if;
  return public._public_booking_request_core(p_slug, p_option_code, p_date, p_time, p_pax, p_contact, p_hotel, p_note);
end $$;

revoke all on function public.public_booking_request(text, text, date, time, jsonb, jsonb, text, text) from public;
grant execute on function public.public_booking_request(text, text, date, time, jsonb, jsonb, text, text)
  to anon, authenticated, service_role;
