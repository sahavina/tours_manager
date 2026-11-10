-- Cổng GetYourGuide Supplier API (bản thử). GetYourGuide gọi vào cổng HTTP, cổng gọi các hàm dưới đây bằng
-- service_role. Toàn bộ luật chỗ, chống trùng, retry nằm ở đây để cổng chỉ dịch định dạng.
--
-- Quy ước:
--   productId của GetYourGuide = external_product_code của ánh xạ ĐÃ KIỂM TRA, external_option_code rỗng.
--   Mỗi productId ứng với một gói (tour option), đúng như tài liệu GetYourGuide.
--   Booking không bao giờ bị tách: số chỗ báo cho GetYourGuide là số chỗ trống lớn nhất của MỘT chuyến
--   ở giờ đó (không cộng các chuyến 1, 2, 3), nên mọi lần giữ chỗ được báo còn chỗ đều xếp được.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Sửa lỗi: xác nhận booking từ chỗ giữ phải xếp vào ĐÚNG chuyến đã giữ.
-- _resolve_item chọn chuyến còn chỗ có số nhỏ nhất. Khi chỗ giữ lấp kín chuyến 1, lúc xác nhận chuyến 1
-- trông như hết chỗ nên bị chọn sang chuyến 2, chỗ giữ không được chuyển và channel_book báo hết chỗ sai.
-- channel_book đặt chuyến của chỗ giữ vào biến giao dịch, _resolve_item ưu tiên chuyến đó nếu nó hợp lệ.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public._resolve_item(
  p_org uuid, p_connection uuid, p_product text, p_option text, p_date date, p_time time,
  out o_option uuid, out o_tour uuid, out o_departure uuid, out o_time time, out o_tz text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_map public.channel_product_mappings%rowtype;
  v_hold_departure text := nullif(current_setting('tourhub.hold_departure', true), '');
begin
  o_time := p_time;
  select * into v_map from public.channel_product_mappings
  where organization_id = p_org and connection_id = p_connection
    and external_product_code = coalesce(p_product, '')
    and external_option_code = coalesce(p_option, '');

  if not found then
    -- Đưa vào hàng chờ ghép mã để người có quyền xử lý.
    if p_connection is not null and coalesce(p_product, '') <> '' then
      insert into public.channel_product_mappings
        (organization_id, connection_id, external_product_code, external_option_code)
      values (p_org, p_connection, p_product, coalesce(p_option, ''))
      on conflict do nothing;
    end if;
    return;
  end if;
  if not v_map.is_verified then
    return;
  end if;

  o_option := v_map.tour_option_id;
  select o.tour_id, t.default_timezone into o_tour, o_tz
  from public.tour_options o join public.tours t on t.id = o.tour_id
  where o.id = o_option;
  o_time := coalesce(p_time, v_map.default_local_time);

  if p_date is null or o_time is null then
    return;
  end if;

  select d.id, d.timezone into o_departure, o_tz
  from public.departures d
  where d.organization_id = p_org and d.tour_id = o_tour and d.status = 'scheduled'
    and d.local_date = p_date and d.local_time = o_time
    and (d.tour_option_id = o_option or d.tour_option_id is null)
  -- Chuyến của chỗ giữ đang được xác nhận luôn đứng đầu; còn lại như cũ: chuyến riêng của gói trước chuyến
  -- chung của tour, rồi chuyến cùng giờ còn chỗ có số nhỏ nhất.
  order by (d.id::text is distinct from v_hold_departure), (d.tour_option_id is null),
    (public._pool_available(d.inventory_pool_id) <= 0), d.slot_no, d.id
  limit 1;
  if not found then
    select t.default_timezone into o_tz from public.tours t where t.id = o_tour;
    o_departure := null;
  end if;
end $$;

create or replace function public.channel_book(p_connection uuid, p_reference text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  v_h public.inventory_holds%rowtype;
  v_code text;
  v_result jsonb;
  v_data jsonb := p_data;
  v_errors text[];
begin
  select * into v_h from public.inventory_holds
  where organization_id = v_c.organization_id and connection_id = v_c.id and reference = p_reference;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'hold_not_found');
  end if;

  perform public._lock_pools(array[v_h.inventory_pool_id]);
  select * into v_h from public.inventory_holds where id = v_h.id for update;

  if v_h.status = 'converted' then
    select code into v_code from public.bookings where id = v_h.booking_id;
    return jsonb_build_object('ok', true, 'code', 'existing', 'duplicate', true,
      'booking_id', v_h.booking_id, 'booking_code', v_code);
  end if;
  if v_h.status <> 'active' or v_h.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'hold_expired');
  end if;

  v_errors := public._validate_booking_data(v_data);
  if cardinality(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'errors', to_jsonb(v_errors));
  end if;

  begin
    perform set_config('tourhub.hold_departure', v_h.departure_id::text, true);
    v_result := public._apply_booking_data(v_c, v_data, 'channel', null,
      (p_data ->> 'source_at')::timestamptz, (p_data ->> 'version')::bigint, v_h.id);
    perform set_config('tourhub.hold_departure', '', true);
    if not exists (select 1 from public.inventory_holds where id = v_h.id and status = 'converted') then
      -- Không xếp được vào đúng chuyến giữ thì không được giả vờ thành công.
      raise exception 'hold_not_converted' using errcode = 'TH003';
    end if;
  exception when sqlstate 'TH003' then
    perform set_config('tourhub.hold_departure', '', true);
    return jsonb_build_object('ok', false, 'code', 'no_seats');
  end;

  perform public._touch_connection(v_c);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Hàm nội bộ của cổng.
-- ---------------------------------------------------------------------------------------------------------

-- Chỉ service_role (cổng HTTP đã kiểm tra mật khẩu GetYourGuide) và chỉ kết nối GetYourGuide.
create function public._gyg_connection(p_connection uuid) returns public.channel_connections
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501', detail = 'service_role';
  end if;
  if v_c.channel <> 'getyourguide' then
    raise exception 'forbidden' using errcode = '42501', detail = 'not_getyourguide';
  end if;
  return v_c;
end $$;

-- Ánh xạ đã kiểm tra của một productId, gói còn bán.
create function public._gyg_mapping(p_c public.channel_connections, p_product text)
returns public.channel_product_mappings
language sql stable security definer set search_path = '' as $$
  select m.* from public.channel_product_mappings m
  join public.tour_options o on o.id = m.tour_option_id
  where m.organization_id = p_c.organization_id and m.connection_id = p_c.id
    and m.external_product_code = coalesce(p_product, '') and m.external_option_code = ''
    and m.is_verified and o.is_active and o.deleted_at is null
$$;

-- Các chuyến có thể nhận khách của một gói: chuyến riêng của gói và chuyến chung "Mọi gói" của tour.
create function public._gyg_departures(p_option uuid, p_from timestamptz, p_to timestamptz)
returns table (
  departure_id uuid, local_date date, local_time time, starts_at timestamptz, cutoff_seconds int,
  available int, slot_no int, option_specific boolean
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.local_date, d.local_time, d.starts_at,
    greatest(0, coalesce(extract(epoch from d.starts_at - d.cutoff_at), 0))::int,
    case when d.status = 'scheduled' and d.sale_open
      then greatest(0, public._pool_available(d.inventory_pool_id)) else 0 end,
    d.slot_no, d.tour_option_id is not null
  from public.tour_options o
  join public.departures d on d.organization_id = o.organization_id and d.tour_id = o.tour_id
    and (d.tour_option_id = o.id or d.tour_option_id is null)
  where o.id = p_option and d.status = 'scheduled'
    and d.starts_at >= p_from and d.starts_at <= p_to
$$;

-- Nhóm khách GetYourGuide -> mã nội bộ. Ưu tiên traveler_map của ánh xạ, không có thì dùng mã cùng tên
-- viết thường (ADULT -> adult) nếu doanh nghiệp có nhóm đó. GROUP chưa hỗ trợ.
create function public._gyg_pax(p_org uuid, p_map jsonb, p_items jsonb, out o_pax jsonb, out o_error text, out o_category text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_cat text;
  v_code text;
  v_count int;
begin
  o_pax := '{}'::jsonb;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    o_error := 'validation';
    return;
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cat := upper(coalesce(v_item ->> 'category', ''));
    if coalesce(v_item ->> 'count', '') !~ '^\d+$' or (v_item ->> 'count')::int <= 0 then
      o_error := 'validation';
      return;
    end if;
    v_count := (v_item ->> 'count')::int;
    v_code := coalesce(p_map ->> v_cat, (
      select c.code from public.traveler_categories c
      where c.organization_id = p_org and c.code = lower(v_cat)
    ));
    if v_cat = 'GROUP' or v_code is null then
      o_error := 'invalid_ticket_category';
      o_category := v_cat;
      return;
    end if;
    o_pax := jsonb_set(o_pax, array[v_code], to_jsonb(coalesce((o_pax ->> v_code)::int, 0) + v_count));
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Các thao tác GetYourGuide gọi.
-- ---------------------------------------------------------------------------------------------------------

-- GET /1/get-availabilities/
create function public.gateway_gyg_availability(p_connection uuid, p_product text, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_m public.channel_product_mappings := public._gyg_mapping(v_c, p_product);
begin
  if v_m.id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_product');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > interval '400 days' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'message', 'Khoảng thời gian không hợp lệ');
  end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'local_date', x.local_date, 'local_time', x.local_time, 'starts_at', x.starts_at,
      'cutoff_seconds', x.cutoff_seconds, 'vacancies', x.vacancies) order by x.starts_at)
    from (
      select local_date, local_time, min(starts_at) as starts_at, max(cutoff_seconds) as cutoff_seconds,
        max(available) as vacancies
      from public._gyg_departures(v_m.tour_option_id, p_from, p_to)
      group by local_date, local_time
    ) x
  ), '[]'::jsonb));
end $$;

-- POST /1/reserve/
create function public.gateway_gyg_reserve(
  p_connection uuid, p_product text, p_local_date date, p_local_time time, p_items jsonb, p_gyg_ref text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_m public.channel_product_mappings := public._gyg_mapping(v_c, p_product);
  v_pax record;
  v_seats int;
  v_base text;
  v_ref text;
  v_h public.inventory_holds%rowtype;
  v_d record;
  v_res jsonb;
  v_best int := 0;
begin
  if v_m.id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_product');
  end if;
  if coalesce(p_gyg_ref, '') = '' or p_local_date is null or p_local_time is null then
    return jsonb_build_object('ok', false, 'code', 'validation', 'message', 'Thiếu mã booking hoặc ngày giờ');
  end if;
  select * into v_pax from public._gyg_pax(v_c.organization_id, v_m.traveler_map, p_items);
  if v_pax.o_error is not null then
    return jsonb_build_object('ok', false, 'code', v_pax.o_error, 'category', v_pax.o_category);
  end if;
  v_seats := public._pax_seats(v_c.organization_id, v_pax.o_pax);
  if v_seats <= 0 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'message', 'Không có khách chiếm chỗ');
  end if;

  -- Cùng yêu cầu gửi lại (timeout) nhận đúng chỗ giữ cũ. Mã gồm phần băm của nội dung và số thứ tự,
  -- để giữ lại sau khi đã hủy hoặc đổi booking tạo chỗ giữ mới.
  v_base := 'G' || left(encode(sha256(convert_to(concat_ws('|', p_gyg_ref, p_product, p_local_date,
    p_local_time, v_pax.o_pax::text), 'UTF8')), 'hex'), 12);
  select * into v_h from public.inventory_holds
  where organization_id = v_c.organization_id and connection_id = v_c.id
    and reference like v_base || '-%' and status = 'active' and expires_at > now()
  order by created_at desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'code', 'existing', 'reference', v_h.reference, 'expires_at', v_h.expires_at);
  end if;
  v_ref := v_base || '-' || (1 + (select count(*) from public.inventory_holds
    where organization_id = v_c.organization_id and connection_id = v_c.id and reference like v_base || '-%'));

  -- Thử lần lượt các chuyến đủ chỗ ở đúng giờ; channel_reserve khóa và kiểm tra lại.
  for v_d in
    -- Lọc theo giờ địa phương; khoảng rộng hai ngày mỗi bên để không phụ thuộc múi giờ của tour.
    select g.* from public._gyg_departures(v_m.tour_option_id,
      p_local_date::timestamp at time zone 'UTC' - interval '2 days',
      p_local_date::timestamp at time zone 'UTC' + interval '3 days') g
    where g.local_date = p_local_date and g.local_time = p_local_time
    order by (not g.option_specific), g.slot_no, g.departure_id
  loop
    v_best := greatest(v_best, v_d.available);
    continue when v_d.available < v_seats;
    v_res := public.channel_reserve(v_c.id, v_d.departure_id, v_seats, v_ref, greatest(v_c.hold_ttl_seconds, 900));
    if (v_res ->> 'ok')::boolean then
      return jsonb_build_object('ok', true, 'code', 'held', 'reference', v_ref, 'expires_at', v_res -> 'expires_at');
    end if;
  end loop;
  return jsonb_build_object('ok', false, 'code', 'no_availability', 'requested', v_seats, 'available', v_best);
end $$;

-- POST /1/cancel-reservation/
create function public.gateway_gyg_cancel_reservation(p_connection uuid, p_reference text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_res jsonb := public.channel_cancel_reservation(v_c.id, p_reference);
begin
  if (v_res ->> 'ok')::boolean then
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'code', 'validation', 'message',
    case v_res ->> 'code' when 'already_booked' then 'Chỗ giữ đã thành booking' else 'Không tìm thấy chỗ giữ' end);
end $$;

-- POST /1/book/
create function public.gateway_gyg_book(
  p_connection uuid, p_reference text, p_product text, p_local_date date, p_local_time time,
  p_items jsonb, p_gyg_ref text, p_details jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_m public.channel_product_mappings := public._gyg_mapping(v_c, p_product);
  v_h public.inventory_holds%rowtype;
  v_d public.departures%rowtype;
  v_pax record;
  v_ext text;
  v_code text;
  v_lead jsonb := coalesce(p_details -> 'lead', '{}'::jsonb);
  v_item jsonb;
  v_res jsonb;
begin
  if v_m.id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_product');
  end if;
  select * into v_h from public.inventory_holds
  where organization_id = v_c.organization_id and connection_id = v_c.id and reference = coalesce(p_reference, '');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_reservation', 'message', 'Không tìm thấy chỗ giữ');
  end if;
  -- GetYourGuide gửi lại booking tối đa 10 lần: lần sau trả đúng booking cũ.
  if v_h.status = 'converted' then
    select code into v_code from public.bookings where id = v_h.booking_id;
    return jsonb_build_object('ok', true, 'code', 'existing', 'booking_code', v_code);
  end if;
  if v_h.status <> 'active' or v_h.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'invalid_reservation', 'message', 'Chỗ giữ đã hết hạn hoặc đã hủy');
  end if;

  select * into v_d from public.departures where id = v_h.departure_id;
  select * into v_pax from public._gyg_pax(v_c.organization_id, v_m.traveler_map, p_items);
  if v_pax.o_error is not null then
    return jsonb_build_object('ok', false, 'code', v_pax.o_error, 'category', v_pax.o_category);
  end if;
  if v_d.local_date is distinct from p_local_date or v_d.local_time is distinct from p_local_time
     or public._pax_seats(v_c.organization_id, v_pax.o_pax) <> v_h.quantity then
    return jsonb_build_object('ok', false, 'code', 'validation', 'message', 'Booking khác ngày giờ hoặc số khách đã giữ');
  end if;

  -- Đổi booking: GetYourGuide đặt mới với CÙNG mã GYG rồi mới hủy mã cũ, nên booking mới cần mã riêng.
  v_ext := p_gyg_ref;
  if exists (select 1 from public.bookings where organization_id = v_c.organization_id
             and connection_id = v_c.id and external_ref = v_ext) then
    v_ext := p_gyg_ref || '~' || (2 + (select count(*) from public.bookings
      where organization_id = v_c.organization_id and connection_id = v_c.id and external_ref like p_gyg_ref || '~%'));
  end if;

  v_item := jsonb_build_object('product_code', p_product, 'option_code', '', 'local_date', p_local_date,
    'local_time', to_char(p_local_time, 'HH24:MI:SS'), 'pax', v_pax.o_pax);
  if coalesce(p_details ->> 'language', '') <> '' then
    v_item := v_item || jsonb_build_object('language', p_details ->> 'language');
  end if;
  if coalesce(p_details ->> 'hotel', '') <> '' then
    v_item := v_item || jsonb_build_object('pickup', jsonb_build_object('hotel', p_details ->> 'hotel'));
  end if;

  v_res := public.channel_book(v_c.id, v_h.reference, jsonb_strip_nulls(jsonb_build_object(
    'external_ref', v_ext,
    'status', 'confirmed',
    'channel_status', 'CONFIRMED',
    'currency', nullif(upper(p_details ->> 'currency'), ''),
    'lead', jsonb_strip_nulls(jsonb_build_object('name', nullif(btrim(concat_ws(' ', v_lead ->> 'first_name', v_lead ->> 'last_name')), ''),
      'email', v_lead ->> 'email', 'phone', v_lead ->> 'phone')),
    'special_requests', nullif(p_details ->> 'comment', ''),
    'items', jsonb_build_array(v_item)
  )));

  if (v_res ->> 'ok')::boolean then
    return jsonb_build_object('ok', true, 'code', coalesce(v_res ->> 'code', 'booked'),
      'booking_code', coalesce(v_res ->> 'booking_code', (select code from public.bookings where id = (v_res ->> 'booking_id')::uuid)));
  end if;
  return jsonb_build_object('ok', false, 'code', case v_res ->> 'code'
      when 'hold_expired' then 'invalid_reservation'
      when 'hold_not_found' then 'invalid_reservation'
      when 'no_seats' then 'no_availability'
      else 'validation' end,
    'message', coalesce(v_res -> 'errors' ->> 0, v_res ->> 'code'));
end $$;

-- POST /1/cancel-booking/. bookingReference là mã booking nội bộ (SH-...) mà cổng đã trả khi đặt.
create function public.gateway_gyg_cancel_booking(p_connection uuid, p_booking_code text, p_gyg_ref text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_b public.bookings%rowtype;
  v_res jsonb;
begin
  select * into v_b from public.bookings
  where organization_id = v_c.organization_id and connection_id = v_c.id and code = coalesce(p_booking_code, '');
  if not found or split_part(v_b.external_ref, '~', 1) is distinct from p_gyg_ref then
    return jsonb_build_object('ok', false, 'code', 'invalid_booking', 'message', 'Không tìm thấy booking');
  end if;
  if v_b.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'invalid_booking', 'message', 'Booking đã hủy trước đó');
  end if;
  v_res := public.ingest_channel_event(v_c.id, jsonb_build_object(
    'event_id', 'gyg-cancel:' || v_b.code,
    'type', 'booking.cancelled',
    'external_ref', v_b.external_ref,
    'data', jsonb_build_object('external_ref', v_b.external_ref, 'status', 'cancelled', 'channel_status', 'CANCELLED')
  ));
  if (v_res ->> 'ok')::boolean then
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'code', 'internal', 'message', v_res ->> 'code');
end $$;

-- GET /1/suppliers/{supplierId}/products/
create function public.gateway_gyg_products(p_connection uuid, p_supplier text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._gyg_connection(p_connection);
  v_org text;
begin
  if coalesce(v_c.supplier_account_ref, '') = '' or v_c.supplier_account_ref is distinct from p_supplier then
    return jsonb_build_object('ok', false, 'code', 'invalid_supplier');
  end if;
  select name into v_org from public.organizations where id = v_c.organization_id;
  return jsonb_build_object('ok', true, 'supplier_name', v_org, 'products', coalesce((
    select jsonb_agg(jsonb_build_object('productId', m.external_product_code,
      'productTitle', t.name || ' - ' || o.name) order by m.external_product_code)
    from public.channel_product_mappings m
    join public.tour_options o on o.id = m.tour_option_id
    join public.tours t on t.id = o.tour_id
    where m.organization_id = v_c.organization_id and m.connection_id = v_c.id and m.external_option_code = ''
      and m.is_verified and o.is_active and o.deleted_at is null
  ), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Worker: số chỗ cần báo cho GetYourGuide khi một chuyến đổi chỗ (POST /1/notify-availability-update).
-- Chỉ kết nối GetYourGuide không phải mô phỏng, không bị tắt.
-- ---------------------------------------------------------------------------------------------------------
create function public.worker_gyg_availability(p_departure uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
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
  from public.departures d
  join public.channel_connections c on c.organization_id = d.organization_id
    and c.channel = 'getyourguide' and c.mode <> 'mock' and c.status <> 'disabled'
  join public.channel_product_mappings m on m.connection_id = c.id and m.external_option_code = '' and m.is_verified
  join public.tour_options o on o.id = m.tour_option_id and o.tour_id = d.tour_id
    and (d.tour_option_id is null or d.tour_option_id = o.id)
  where d.id = p_departure
$$;

revoke all on function
  public._gyg_connection(uuid),
  public._gyg_mapping(public.channel_connections, text),
  public._gyg_departures(uuid, timestamptz, timestamptz),
  public._gyg_pax(uuid, jsonb, jsonb),
  public.gateway_gyg_availability(uuid, text, timestamptz, timestamptz),
  public.gateway_gyg_reserve(uuid, text, date, time, jsonb, text),
  public.gateway_gyg_cancel_reservation(uuid, text),
  public.gateway_gyg_book(uuid, text, text, date, time, jsonb, text, jsonb),
  public.gateway_gyg_cancel_booking(uuid, text, text),
  public.gateway_gyg_products(uuid, text),
  public.worker_gyg_availability(uuid)
from public, anon, authenticated;
grant execute on function
  public.gateway_gyg_availability(uuid, text, timestamptz, timestamptz),
  public.gateway_gyg_reserve(uuid, text, date, time, jsonb, text),
  public.gateway_gyg_cancel_reservation(uuid, text),
  public.gateway_gyg_book(uuid, text, text, date, time, jsonb, text, jsonb),
  public.gateway_gyg_cancel_booking(uuid, text, text),
  public.gateway_gyg_products(uuid, text)
to service_role;
