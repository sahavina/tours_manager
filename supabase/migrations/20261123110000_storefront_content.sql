-- Trang chi tiết tour đầy đủ hơn: bộ ảnh, điểm nổi bật, đồ cần mang, lưu ý, nhãn thời lượng, số khách tối đa,
-- bản tiếng Việt; giá tour riêng theo số người; liên hệ và chính sách hủy của doanh nghiệp trên trang khách.
-- Không có nội dung nào được điền sẵn ở đây: doanh nghiệp nhập, hoặc nạp từ website của chính họ.

create function public._all_https(p_urls text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(u ~ '^https://[^[:space:]]+$' and length(u) <= 500), true) from unnest(p_urls) u
$$;

alter table public.tours
  add column gallery text[] not null default '{}' check (cardinality(gallery) <= 20 and public._all_https(gallery)),
  add column highlights text[] not null default '{}' check (cardinality(highlights) <= 12),
  add column what_to_bring text[] not null default '{}' check (cardinality(what_to_bring) <= 20),
  add column good_to_know text[] not null default '{}' check (cardinality(good_to_know) <= 20),
  add column duration_label text check (duration_label is null or length(duration_label) <= 60),
  add column group_max int check (group_max is null or group_max between 1 and 100),
  -- Bản tiếng Việt, cùng khóa với bản gốc: name, description, duration_label, highlights, itinerary, inclusions,
  -- exclusions, joining_instructions, what_to_bring, good_to_know. Thiếu khóa nào thì trang khách dùng bản gốc.
  add column content_vi jsonb not null default '{}' check (jsonb_typeof(content_vi) = 'object');

alter table public.tour_options
  -- Giá theo số khách trả tiền, cho tour riêng: [{"min":2,"max":2,"per_person":199}, {"min":7,"max":null,...}].
  add column group_prices jsonb not null default '[]' check (jsonb_typeof(group_prices) = 'array'),
  add column child_note text check (child_note is null or length(child_note) <= 300),
  add column content_vi jsonb not null default '{}' check (jsonb_typeof(content_vi) = 'object');

-- {"cancel_free_hours": 24, "contact": {"whatsapp": "+84...", "zalo": "...", "email": "..."}}
alter table public.organizations
  add column storefront_settings jsonb not null default '{}' check (jsonb_typeof(storefront_settings) = 'object');

-- Tổng tiền của một yêu cầu: trang khách hiển thị và lúc đặt đều dùng hàm này.
-- Gói có bảng giá theo số người: mọi khách trả tiền (trừ em bé) tính theo bậc khớp với số khách đó.
-- Gói thường: người lớn theo giá người lớn, trẻ em theo giá trẻ em (không có thì như người lớn), em bé miễn phí.
create function public._storefront_price(p_option uuid, p_pax jsonb) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.tour_options%rowtype;
  v_paying int;
  v_tier numeric;
begin
  select * into v_o from public.tour_options where id = p_option;
  if not found then
    return null;
  end if;
  select coalesce(sum(e.value::int) filter (where e.key <> 'infant'), 0) into v_paying from jsonb_each_text(p_pax) e;
  if jsonb_array_length(v_o.group_prices) > 0 then
    select (t ->> 'per_person')::numeric into v_tier
    from jsonb_array_elements(v_o.group_prices) t
    where v_paying >= coalesce((t ->> 'min')::int, 1) and (t ->> 'max' is null or v_paying <= (t ->> 'max')::int)
    order by coalesce((t ->> 'min')::int, 1) desc
    limit 1;
    if v_tier is not null then
      return v_tier * v_paying;
    end if;
  end if;
  if v_o.price_adult is null then
    return null;
  end if;
  return (select coalesce(sum(e.value::int * case e.key
      when 'child' then coalesce(v_o.price_child, v_o.price_adult)
      when 'infant' then 0
      else v_o.price_adult end), 0)
    from jsonb_each_text(p_pax) e);
end $$;

-- Giá "từ" của một gói: giá người lớn, hoặc bậc rẻ nhất của bảng giá theo người.
create function public._storefront_from_price(p_option public.tour_options) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(least(p_option.price_adult,
    (select min((t ->> 'per_person')::numeric) from jsonb_array_elements(p_option.group_prices) t)),
    p_option.price_adult)
$$;

create or replace function public.public_storefront(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
begin
  if v_o.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'name', v_o.name, 'settings', v_o.storefront_settings, 'tours', coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', t.code, 'name', t.name, 'summary', left(coalesce(t.description, ''), 220),
      'destination', t.destination, 'duration_minutes', t.duration_minutes, 'duration_label', t.duration_label,
      'image_url', coalesce(t.image_url, t.gallery[1]), 'group_max', t.group_max,
      'vi', jsonb_build_object('name', t.content_vi ->> 'name', 'summary', left(t.content_vi ->> 'description', 220),
        'duration_label', t.content_vi ->> 'duration_label'),
      'price_from', (select min(public._storefront_from_price(o)) from public.tour_options o where o.tour_id = t.id
                       and o.is_published and o.is_active and o.deleted_at is null),
      'currency', (select min(o.price_currency) from public.tour_options o where o.tour_id = t.id
                       and o.is_published and o.is_active and o.deleted_at is null and public._storefront_from_price(o) is not null),
      'has_private', exists (select 1 from public.tour_options o where o.tour_id = t.id and o.is_private
                       and o.is_published and o.is_active and o.deleted_at is null),
      'has_transfer', exists (select 1 from public.tour_options o where o.tour_id = t.id and o.has_transfer
                       and o.is_published and o.is_active and o.deleted_at is null)
    ) order by t.name)
    from public.tours t
    where t.organization_id = v_o.id and t.is_published and t.is_active and t.deleted_at is null
  ), '[]'::jsonb));
end $$;

create or replace function public.public_tour(p_slug text, p_tour_code text) returns jsonb
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
  return jsonb_build_object('ok', true, 'settings', v_o.storefront_settings,
    'tour', jsonb_build_object('code', v_t.code, 'name', v_t.name, 'description', v_t.description,
      'destination', v_t.destination, 'duration_minutes', v_t.duration_minutes, 'duration_label', v_t.duration_label,
      'image_url', coalesce(v_t.image_url, v_t.gallery[1]), 'gallery', to_jsonb(v_t.gallery), 'group_max', v_t.group_max,
      'highlights', to_jsonb(v_t.highlights), 'what_to_bring', to_jsonb(v_t.what_to_bring), 'good_to_know', to_jsonb(v_t.good_to_know),
      'itinerary', v_t.itinerary, 'inclusions', to_jsonb(v_t.inclusions), 'exclusions', to_jsonb(v_t.exclusions),
      'joining_instructions', v_t.joining_instructions, 'timezone', v_t.default_timezone, 'vi', v_t.content_vi),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('code', o.code, 'name', coalesce(o.public_name, o.name),
        'is_private', o.is_private, 'has_transfer', o.has_transfer, 'language', o.language,
        'duration_minutes', coalesce(o.duration_minutes, v_t.duration_minutes),
        'price_adult', o.price_adult, 'price_child', o.price_child, 'currency', o.price_currency,
        'group_prices', o.group_prices, 'child_note', o.child_note, 'from_price', public._storefront_from_price(o),
        'vi', o.content_vi) order by o.is_private, public._storefront_from_price(o) nulls last, o.code)
      from public.tour_options o
      where o.tour_id = v_t.id and o.is_published and o.is_active and o.deleted_at is null
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'min_age', c.min_age, 'max_age', c.max_age,
        'counts_as_seat', c.counts_as_seat) order by c.sort_order, c.code)
      from public.traveler_categories c where c.organization_id = v_o.id
    ), '[]'::jsonb));
end $$;

-- Giá trước khi gửi: trang khách gọi để hiện tổng tiền đúng như lúc đặt (cả bảng giá theo người).
create function public.public_quote(p_slug text, p_option_code text, p_pax jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.organizations := public._storefront_org(p_slug);
  v_opt record;
begin
  select * into v_opt from public._storefront_option(v_o.id, p_option_code);
  if v_o.id is null or v_opt.option_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if jsonb_typeof(p_pax) is distinct from 'object' or exists (
       select 1 from jsonb_each_text(p_pax) e where e.value !~ '^\d{1,2}$') then
    return jsonb_build_object('ok', false, 'code', 'invalid_pax');
  end if;
  return jsonb_build_object('ok', true, 'amount', public._storefront_price(v_opt.option_id, p_pax), 'currency', v_opt.currency);
end $$;

-- Yêu cầu đặt: như bản 20261122100000, chỉ đổi cách tính tiền sang _storefront_price.
create or replace function public.public_booking_request(
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

  v_conn := public._website_connection(v_o.id);
  if (select count(*) from public.bookings b where b.connection_id = v_conn and b.lead_email = v_email
        and b.status = 'pending' and b.created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.bookings b where b.connection_id = v_conn
        and b.created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'code', 'too_many_requests');
  end if;

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

    v_gross := public._storefront_price(v_opt.option_id, v_pax);
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

revoke all on function public._all_https(text[]), public._storefront_price(uuid, jsonb),
  public._storefront_from_price(public.tour_options), public.public_quote(text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.public_quote(text, text, jsonb) to anon, authenticated, service_role;
-- Ràng buộc kiểm tra của tours.gallery chạy bằng quyền người sửa tour, nên người đăng nhập phải gọi được hàm này.
grant execute on function public._all_https(text[]) to authenticated, service_role;
-- Cột mới của tours/tour_options đọc được như các cột cũ (quyền theo bảng). Doanh nghiệp sửa storefront_settings
-- qua quyền cập nhật bảng organizations như các cột cấu hình khác.
grant update (storefront_settings) on public.organizations to authenticated;
