-- Trang đặt tour cho khách (apps/storefront). Khách chưa đăng nhập (role anon) chỉ gọi được bốn hàm dưới đây,
-- không đọc thẳng bảng nào. Yêu cầu đặt tạo booking "chờ xác nhận" và giữ chỗ ngay; nhân viên xác nhận
-- hoặc hủy trong trang quản trị. Không có thanh toán trực tuyến.

-- 1. Trường công khai. Nội dung do doanh nghiệp nhập; không có gì được điền sẵn.
alter table public.tours
  add column is_published boolean not null default false,
  add column image_url text check (image_url is null or (image_url ~ '^https://[^[:space:]]+$' and length(image_url) <= 500));
alter table public.tour_options
  add column is_published boolean not null default true,
  add column public_name text check (public_name is null or length(public_name) <= 120),
  add column price_adult numeric(12, 2) check (price_adult is null or price_adult >= 0),
  add column price_child numeric(12, 2) check (price_child is null or price_child >= 0),
  add column price_currency char(3) not null default 'USD' check (price_currency ~ '^[A-Z]{3}$');

-- 2. Nguồn "Website" là một kết nối kênh riêng, để booking hiện đúng nguồn trong danh sách và bảng kênh.
create function public._website_connection(p_org uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.channel_connections
  where organization_id = p_org and channel = 'other' and account_name = 'Website';
  if v_id is null then
    insert into public.channel_connections (organization_id, channel, account_name, mode, status, approval_status)
    values (p_org, 'other', 'Website', 'production', 'not_configured', 'not_required')
    on conflict (organization_id, channel, account_name) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.channel_connections
      where organization_id = p_org and channel = 'other' and account_name = 'Website';
    end if;
  end if;
  return v_id;
end $$;

-- Doanh nghiệp theo slug, chỉ khi có ít nhất một tour đang công khai.
create function public._storefront_org(p_slug text) returns public.organizations
language sql stable security definer set search_path = '' as $$
  select o.* from public.organizations o
  where o.slug = coalesce(p_slug, '')
    and exists (select 1 from public.tours t where t.organization_id = o.id and t.is_published and t.is_active and t.deleted_at is null)
$$;

-- Gói đang bán công khai.
create function public._storefront_option(p_org uuid, p_option_code text)
returns table (option_id uuid, tour_id uuid, tz text, price_adult numeric, price_child numeric, currency text, is_private boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, t.id, t.default_timezone, o.price_adult, o.price_child, o.price_currency::text, o.is_private
  from public.tour_options o join public.tours t on t.id = o.tour_id
  where o.organization_id = p_org and o.code = coalesce(p_option_code, '')
    and o.is_published and o.is_active and o.deleted_at is null
    and t.is_published and t.is_active and t.deleted_at is null
$$;

-- 3. Đọc công khai.
create function public.public_storefront(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
begin
  if v_o.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'name', v_o.name, 'tours', coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', t.code, 'name', t.name, 'summary', left(coalesce(t.description, ''), 220),
      'destination', t.destination, 'duration_minutes', t.duration_minutes, 'image_url', t.image_url,
      'price_from', (select min(o.price_adult) from public.tour_options o where o.tour_id = t.id
                       and o.is_published and o.is_active and o.deleted_at is null),
      'currency', (select min(o.price_currency) from public.tour_options o where o.tour_id = t.id
                       and o.is_published and o.is_active and o.deleted_at is null and o.price_adult is not null),
      'has_private', exists (select 1 from public.tour_options o where o.tour_id = t.id and o.is_private
                       and o.is_published and o.is_active and o.deleted_at is null),
      'has_transfer', exists (select 1 from public.tour_options o where o.tour_id = t.id and o.has_transfer
                       and o.is_published and o.is_active and o.deleted_at is null)
    ) order by t.name)
    from public.tours t
    where t.organization_id = v_o.id and t.is_published and t.is_active and t.deleted_at is null
  ), '[]'::jsonb));
end $$;

create function public.public_tour(p_slug text, p_tour_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
  v_t public.tours%rowtype;
begin
  select * into v_t from public.tours
  where organization_id = v_o.id and code = coalesce(p_tour_code, '') and is_published and is_active and deleted_at is null;
  if v_o.id is null or v_t.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true,
    'tour', jsonb_build_object('code', v_t.code, 'name', v_t.name, 'description', v_t.description,
      'destination', v_t.destination, 'duration_minutes', v_t.duration_minutes, 'image_url', v_t.image_url,
      'itinerary', v_t.itinerary, 'inclusions', to_jsonb(v_t.inclusions), 'exclusions', to_jsonb(v_t.exclusions),
      'joining_instructions', v_t.joining_instructions, 'timezone', v_t.default_timezone),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('code', o.code, 'name', coalesce(o.public_name, o.name),
        'is_private', o.is_private, 'has_transfer', o.has_transfer, 'language', o.language,
        'duration_minutes', coalesce(o.duration_minutes, v_t.duration_minutes),
        'price_adult', o.price_adult, 'price_child', o.price_child, 'currency', o.price_currency) order by o.price_adult nulls last, o.code)
      from public.tour_options o
      where o.tour_id = v_t.id and o.is_published and o.is_active and o.deleted_at is null
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'min_age', c.min_age, 'max_age', c.max_age,
        'counts_as_seat', c.counts_as_seat) order by c.sort_order, c.code)
      from public.traveler_categories c where c.organization_id = v_o.id
    ), '[]'::jsonb));
end $$;

-- Giờ còn chỗ của một gói: chỗ trống của CHUYẾN trống nhất ở mỗi giờ (booking không bị tách), chỉ chuyến
-- đang mở bán, chưa qua hạn chót. Tối đa 62 ngày một lần hỏi.
create function public.public_availability(p_slug text, p_option_code text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
  v_opt record;
begin
  select * into v_opt from public._storefront_option(v_o.id, p_option_code);
  if v_o.id is null or v_opt.option_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  return jsonb_build_object('ok', true, 'slots', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.local_date, 'time', to_char(x.local_time, 'HH24:MI'), 'available', x.available)
      order by x.local_date, x.local_time)
    from (
      select d.local_date, d.local_time, max(greatest(0, public._pool_available(d.inventory_pool_id)))::int as available
      from public.departures d
      where d.organization_id = v_o.id and d.tour_id = v_opt.tour_id
        and (d.tour_option_id = v_opt.option_id or d.tour_option_id is null)
        and d.status = 'scheduled' and d.sale_open and now() < coalesce(d.cutoff_at, d.starts_at)
        and d.local_date between p_from and p_to
      group by d.local_date, d.local_time
    ) x
  ), '[]'::jsonb));
end $$;

-- 4. Gửi yêu cầu đặt.
create function public.public_booking_request(
  p_slug text, p_option_code text, p_date date, p_time time, p_pax jsonb, p_contact jsonb,
  p_hotel text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
  v_opt record;
  v_name text := btrim(coalesce(p_contact ->> 'name', ''));
  v_email text := lower(btrim(coalesce(p_contact ->> 'email', '')));
  v_phone text := nullif(btrim(coalesce(p_contact ->> 'phone', '')), '');
  v_pax jsonb := '{}'::jsonb;
  v_key text;
  v_val text;
  v_total int := 0;
  v_seats int;
  v_dep record;
  v_conn uuid;
  v_customer uuid;
  v_booking uuid;
  v_item uuid;
  v_code text;
  v_ref text;
  v_place text;
  v_gross numeric;
begin
  select * into v_opt from public._storefront_option(v_o.id, p_option_code);
  if v_o.id is null or v_opt.option_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- Kiểm tra dữ liệu khách nhập.
  if length(v_name) < 2 or length(v_name) > 100 then
    return jsonb_build_object('ok', false, 'code', 'invalid_name');
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_email');
  end if;
  if v_phone is not null and length(v_phone) > 40 then
    return jsonb_build_object('ok', false, 'code', 'invalid_phone');
  end if;
  if length(coalesce(p_hotel, '')) > 200 or length(coalesce(p_note, '')) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'too_long');
  end if;
  if jsonb_typeof(p_pax) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_pax');
  end if;
  for v_key, v_val in select * from jsonb_each_text(p_pax) loop
    if v_val !~ '^\d{1,2}$' or not exists (
      select 1 from public.traveler_categories c where c.organization_id = v_o.id and c.code = v_key) then
      return jsonb_build_object('ok', false, 'code', 'invalid_pax');
    end if;
    if v_val::int > 0 then
      v_pax := v_pax || jsonb_build_object(v_key, v_val::int);
      v_total := v_total + v_val::int;
    end if;
  end loop;
  v_seats := public._pax_seats(v_o.id, v_pax);
  if v_total < 1 or v_total > 20 or v_seats < 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_pax');
  end if;
  if p_date is null or p_time is null
     or p_date < (now() at time zone v_opt.tz)::date or p_date > (now() at time zone v_opt.tz)::date + 365 then
    return jsonb_build_object('ok', false, 'code', 'invalid_date');
  end if;

  -- Chống gửi tràn: tối đa 3 yêu cầu đang chờ mỗi email trong 24 giờ, 60 yêu cầu website mỗi giờ.
  v_conn := public._website_connection(v_o.id);
  if (select count(*) from public.bookings b where b.connection_id = v_conn and b.lead_email = v_email
        and b.status = 'pending' and b.created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.bookings b where b.connection_id = v_conn
        and b.created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'code', 'too_many_requests');
  end if;

  -- Chọn chuyến đủ chỗ cho cả nhóm, khóa nguồn chỗ rồi xếp; không đủ thì báo hết chỗ.
  for v_dep in
    select d.id, d.inventory_pool_id, d.local_date, d.local_time, d.timezone
    from public.departures d
    where d.organization_id = v_o.id and d.tour_id = v_opt.tour_id
      and (d.tour_option_id = v_opt.option_id or d.tour_option_id is null)
      and d.status = 'scheduled' and d.sale_open and now() < coalesce(d.cutoff_at, d.starts_at)
      and d.local_date = p_date and d.local_time = p_time
    order by (d.tour_option_id is null), d.slot_no, d.id
  loop
    perform public._lock_pools(array[v_dep.inventory_pool_id]);
    continue when public._pool_available(v_dep.inventory_pool_id) < v_seats;

    v_gross := case when v_opt.price_adult is null then null else (
      select sum(e.value::int * case e.key
        when 'adult' then v_opt.price_adult
        when 'child' then coalesce(v_opt.price_child, v_opt.price_adult)
        when 'infant' then 0
        else v_opt.price_adult end)
      from jsonb_each_text(v_pax) e) end;
    v_ref := 'WEB-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));

    insert into public.customers (organization_id, full_name, email, phone, source)
    values (v_o.id, v_name, v_email, v_phone, 'website') returning id into v_customer;
    v_code := public._next_booking_code(v_o.id);
    insert into public.bookings
      (organization_id, code, source, connection_id, external_ref, customer_id, lead_name, lead_email, lead_phone,
       special_requests, status, gross_amount, currency, sync_status, needs_action, action_reason)
    values (v_o.id, v_code, 'channel', v_conn, v_ref, v_customer, v_name, v_email, v_phone,
      nullif(btrim(coalesce(p_note, '')), ''), 'pending', v_gross, case when v_gross is not null then v_opt.currency end,
      'manual', true, 'Yêu cầu đặt từ website, chờ xác nhận')
    returning id into v_booking;
    insert into public.booking_items
      (organization_id, booking_id, tour_option_id, tour_id, local_date, local_time, timezone, pax, pax_total, seats, amount, currency)
    values (v_o.id, v_booking, v_opt.option_id, v_opt.tour_id, v_dep.local_date, v_dep.local_time, v_dep.timezone,
      v_pax, v_total, v_seats, v_gross, case when v_gross is not null then v_opt.currency end)
    returning id into v_item;
    v_place := public._place_item(v_item, v_dep.id, v_seats);
    if v_place <> 'ok' then
      raise exception 'place_failed: %', v_place;
    end if;
    if coalesce(btrim(p_hotel), '') <> '' then
      insert into public.booking_pickups (booking_item_id, organization_id, hotel_name)
      values (v_item, v_o.id, btrim(p_hotel));
    end if;
    insert into public.booking_financials (booking_id, organization_id, currency, source)
    values (v_booking, v_o.id, case when v_gross is not null then v_opt.currency end, 'manual');
    insert into public.booking_changes (organization_id, booking_id, change_type, summary, source)
    values (v_o.id, v_booking, 'created', 'Khách gửi yêu cầu đặt từ website', 'channel');
    perform public._recompute_booking_ops(v_booking);
    -- _recompute_booking_ops không đặt lại cờ chờ xử lý của yêu cầu website.
    update public.bookings set needs_action = true, action_reason = 'Yêu cầu đặt từ website, chờ xác nhận'
    where id = v_booking;
    insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
    values (v_o.id, 'booking.created', v_booking::text,
              jsonb_build_object('code', v_code, 'needs_action', true, 'reasons', jsonb_build_array('Yêu cầu đặt từ website, chờ xác nhận'))),
           (v_o.id, 'availability.changed', v_dep.id::text, '{}');
    return jsonb_build_object('ok', true, 'booking_code', v_code, 'reference', v_ref,
      'date', v_dep.local_date, 'time', to_char(v_dep.local_time, 'HH24:MI'), 'amount', v_gross,
      'currency', case when v_gross is not null then v_opt.currency end);
  end loop;
  return jsonb_build_object('ok', false, 'code', 'no_availability');
end $$;

revoke all on function public._website_connection(uuid), public._storefront_org(text), public._storefront_option(uuid, text),
  public.public_storefront(text), public.public_tour(text, text), public.public_availability(text, text, date, date),
  public.public_booking_request(text, text, date, time, jsonb, jsonb, text, text)
from public, anon, authenticated;
grant execute on function public.public_storefront(text), public.public_tour(text, text),
  public.public_availability(text, text, date, date),
  public.public_booking_request(text, text, date, time, jsonb, jsonb, text, text)
to anon, authenticated, service_role;
