-- Email cho khách khi yêu cầu đặt từ website được xác nhận hoặc bị hủy/từ chối.
--
-- Trigger trên bookings: booking website (external_ref WEB-...) đổi trạng thái sang confirmed hoặc cancelled thì
-- thêm outbox 'website.status'. Worker gửi email theo cấu hình Email (bật gửi + gửi khách), ghi email_log.

alter table public.email_log drop constraint email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('staff_new_booking', 'customer_ack', 'customer_confirmed', 'customer_cancelled', 'test'));

create function public._web_booking_status_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status in ('confirmed', 'cancelled')
     and coalesce(new.external_ref, '') like 'WEB-%' then
    insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
    values (new.organization_id, 'website.status', new.id::text,
      jsonb_build_object('code', new.code, 'from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
create trigger bookings_web_status_event after update of status on public.bookings
  for each row execute function public._web_booking_status_event();
revoke all on function public._web_booking_status_event() from public, anon, authenticated;

-- Thêm loại việc 'status' (xác nhận/hủy). Phần booking và kiểm tra giống email báo yêu cầu mới.
create or replace function public.worker_email_job(p_outbox bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e public.outbox_events%rowtype;
  v_org public.organizations%rowtype;
  v_booking public.bookings%rowtype;
begin
  select * into e from public.outbox_events where id = p_outbox;
  if e.id is null or e.topic not in ('booking.created', 'email.test', 'website.status') then
    return null;
  end if;
  select * into v_org from public.organizations where id = e.organization_id;
  if e.topic = 'email.test' then
    return jsonb_build_object('kind', 'test', 'org_name', v_org.name, 'settings', v_org.email_settings, 'to', e.payload ->> 'to');
  end if;
  if not coalesce((v_org.email_settings ->> 'enabled')::boolean, false) then
    return null;
  end if;
  select * into v_booking from public.bookings where id = public._uuid_or_null(e.aggregate_id);
  -- Chỉ yêu cầu đặt từ website (mã tham chiếu WEB-...); booking từ kênh khác có quy trình riêng.
  if v_booking.id is null or coalesce(v_booking.external_ref, '') not like 'WEB-%' then
    return null;
  end if;
  return jsonb_build_object(
    'kind', case when e.topic = 'website.status' then 'status' else 'booking' end,
    'status_to', e.payload ->> 'to', 'status_from', e.payload ->> 'from',
    'org_name', v_org.name, 'settings', v_org.email_settings,
    'contact', coalesce(v_org.storefront_settings -> 'contact', '{}'::jsonb),
    'booking', jsonb_build_object(
      'id', v_booking.id, 'code', v_booking.code, 'reference', v_booking.external_ref, 'status', v_booking.status,
      'lead_name', v_booking.lead_name, 'lead_email', v_booking.lead_email, 'lead_phone', v_booking.lead_phone,
      'note', v_booking.special_requests, 'amount', v_booking.gross_amount, 'currency', v_booking.currency,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'tour', t.name, 'option', coalesce(o.public_name, o.name), 'date', i.local_date, 'time', to_char(i.local_time, 'HH24:MI'),
          'pax', i.pax, 'pax_total', i.pax_total, 'hotel', p.hotel_name) order by i.local_date, i.local_time)
        from public.booking_items i
        join public.tours t on t.id = i.tour_id
        left join public.tour_options o on o.id = i.tour_option_id
        left join public.booking_pickups p on p.booking_item_id = i.id
        where i.booking_id = v_booking.id), '[]'::jsonb)),
    'sent', coalesce((select jsonb_agg(l.kind || ':' || l.recipient) from public.email_log l
                      where l.outbox_id = p_outbox and l.status = 'sent'), '[]'::jsonb));
end $$;

-- Nhật ký gửi gắn với booking cho cả email xác nhận/hủy.
create or replace function public.worker_email_log(
  p_outbox bigint, p_kind text, p_to text, p_subject text, p_status text, p_error text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.outbox_events%rowtype;
begin
  select * into e from public.outbox_events where id = p_outbox;
  if e.id is null then
    return;
  end if;
  insert into public.email_log (organization_id, outbox_id, booking_id, kind, recipient, subject, status, error)
  values (e.organization_id, p_outbox, case when e.topic in ('booking.created', 'website.status') then public._uuid_or_null(e.aggregate_id) end,
    p_kind, left(p_to, 200), left(p_subject, 300), p_status, left(p_error, 1000))
  on conflict do nothing;
end $$;
