-- Email thông báo yêu cầu đặt tour từ website.
--
-- organizations.email_settings: cấu hình SMTP và người nhận, doanh nghiệp sửa trong admin (Cài đặt > Email).
-- Mật khẩu SMTP KHÔNG lưu ở đây: worker đọc từ biến môi trường SMTP_PASSWORD trên server.
--   {"enabled": true, "smtp_host": "smtp.gmail.com", "smtp_port": 465, "smtp_secure": true, "smtp_user": "...",
--    "from_name": "Hanoi Jeep", "from_email": "...", "staff_to": ["..."], "notify_staff": true, "notify_customer": true}
--
-- Worker xử lý outbox 'booking.created' (booking website, external_ref WEB-...) và 'email.test' (nút Gửi thử),
-- gửi mail rồi ghi email_log. Mỗi (outbox, loại, người nhận) chỉ gửi một lần.

alter table public.organizations
  add column email_settings jsonb not null default '{}' check (jsonb_typeof(email_settings) = 'object');
grant update (email_settings) on public.organizations to authenticated;

create table public.email_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  outbox_id bigint,
  booking_id uuid references public.bookings (id) on delete set null,
  kind text not null check (kind in ('staff_new_booking', 'customer_ack', 'test')),
  recipient text not null check (length(recipient) <= 200),
  subject text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  error text check (error is null or length(error) <= 1000),
  created_at timestamptz not null default now()
);
create unique index email_log_once_uq on public.email_log (outbox_id, kind, recipient) where status = 'sent';
create index email_log_org_idx on public.email_log (organization_id, created_at desc);
alter table public.email_log enable row level security;
create policy email_log_read on public.email_log for select to authenticated
  using (public.has_org_permission(organization_id, 'org.manage'));
grant select on public.email_log to authenticated;
grant all on public.email_log to service_role;

-- Nút "Gửi thử" trong admin: đưa một việc vào outbox để worker gửi bằng cấu hình hiện tại.
create function public.email_send_test(p_org uuid, p_to text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_to text := lower(btrim(coalesce(p_to, '')));
begin
  perform public._require(p_org, 'org.manage');
  if v_to !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_to) > 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_email');
  end if;
  insert into public.outbox_events (organization_id, topic, payload) values (p_org, 'email.test', jsonb_build_object('to', v_to));
  return jsonb_build_object('ok', true);
end $$;

-- Dữ liệu để worker soạn email cho một bản ghi outbox. null nếu không cần gửi gì.
create function public.worker_email_job(p_outbox bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e public.outbox_events%rowtype;
  v_org public.organizations%rowtype;
  v_booking public.bookings%rowtype;
begin
  select * into e from public.outbox_events where id = p_outbox;
  if e.id is null or e.topic not in ('booking.created', 'email.test') then
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
    'kind', 'booking', 'org_name', v_org.name, 'settings', v_org.email_settings,
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

create function public.worker_email_log(
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
  values (e.organization_id, p_outbox, case when e.topic = 'booking.created' then public._uuid_or_null(e.aggregate_id) end,
    p_kind, left(p_to, 200), left(p_subject, 300), p_status, left(p_error, 1000))
  on conflict do nothing;
end $$;

revoke all on function public.email_send_test(uuid, text), public.worker_email_job(bigint),
  public.worker_email_log(bigint, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.email_send_test(uuid, text) to authenticated, service_role;
grant execute on function public.worker_email_job(bigint), public.worker_email_log(bigint, text, text, text, text, text) to service_role;
-- Tài khoản worker riêng trên server tự cài (nếu có).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'tourhub_worker') then
    grant execute on function public.worker_email_job(bigint), public.worker_email_log(bigint, text, text, text, text, text) to tourhub_worker;
  end if;
end $$;
