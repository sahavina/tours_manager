-- Xử lý yêu cầu đặt từ trang khách, và hai lỗi phát hiện khi làm việc này.

-- 1. Xác nhận hoặc từ chối yêu cầu website. Website là kênh của chính doanh nghiệp: không có gì phải làm tay
--    trên kênh ngoài. Nhân viên tự liên hệ khách (hệ thống chưa gửi email).
create function public._is_website_booking(p_booking public.bookings) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.channel_connections c
    where c.id = p_booking.connection_id and c.channel = 'other' and c.account_name = 'Website')
$$;

create function public.website_request_decide(p_booking uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_b from public.bookings where id = p_booking for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'booking_not_found');
  end if;
  perform public._require(v_b.organization_id, 'booking.manage');
  if not public._is_website_booking(v_b) or v_b.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'not_pending_website');
  end if;

  if p_decision = 'confirm' then
    update public.bookings set status = 'confirmed', needs_action = false, action_reason = null where id = p_booking;
    insert into public.booking_status_history (organization_id, booking_id, field, from_value, to_value, source, actor_id)
    values (v_b.organization_id, p_booking, 'status', 'pending', 'confirmed', 'internal', (select auth.uid()));
    insert into public.booking_changes (organization_id, booking_id, change_type, summary, source, actor_id)
    values (v_b.organization_id, p_booking, 'confirmed',
      'Xác nhận yêu cầu đặt từ website' || coalesce('. Ghi chú: ' || v_note, ''), 'internal', (select auth.uid()));
    perform public._recompute_booking_ops(p_booking);
    perform public._audit(v_b.organization_id, 'website_confirm', 'bookings', p_booking::text, null, jsonb_build_object('note', v_note));
    return jsonb_build_object('ok', true, 'status', 'confirmed');
  elsif p_decision = 'reject' then
    perform public._cancel_booking(p_booking, 'internal');
    update public.bookings set needs_action = false, action_reason = null where id = p_booking;
    insert into public.booking_changes (organization_id, booking_id, change_type, summary, source, actor_id)
    values (v_b.organization_id, p_booking, 'rejected',
      'Từ chối yêu cầu đặt từ website, đã trả chỗ' || coalesce('. Lý do: ' || v_note, ''), 'internal', (select auth.uid()));
    perform public._audit(v_b.organization_id, 'website_reject', 'bookings', p_booking::text, null, jsonb_build_object('note', v_note));
    return jsonb_build_object('ok', true, 'status', 'cancelled');
  end if;
  return jsonb_build_object('ok', false, 'code', 'invalid_input');
end $$;

-- 2. Hủy nội bộ một booking website không cần "hủy tay trên kênh" (trước đây báo nhầm như kênh ngoài).
create or replace function public.cancel_booking_internal(p_booking uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  v_did boolean;
  v_external boolean;
begin
  select * into v_b from public.bookings where id = p_booking;
  perform public._require(v_b.organization_id, 'booking.manage');
  v_external := v_b.connection_id is not null and not public._is_website_booking(v_b);
  v_did := public._cancel_booking(p_booking, 'internal');
  if v_did and v_external then
    insert into public.booking_changes
      (organization_id, booking_id, change_type, summary, source, actor_id, channel_request_status)
    values (v_b.organization_id, p_booking, 'cancel_request',
      'Đã hủy nội bộ, cần hủy tay trên kênh. Lý do: ' || coalesce(p_reason, '(không ghi)'),
      'internal', (select auth.uid()), 'manual_required');
  end if;
  perform public._audit(v_b.organization_id, 'cancel', 'bookings', p_booking::text, null, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true, 'changed', v_did, 'channel_action_required', v_external);
end $$;

-- 3. Sự kiện "availability.changed" có nơi ghi mã chuyến, có nơi ghi mã booking (hủy, tạo thủ công).
--    Worker báo chỗ cho GetYourGuide chỉ hiểu mã chuyến nên bỏ sót các lần hủy. Nhận cả hai.
create or replace function public.worker_gyg_availability(p_departure uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with deps as (
    select d.* from public.departures d
    where d.id = p_departure
       or d.id in (select i.departure_id from public.booking_items i where i.booking_id = p_departure and i.departure_id is not null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'connection_id', c.id, 'product_id', m.external_product_code,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('local_date', x.local_date, 'local_time', x.local_time,
        'starts_at', x.starts_at, 'vacancies', x.vacancies)), '[]'::jsonb)
      from (
        select g.local_date, g.local_time, min(g.starts_at) as starts_at, max(g.available) as vacancies
        from public._gyg_departures(m.tour_option_id, d.starts_at, d.starts_at) g
        group by g.local_date, g.local_time
      ) x
    ))), '[]'::jsonb)
  from deps d
  join public.channel_connections c on c.organization_id = d.organization_id
    and c.channel = 'getyourguide' and c.is_api and c.mode <> 'mock' and c.status <> 'disabled'
  join public.channel_product_mappings m on m.connection_id = c.id and m.external_option_code = '' and m.is_verified
  join public.tour_options o on o.id = m.tour_option_id and o.tour_id = d.tour_id
    and (d.tour_option_id is null or d.tour_option_id = o.id)
$$;

revoke all on function public._is_website_booking(public.bookings), public.website_request_decide(uuid, text, text),
  public.cancel_booking_internal(uuid, text), public.worker_gyg_availability(uuid)
from public, anon, authenticated;
grant execute on function public.website_request_decide(uuid, text, text), public.cancel_booking_internal(uuid, text)
to authenticated, service_role;
