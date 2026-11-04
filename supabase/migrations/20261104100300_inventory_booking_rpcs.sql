-- Lõi nghiệp vụ: tồn chỗ, áp dữ liệu booking, nhận sự kiện kênh.
--
-- Bất biến tồn chỗ: mọi thay đổi committed_seats hoặc inventory_holds phải khóa dòng inventory_pools
-- trước (`_lock_pools`), luôn theo thứ tự id để hai giao dịch ngược chiều không deadlock.
-- Số chỗ KHÔNG lưu thành bộ đếm: luôn tính lại từ booking_items + inventory_holds dưới khóa, nên không
-- có bộ đếm nào lệch được. Hold quá hạn tự mất tác dụng ngay cả khi worker chưa chạy.

-- plpgsql + PERFORM, KHÔNG dùng hàm SQL: hàm SQL không trả tập có thể dừng sau dòng đầu tiên, tức chỉ
-- khóa một trong hai nguồn chỗ khi đổi chuyến mà không có lỗi nào hiện ra.
create function public._lock_pools(p_pools uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.inventory_pools p where p.id = any (p_pools) order by p.id for update;
end $$;

create function public._pool_committed(p_pool uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(i.committed_seats), 0)::int
  from public.booking_items i
  join public.departures d on d.id = i.departure_id
  where d.inventory_pool_id = p_pool and i.committed_seats > 0;
$$;

create function public._pool_held(p_pool uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(h.quantity), 0)::int
  from public.inventory_holds h
  where h.inventory_pool_id = p_pool and h.status = 'active' and h.expires_at > now();
$$;

create function public._pool_available(p_pool uuid) returns int
language sql stable security definer set search_path = '' as $$
  select p.capacity - p.blocked_seats - public._pool_committed(p.id) - public._pool_held(p.id)
  from public.inventory_pools p where p.id = p_pool;
$$;

-- Sequence, không dùng bộ đếm trên dòng organizations: khóa dòng đó trong khi một giao dịch khác giữ
-- khóa nguồn chỗ theo thứ tự ngược lại sẽ gây deadlock. Mã có thể nhảy số, nhưng luôn duy nhất.
create sequence public.booking_code_seq;
create function public._next_booking_code(p_org uuid) returns text
language sql security definer set search_path = '' as $$
  select o.booking_prefix || '-' || lpad(nextval('public.booking_code_seq')::text, 6, '0')
  from public.organizations o where o.id = p_org;
$$;

-- Số chỗ từ nhóm khách. Loại khách lạ vẫn tính là chiếm chỗ, thà thừa còn hơn bán lố.
create function public._pax_seats(p_org uuid, p_pax jsonb) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(e.value::int) filter (where coalesce(c.counts_as_seat, true)), 0)::int
  from jsonb_each_text(coalesce(p_pax, '{}'::jsonb)) e
  left join public.traveler_categories c on c.organization_id = p_org and c.code = e.key;
$$;

create function public._pax_total(p_pax jsonb) returns int
language sql immutable set search_path = '' as $$
  select coalesce(sum(e.value::int), 0)::int from jsonb_each_text(coalesce(p_pax, '{}'::jsonb)) e;
$$;

-- Trạng thái điều hành luôn suy ra từ dữ liệu, không ai đặt tay nên không lệch được.
create function public._recompute_booking_ops(p_booking uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.booking_status;
  v_ops public.ops_status;
  v_has_items boolean;
begin
  select status into v_status from public.bookings where id = p_booking;
  if v_status is null then return; end if;

  select exists (select 1 from public.booking_items where booking_id = p_booking) into v_has_items;

  if v_status = 'cancelled' then
    v_ops := 'cancelled';
  elsif not v_has_items then
    v_ops := 'new';
  elsif exists (select 1 from public.booking_items where booking_id = p_booking and tour_option_id is null) then
    v_ops := 'needs_mapping';
  elsif exists (select 1 from public.booking_items where booking_id = p_booking and departure_id is null) then
    v_ops := 'needs_departure';
  elsif exists (
    select 1 from public.booking_items i
    join public.tour_options o on o.id = i.tour_option_id
    left join public.booking_pickups p on p.booking_item_id = i.id
    where i.booking_id = p_booking and o.has_transfer
      and (p.booking_item_id is null or (coalesce(p.hotel_name, '') = '' and coalesce(p.address, '') = ''))
  ) then
    v_ops := 'needs_info';
  elsif not exists (
    select 1 from public.booking_items i
    join public.departures d on d.id = i.departure_id
    where i.booking_id = p_booking and d.status <> 'completed'
  ) then
    v_ops := 'done';
  elsif not exists (
    select 1 from public.booking_items i
    where i.booking_id = p_booking and (
      not exists (select 1 from public.guide_assignments g where g.departure_id = i.departure_id)
      or not exists (select 1 from public.vehicle_assignments v where v.departure_id = i.departure_id)
    )
  ) then
    v_ops := 'assigned';
  else
    v_ops := 'ready';
  end if;

  update public.bookings set ops_status = v_ops where id = p_booking and ops_status is distinct from v_ops;
end $$;

create function public._recompute_departure_bookings(p_departure uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct booking_id from public.booking_items where departure_id = p_departure loop
    perform public._recompute_booking_ops(r.booking_id);
  end loop;
end $$;

-- Đổi bất kỳ khi chuyến đã phân công thì báo điều hành biết.
create function public._flag_if_assigned(p_booking uuid, p_departure uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_departure is not null and (
    exists (select 1 from public.guide_assignments where departure_id = p_departure)
    or exists (select 1 from public.vehicle_assignments where departure_id = p_departure)
  ) then
    update public.bookings
    set changed_after_assignment = true, needs_action = true, action_reason = p_reason
    where id = p_booking;
  end if;
end $$;

-- Đặt một dòng booking vào chuyến với số chỗ cho trước. Trả 'ok' | 'no_seats' | 'departure_not_found'.
-- p_hold: hold đang được chuyển thành booking, chỗ của nó được tính là còn trống cho chính giao dịch này.
create function public._place_item(p_item uuid, p_departure uuid, p_seats int, p_hold uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.booking_items%rowtype;
  v_old_pool uuid;
  v_new_pool uuid;
  v_available int;
  v_hold_qty int := 0;
begin
  select * into v_item from public.booking_items where id = p_item for update;
  if v_item.departure_id is not null then
    select inventory_pool_id into v_old_pool from public.departures where id = v_item.departure_id;
  end if;

  if p_departure is null then
    if v_old_pool is not null then
      perform public._lock_pools(array[v_old_pool]);
    end if;
    update public.booking_items set departure_id = null, committed_seats = 0, seats = p_seats where id = p_item;
    update public.passenger_allocations set is_active = false where booking_item_id = p_item and is_active;
    return 'ok';
  end if;

  select inventory_pool_id into v_new_pool from public.departures
  where id = p_departure and organization_id = v_item.organization_id;
  if v_new_pool is null then
    return 'departure_not_found';
  end if;

  perform public._lock_pools(array_remove(array[v_old_pool, v_new_pool], null));

  v_available := public._pool_available(v_new_pool);
  if v_old_pool = v_new_pool then
    v_available := v_available + v_item.committed_seats;
  end if;
  if p_hold is not null then
    select quantity into v_hold_qty from public.inventory_holds
    where id = p_hold and status = 'active' and expires_at > now() and inventory_pool_id = v_new_pool;
    v_available := v_available + coalesce(v_hold_qty, 0);
  end if;

  if p_seats > v_available then
    return 'no_seats';
  end if;

  if v_item.departure_id is distinct from p_departure or v_item.seats is distinct from p_seats then
    -- Xe đã phân không còn đúng: tắt, giữ lịch sử, điều hành sẽ chia lại.
    update public.passenger_allocations set is_active = false where booking_item_id = p_item and is_active;
  end if;

  update public.booking_items
  set departure_id = p_departure, committed_seats = p_seats, seats = p_seats
  where id = p_item;

  if p_hold is not null then
    update public.inventory_holds set status = 'converted', booking_id = v_item.booking_id where id = p_hold;
  end if;
  return 'ok';
end $$;

-- Hủy nội bộ. Gọi lại nhiều lần không trả chỗ lần hai vì committed_seats đã về 0.
create function public._cancel_booking(
  p_booking uuid, p_source text, p_event uuid default null, p_channel_status text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  r record;
begin
  select * into v_b from public.bookings where id = p_booking for update;
  if v_b.status = 'cancelled' then
    return false;
  end if;

  for r in select id, departure_id from public.booking_items where booking_id = p_booking loop
    perform public._flag_if_assigned(p_booking, r.departure_id, 'Booking bị hủy sau khi đã phân công');
    if r.departure_id is not null then
      perform public._lock_pools(array(select inventory_pool_id from public.departures where id = r.departure_id));
    end if;
    update public.booking_items set committed_seats = 0 where id = r.id;
    update public.passenger_allocations set is_active = false where booking_item_id = r.id and is_active;
  end loop;

  update public.bookings
  set status = 'cancelled', channel_status = coalesce(p_channel_status, channel_status)
  where id = p_booking;

  insert into public.booking_status_history
    (organization_id, booking_id, field, from_value, to_value, source, actor_id, event_id)
  values (v_b.organization_id, p_booking, 'status', v_b.status::text, 'cancelled', p_source, (select auth.uid()), p_event);

  insert into public.booking_changes
    (organization_id, booking_id, change_type, summary, source, actor_id, event_id)
  values (v_b.organization_id, p_booking, 'cancelled', 'Booking bị hủy', p_source, (select auth.uid()), p_event);

  perform public._recompute_booking_ops(p_booking);

  insert into public.outbox_events (organization_id, topic, aggregate_id, payload, dedupe_key)
  values (v_b.organization_id, 'booking.cancelled', p_booking::text,
    jsonb_build_object('code', v_b.code), 'booking.cancelled:' || p_booking);
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_b.organization_id, 'availability.changed', p_booking::text, '{}');
  return true;
end $$;

-- Kiểm tra dữ liệu booking đã chuẩn hóa. Trả danh sách lỗi tiếng Việt, rỗng là hợp lệ.
create function public._validate_booking_data(p jsonb) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  v_errors text[] := '{}';
  v_item jsonb;
  v_cur text;
begin
  if coalesce(p ->> 'external_ref', '') = '' then
    v_errors := v_errors || 'Thiếu mã booking'::text;
  end if;
  v_cur := p ->> 'currency';
  if v_cur is not null and v_cur !~ '^[A-Z]{3}$' then
    v_errors := v_errors || ('Tiền tệ không hợp lệ: ' || v_cur);
  end if;
  if (p ->> 'gross_amount') is not null and (p ->> 'gross_amount') !~ '^-?[0-9]+(\.[0-9]+)?$' then
    v_errors := v_errors || ('Số tiền không hợp lệ: ' || (p ->> 'gross_amount'));
  end if;
  if (p ->> 'gross_amount') is not null and v_cur is null then
    v_errors := v_errors || 'Có số tiền nhưng thiếu tiền tệ'::text;
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0 then
    v_errors := v_errors || 'Thiếu dòng dịch vụ'::text;
    return v_errors;
  end if;
  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    if coalesce(v_item ->> 'local_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      v_errors := v_errors || ('Ngày đi không hợp lệ: ' || coalesce(v_item ->> 'local_date', '(trống)'));
    else
      -- Đúng khuôn nhưng không có thật (2030-13-45): ép kiểu thử, lỗi thì báo thay vì nổ khi áp dụng.
      begin
        perform (v_item ->> 'local_date')::date;
      exception when others then
        v_errors := v_errors || ('Ngày đi không tồn tại: ' || (v_item ->> 'local_date'));
      end;
    end if;
    if (v_item ->> 'local_time') is not null and (v_item ->> 'local_time') !~ '^\d{2}:\d{2}(:\d{2})?$' then
      v_errors := v_errors || ('Giờ đi không hợp lệ: ' || (v_item ->> 'local_time'));
    end if;
    if exists (select 1 from jsonb_each_text(coalesce(v_item -> 'pax', '{}'::jsonb)) e where e.value !~ '^\d+$') then
      v_errors := v_errors || 'Số khách không hợp lệ'::text;
    end if;
    if public._pax_total(case when exists (select 1 from jsonb_each_text(coalesce(v_item -> 'pax', '{}'::jsonb)) e where e.value !~ '^\d+$')
       then '{}'::jsonb else v_item -> 'pax' end) = 0 then
      v_errors := v_errors || 'Số khách phải lớn hơn 0'::text;
    end if;
  end loop;
  return v_errors;
end $$;

-- Tìm ánh xạ đã kiểm tra rồi chuyến phù hợp. Không ghép theo tên, không tự tạo chuyến.
create function public._resolve_item(
  p_org uuid, p_connection uuid, p_product text, p_option text, p_date date, p_time time,
  out o_option uuid, out o_tour uuid, out o_departure uuid, out o_time time, out o_tz text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_map public.channel_product_mappings%rowtype;
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
  -- Ưu tiên chuyến riêng của gói hơn chuyến chung của tour.
  order by (d.tour_option_id is null), d.id
  limit 1;
  if not found then
    select t.default_timezone into o_tz from public.tours t where t.id = o_tour;
    o_departure := null;
  end if;
end $$;

-- Áp một ảnh chụp booking từ nguồn (sự kiện kênh hoặc dòng nhập file). Đây là đường ghi DUY NHẤT của
-- dữ liệu đồng bộ, và nó không có câu lệnh nào chạm vào booking_notes hay cột điều hành của điểm đón.
create function public._apply_booking_data(
  p_connection public.channel_connections,
  p_data jsonb,
  p_source text,
  p_event uuid default null,
  p_source_at timestamptz default null,
  p_version bigint default null,
  p_hold uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := p_connection.organization_id;
  v_ref text := p_data ->> 'external_ref';
  v_b public.bookings%rowtype;
  v_is_new boolean := false;
  v_status public.booking_status := coalesce((p_data ->> 'status')::public.booking_status, 'confirmed');
  v_sync public.sync_status;
  v_customer uuid;
  v_item_data jsonb;
  v_item public.booking_items%rowtype;
  v_resolved record;
  v_item_ref text;
  v_seats int;
  v_date date;
  v_time time;
  v_place text;
  v_reasons text[] := '{}';
  v_old_item jsonb;
  v_changes text[] := '{}';
  v_old_departure uuid;
begin
  v_sync := case
    when p_source = 'import' then 'manual'::public.sync_status
    when p_connection.mode = 'mock' then 'simulated'::public.sync_status
    else 'synced'::public.sync_status
  end;

  -- ON CONFLICT rồi SELECT FOR UPDATE: hai lần nhận đồng thời cùng mã xếp hàng trên một dòng duy nhất.
  insert into public.bookings
    (organization_id, code, connection_id, external_ref, source, status, sync_status, booked_at)
  values (v_org, public._next_booking_code(v_org), p_connection.id, v_ref, p_source, v_status, v_sync,
    coalesce((p_data ->> 'booked_at')::timestamptz, now()))
  on conflict (organization_id, connection_id, external_ref) where external_ref is not null do nothing
  returning * into v_b;
  v_is_new := found;

  if not v_is_new then
    select * into v_b from public.bookings
    where organization_id = v_org and connection_id = p_connection.id and external_ref = v_ref
    for update;
  end if;

  -- Khách: chỉ dùng lại khi nguồn cung cấp đúng mã khách; không gộp theo tên.
  v_customer := v_b.customer_id;
  if v_customer is null and coalesce(p_data #>> '{lead,name}', '') <> '' then
    if coalesce(p_data ->> 'customer_ref', '') <> '' then
      select id into v_customer from public.customers
      where organization_id = v_org and external_customer_ref = p_data ->> 'customer_ref' limit 1;
    end if;
    if v_customer is null then
      insert into public.customers (organization_id, full_name, email, phone, source, external_customer_ref)
      values (v_org, p_data #>> '{lead,name}', p_data #>> '{lead,email}', p_data #>> '{lead,phone}',
        p_connection.channel::text, nullif(p_data ->> 'customer_ref', ''))
      returning id into v_customer;
    end if;
  end if;

  if not v_is_new and v_b.status is distinct from v_status then
    insert into public.booking_status_history
      (organization_id, booking_id, field, from_value, to_value, source, actor_id, event_id)
    values (v_org, v_b.id, 'status', v_b.status::text, v_status::text, p_source, (select auth.uid()), p_event);
  end if;

  update public.bookings set
    customer_id = v_customer,
    lead_name = coalesce(p_data #>> '{lead,name}', lead_name),
    lead_email = coalesce(p_data #>> '{lead,email}', lead_email),
    lead_phone = coalesce(p_data #>> '{lead,phone}', lead_phone),
    special_requests = coalesce(p_data ->> 'special_requests', special_requests),
    channel_status = coalesce(p_data ->> 'channel_status', channel_status),
    status = v_status,
    sync_status = v_sync,
    gross_amount = coalesce((p_data ->> 'gross_amount')::numeric, gross_amount),
    currency = coalesce(p_data ->> 'currency', currency),
    policy_snapshot = coalesce(p_data -> 'policy', policy_snapshot),
    last_source_at = coalesce(p_source_at, last_source_at),
    last_source_version = coalesce(p_version, last_source_version),
    import_hash = coalesce(p_data ->> '_import_hash', import_hash)
  where id = v_b.id;

  for v_item_data in select * from jsonb_array_elements(p_data -> 'items') loop
    v_item_ref := coalesce(v_item_data ->> 'ref', 'main');
    v_date := (v_item_data ->> 'local_date')::date;
    v_time := (v_item_data ->> 'local_time')::time;

    select * into v_resolved from public._resolve_item(v_org, p_connection.id,
      v_item_data ->> 'product_code', v_item_data ->> 'option_code', v_date, v_time);

    v_seats := public._pax_seats(v_org, v_item_data -> 'pax');

    select * into v_item from public.booking_items where booking_id = v_b.id and item_ref = v_item_ref;
    if found then
      v_old_item := to_jsonb(v_item);
      v_old_departure := v_item.departure_id;
    else
      v_old_item := null;
      v_old_departure := null;
      insert into public.booking_items (organization_id, booking_id, item_ref)
      values (v_org, v_b.id, v_item_ref) returning * into v_item;
    end if;

    update public.booking_items set
      external_product_code = v_item_data ->> 'product_code',
      external_option_code = v_item_data ->> 'option_code',
      tour_option_id = v_resolved.o_option,
      tour_id = v_resolved.o_tour,
      local_date = v_date,
      local_time = v_resolved.o_time,
      timezone = coalesce(v_item_data ->> 'timezone', v_resolved.o_tz, timezone),
      language = coalesce(v_item_data ->> 'language', language),
      pax = coalesce(v_item_data -> 'pax', pax),
      pax_total = public._pax_total(v_item_data -> 'pax'),
      amount = coalesce((v_item_data ->> 'amount')::numeric, amount),
      currency = coalesce(v_item_data ->> 'currency', p_data ->> 'currency', currency)
    where id = v_item.id;

    -- Đặt chỗ. Booking bán trên kênh là chuyện đã xảy ra nên không được mất: thiếu chỗ thì đưa vào
    -- hàng chờ (không chiếm chỗ, để tổng cam kết không vượt sức chứa) và cảnh báo.
    if v_status = 'cancelled' then
      if v_old_departure is not null then
        perform public._lock_pools(array(select inventory_pool_id from public.departures where id = v_old_departure));
      end if;
      update public.booking_items set committed_seats = 0, seats = v_seats where id = v_item.id;
      update public.passenger_allocations set is_active = false where booking_item_id = v_item.id and is_active;
    elsif v_resolved.o_option is null then
      v_reasons := v_reasons || ('Chưa ghép mã sản phẩm ' || coalesce(v_item_data ->> 'product_code', '(trống)'));
      perform public._place_item(v_item.id, null, v_seats);
    elsif v_resolved.o_departure is null then
      v_reasons := v_reasons || ('Không tìm thấy chuyến ' || v_date || ' ' || coalesce(v_resolved.o_time::text, '(chưa có giờ)'));
      perform public._place_item(v_item.id, null, v_seats);
    else
      v_place := public._place_item(v_item.id, v_resolved.o_departure, v_seats, p_hold);
      if v_place = 'no_seats' then
        if p_hold is not null then
          raise exception 'no_seats_for_hold' using errcode = 'TH003';
        end if;
        v_reasons := v_reasons || ('Hết chỗ trên chuyến ' || v_date || ' ' || v_resolved.o_time::text);
        perform public._place_item(v_item.id, null, v_seats);
      end if;
    end if;

    -- Ghi nhận thay đổi so với lần trước.
    if v_old_item is not null then
      if (v_old_item ->> 'local_date') is distinct from v_date::text
         or (v_old_item ->> 'local_time') is distinct from v_resolved.o_time::text then
        v_changes := v_changes || format('Đổi ngày giờ đi: %s %s → %s %s',
          v_old_item ->> 'local_date', v_old_item ->> 'local_time', v_date, v_resolved.o_time);
      end if;
      if (v_old_item -> 'pax') is distinct from coalesce(v_item_data -> 'pax', v_old_item -> 'pax') then
        v_changes := v_changes || format('Đổi số khách: %s → %s', v_old_item -> 'pax', v_item_data -> 'pax');
      end if;
      if cardinality(v_changes) > 0 then
        perform public._flag_if_assigned(v_b.id, v_old_departure, 'Có thay đổi sau khi đã phân công');
      end if;
    end if;

    -- Điểm đón: chỉ các cột nguồn; giờ đón, thứ tự, ghi chú điều hành giữ nguyên.
    if v_item_data ? 'pickup' then
      insert into public.booking_pickups (booking_item_id, organization_id, hotel_name, address, latitude, longitude)
      values (v_item.id, v_org, v_item_data #>> '{pickup,hotel}', v_item_data #>> '{pickup,address}',
        (v_item_data #>> '{pickup,lat}')::numeric, (v_item_data #>> '{pickup,lng}')::numeric)
      on conflict (booking_item_id) do update set
        hotel_name = coalesce(excluded.hotel_name, public.booking_pickups.hotel_name),
        address = coalesce(excluded.address, public.booking_pickups.address),
        latitude = coalesce(excluded.latitude, public.booking_pickups.latitude),
        longitude = coalesce(excluded.longitude, public.booking_pickups.longitude),
        updated_at = now();
    end if;

    if v_item_data ? 'participants' then
      delete from public.booking_participants where booking_item_id = v_item.id and source <> 'manual';
      insert into public.booking_participants
        (organization_id, booking_id, booking_item_id, full_name, category_code, is_lead, source)
      select v_org, v_b.id, v_item.id, x ->> 'name', x ->> 'category', coalesce((x ->> 'is_lead')::boolean, false), p_source
      from jsonb_array_elements(v_item_data -> 'participants') x;
    end if;
  end loop;

  -- Tài chính: trường nguồn không gửi thì giữ nguyên null, không biến thành 0. actual_payout chỉ đến
  -- từ đối soát nên không có mặt ở đây.
  if p_data ? 'financials' or (p_data ->> 'currency') is not null then
    insert into public.booking_financials
      (booking_id, organization_id, currency, discount_amount, channel_fee, expected_payout, source)
    values (v_b.id, v_org, p_data ->> 'currency',
      (p_data #>> '{financials,discount}')::numeric, (p_data #>> '{financials,channel_fee}')::numeric,
      (p_data #>> '{financials,expected_payout}')::numeric, p_source)
    on conflict (booking_id) do update set
      currency = coalesce(excluded.currency, public.booking_financials.currency),
      discount_amount = coalesce(excluded.discount_amount, public.booking_financials.discount_amount),
      channel_fee = coalesce(excluded.channel_fee, public.booking_financials.channel_fee),
      expected_payout = coalesce(excluded.expected_payout, public.booking_financials.expected_payout),
      updated_at = now();
  end if;

  insert into public.booking_source_snapshots (booking_id, organization_id, payload)
  values (v_b.id, v_org, public._sanitize_payload(p_data))
  on conflict (booking_id) do update set payload = excluded.payload, captured_at = now();

  if v_status = 'cancelled' and not v_is_new and v_b.status <> 'cancelled' then
    perform public._flag_if_assigned(v_b.id, v_old_departure, 'Booking bị hủy sau khi đã phân công');
  end if;

  if cardinality(v_reasons) > 0 then
    update public.bookings set needs_action = true, action_reason = array_to_string(v_reasons, '; ')
    where id = v_b.id;
  end if;

  if v_is_new then
    insert into public.booking_changes (organization_id, booking_id, change_type, summary, source, event_id)
    values (v_org, v_b.id, 'created', 'Nhận booking mới', p_source, p_event);
  elsif cardinality(v_changes) > 0 then
    insert into public.booking_changes
      (organization_id, booking_id, change_type, summary, source, event_id, channel_request_status)
    values (v_org, v_b.id, 'updated', array_to_string(v_changes, '; '), p_source, p_event,
      case when p_source = 'channel' then 'confirmed'::public.channel_request_status else 'not_applicable' end);
  end if;

  perform public._recompute_booking_ops(v_b.id);

  insert into public.outbox_events (organization_id, topic, aggregate_id, payload, correlation_id)
  values (v_org, case when v_is_new then 'booking.created' else 'booking.updated' end, v_b.id::text,
    jsonb_build_object('code', v_b.code, 'needs_action', cardinality(v_reasons) > 0,
      'reasons', to_jsonb(v_reasons), 'changes', to_jsonb(v_changes)), p_event::text),
    (v_org, 'availability.changed', v_b.id::text, '{}', p_event::text);

  return jsonb_build_object('ok', true, 'booking_id', v_b.id, 'code', v_b.code, 'created', v_is_new,
    'queued', cardinality(v_reasons) > 0, 'reasons', to_jsonb(v_reasons));
end $$;

-- ============================================================================
-- Sự kiện kênh
-- ============================================================================

-- Xử lý một sự kiện đã lưu. Lỗi nằm trong khối con nên giao dịch ngoài vẫn commit được trạng thái lỗi.
create function public._process_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_e public.integration_events%rowtype;
  v_c public.channel_connections%rowtype;
  v_b public.bookings%rowtype;
  v_result jsonb;
  v_state text;
  v_msg text;
  v_max constant int := 6;
  v_ordering boolean := true;
begin
  select * into v_e from public.integration_events where id = p_event for update;
  if v_e.status in ('processed', 'ignored_stale') then
    return v_e.result;
  end if;
  select * into v_c from public.channel_connections where id = v_e.connection_id;

  update public.integration_events set attempts = attempts + 1 where id = p_event;

  begin
    select * into v_b from public.bookings
    where organization_id = v_e.organization_id and connection_id = v_e.connection_id
      and external_ref = v_e.external_ref
    for update;

    if v_e.source_version is null and v_e.source_at is null then
      -- Nguồn không cho thứ tự tin cậy: vẫn áp dụng, gắn cờ để đối chiếu, không giả định.
      v_ordering := false;
    end if;

    if found and (
      (v_e.source_version is not null and v_b.last_source_version is not null
        and v_e.source_version <= v_b.last_source_version)
      or (v_e.source_version is null and v_e.source_at is not null and v_b.last_source_at is not null
        and v_e.source_at < v_b.last_source_at)
    ) then
      v_result := jsonb_build_object('ok', true, 'code', 'stale_ignored', 'booking_id', v_b.id);
      update public.integration_events
      set status = 'ignored_stale', result = v_result, processed_at = now(), next_attempt_at = null,
          last_error = null, ordering_verified = v_ordering
      where id = p_event;
      return v_result;
    end if;

    if v_e.event_type = 'booking.cancelled' then
      if v_b.id is null then
        -- Hủy đến trước tạo: chờ retry. Không tạo booking rỗng.
        raise exception 'booking_not_found' using errcode = 'TH001';
      end if;
      perform public._cancel_booking(v_b.id, 'channel', p_event, v_e.payload ->> 'channel_status');
      update public.bookings set
        last_source_version = coalesce(v_e.source_version, last_source_version),
        last_source_at = coalesce(v_e.source_at, last_source_at)
      where id = v_b.id;
      v_result := jsonb_build_object('ok', true, 'booking_id', v_b.id, 'code', 'cancelled');
    else
      if cardinality(public._validate_booking_data(v_e.payload)) > 0 then
        raise exception 'invalid_payload' using errcode = 'TH002',
          detail = array_to_string(public._validate_booking_data(v_e.payload), '; ');
      end if;
      v_result := public._apply_booking_data(v_c, v_e.payload, 'channel', p_event, v_e.source_at, v_e.source_version);
    end if;

    update public.integration_events
    set status = 'processed', result = v_result, processed_at = now(), next_attempt_at = null,
        last_error = null, ordering_verified = v_ordering
    where id = p_event;
    return v_result;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    update public.integration_events set
      status = case
        when v_state = 'TH002' or attempts >= v_max then 'dead'::public.event_status
        else 'failed'::public.event_status
      end,
      last_error = v_state || ': ' || v_msg,
      -- Exponential backoff có jitter: 30s, 60s, 120s... tối đa 1 giờ, nhân ngẫu nhiên 0.5-1.
      next_attempt_at = case
        when v_state = 'TH002' or attempts >= v_max then null
        else now() + make_interval(secs => least(3600, 30 * power(2, attempts - 1)) * (0.5 + random() * 0.5))
      end
    where id = p_event;
    update public.channel_connections set last_error = v_msg, last_error_at = now() where id = v_e.connection_id;
    return jsonb_build_object('ok', false, 'code', v_msg, 'retryable', v_state <> 'TH002');
  end;
end $$;

-- Kiểm tra người gọi có được thay mặt kênh hay không. Kết nối mô phỏng: người có connection.simulate.
-- Kết nối thật: chỉ service_role (cổng nhận yêu cầu từ kênh, đã xác minh chữ ký/khóa).
create function public._require_channel_caller(p_connection uuid) returns public.channel_connections
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.channel_connections%rowtype;
begin
  select * into v_c from public.channel_connections where id = p_connection;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (select auth.role()) = 'service_role' then
    return v_c;
  end if;
  if v_c.mode = 'mock' and public.has_org_permission(v_c.organization_id, 'connection.simulate') then
    return v_c;
  end if;
  raise exception 'forbidden' using errcode = '42501', detail = 'connection.simulate';
end $$;

create function public._touch_connection(p_connection public.channel_connections) returns void
language sql security definer set search_path = '' as $$
  update public.channel_connections set
    last_simulated_at = case when mode = 'mock' then now() else last_simulated_at end,
    last_success_at = case when mode <> 'mock' then now() else last_success_at end
  where id = p_connection.id;
$$;

-- Đường vào duy nhất của sự kiện kênh. Gửi lại cùng event_key trả đúng kết quả cũ, không xử lý lần hai.
create function public.ingest_channel_event(p_connection uuid, p_event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  v_key text;
  v_id uuid;
  v_existing public.integration_events%rowtype;
  v_payload jsonb := public._sanitize_payload(coalesce(p_event -> 'data', '{}'::jsonb));
  v_result jsonb;
begin
  if p_event ->> 'type' not in ('booking.created', 'booking.updated', 'booking.cancelled') then
    return jsonb_build_object('ok', false, 'code', 'unknown_event_type');
  end if;
  if coalesce(p_event ->> 'external_ref', v_payload ->> 'external_ref', '') = '' then
    return jsonb_build_object('ok', false, 'code', 'missing_external_ref');
  end if;

  v_key := coalesce(nullif(p_event ->> 'event_id', ''),
    'hash:' || encode(sha256(convert_to(p_event::text, 'UTF8')), 'hex'));

  insert into public.integration_events
    (organization_id, connection_id, event_key, event_type, external_ref, source_at, source_version,
     payload, is_simulated, correlation_id)
  values (v_c.organization_id, v_c.id, v_key, p_event ->> 'type',
    coalesce(p_event ->> 'external_ref', v_payload ->> 'external_ref'),
    (p_event ->> 'source_at')::timestamptz, (p_event ->> 'version')::bigint,
    v_payload, v_c.mode = 'mock', coalesce(p_event ->> 'correlation_id', gen_random_uuid()::text))
  on conflict (organization_id, connection_id, event_key) do nothing
  returning id into v_id;

  if v_id is null then
    update public.integration_events set duplicate_count = duplicate_count + 1
    where organization_id = v_c.organization_id and connection_id = v_c.id and event_key = v_key
    returning * into v_existing;
    return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing.id,
      'status', v_existing.status, 'result', v_existing.result);
  end if;

  v_result := public._process_event(v_id);
  perform public._touch_connection(v_c);
  return v_result || jsonb_build_object('event_id', v_id);
end $$;

-- ============================================================================
-- Giữ chỗ theo đúng chiều gọi của Viator/GetYourGuide: kênh gọi vào, phản hồi tức thời, nên giao dịch
-- phải hoàn tất trước khi trả về. Thời hạn lấy từ cấu hình từng kết nối.
-- ============================================================================

create function public.channel_reserve(
  p_connection uuid, p_departure uuid, p_quantity int, p_reference text, p_ttl_seconds int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  v_d public.departures%rowtype;
  v_h public.inventory_holds%rowtype;
  v_available int;
begin
  if p_quantity is null or p_quantity <= 0 or coalesce(p_reference, '') = '' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  select * into v_d from public.departures
  where id = p_departure and organization_id = v_c.organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'departure_not_found');
  end if;

  perform public._lock_pools(array[v_d.inventory_pool_id]);

  -- Thử lại sau timeout: cùng mã trả đúng hold cũ, không giữ thêm.
  select * into v_h from public.inventory_holds
  where organization_id = v_c.organization_id and connection_id = v_c.id and reference = p_reference;
  if found then
    return jsonb_build_object('ok', v_h.status in ('active', 'converted') and (v_h.status = 'converted' or v_h.expires_at > now()),
      'code', case when v_h.status = 'active' and v_h.expires_at <= now() then 'hold_expired' else 'existing' end,
      'hold_id', v_h.id, 'status', v_h.status, 'expires_at', v_h.expires_at);
  end if;

  if v_d.status <> 'scheduled' or not v_d.sale_open or now() >= v_d.cutoff_at then
    return jsonb_build_object('ok', false, 'code', 'not_on_sale');
  end if;

  v_available := public._pool_available(v_d.inventory_pool_id);
  if p_quantity > v_available then
    return jsonb_build_object('ok', false, 'code', 'no_seats', 'available', v_available);
  end if;

  insert into public.inventory_holds
    (organization_id, departure_id, inventory_pool_id, connection_id, reference, quantity, expires_at)
  values (v_c.organization_id, v_d.id, v_d.inventory_pool_id, v_c.id, p_reference, p_quantity,
    now() + make_interval(secs => coalesce(p_ttl_seconds, v_c.hold_ttl_seconds)))
  returning * into v_h;

  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_c.organization_id, 'availability.changed', v_d.id::text, '{}');
  perform public._touch_connection(v_c);

  return jsonb_build_object('ok', true, 'code', 'held', 'hold_id', v_h.id, 'status', v_h.status,
    'expires_at', v_h.expires_at, 'available_after', v_available - p_quantity);
end $$;

create function public.channel_cancel_reservation(p_connection uuid, p_reference text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  v_h public.inventory_holds%rowtype;
begin
  select * into v_h from public.inventory_holds
  where organization_id = v_c.organization_id and connection_id = v_c.id and reference = p_reference;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'hold_not_found');
  end if;
  perform public._lock_pools(array[v_h.inventory_pool_id]);
  select * into v_h from public.inventory_holds where id = v_h.id for update;
  if v_h.status = 'converted' then
    return jsonb_build_object('ok', false, 'code', 'already_booked');
  end if;
  -- Hủy lặp là thành công, không có gì để trả thêm.
  if v_h.status = 'active' then
    update public.inventory_holds set status = 'released' where id = v_h.id;
    insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
    values (v_c.organization_id, 'availability.changed', v_h.departure_id::text, '{}');
  end if;
  perform public._touch_connection(v_c);
  return jsonb_build_object('ok', true, 'code', 'released');
end $$;

-- Xác nhận booking từ hold: chuyển chỗ giữ sang chỗ đặt trong cùng giao dịch, không tính hai lần.
-- Kênh gửi lại (GetYourGuide nêu rõ có retry) nhận đúng booking cũ.
create function public.channel_book(p_connection uuid, p_reference text, p_data jsonb) returns jsonb
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
    v_result := public._apply_booking_data(v_c, v_data, 'channel', null,
      (p_data ->> 'source_at')::timestamptz, (p_data ->> 'version')::bigint, v_h.id);
    if not exists (select 1 from public.inventory_holds where id = v_h.id and status = 'converted') then
      -- Không xếp được vào đúng chuyến giữ thì không được giả vờ thành công.
      raise exception 'hold_not_converted' using errcode = 'TH003';
    end if;
  exception when sqlstate 'TH003' then
    return jsonb_build_object('ok', false, 'code', 'no_seats');
  end;

  perform public._touch_connection(v_c);
  return v_result;
end $$;

-- ============================================================================
-- Worker. Không cấp cho authenticated.
-- ============================================================================

create function public.worker_expire_holds() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  with expired as (
    update public.inventory_holds set status = 'expired'
    where status = 'active' and expires_at <= now()
    returning organization_id, departure_id
  ), notify as (
    insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
    select organization_id, 'availability.changed', departure_id::text, '{}' from expired
    returning 1
  )
  select count(*) into v_count from notify;
  return v_count;
end $$;

-- SKIP LOCKED để nhiều worker chạy song song không xử lý trùng.
create function public.worker_retry_events(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_done int := 0;
begin
  for r in
    select id from public.integration_events
    where status = 'failed' and next_attempt_at <= now()
    order by next_attempt_at
    limit p_limit
    for update skip locked
  loop
    perform public._process_event(r.id);
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('retried', v_done);
end $$;

create function public.worker_claim_outbox(p_limit int default 50)
returns setof public.outbox_events
language sql security definer set search_path = '' as $$
  update public.outbox_events e
  set status = 'running', attempts = e.attempts + 1
  where e.id in (
    select id from public.outbox_events
    where status in ('pending', 'failed') and run_after <= now()
    order by id
    limit p_limit
    for update skip locked
  )
  returning e.*;
$$;

create function public.worker_finish_outbox(p_id bigint, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_error is null then
    update public.outbox_events set status = 'done', processed_at = now(), last_error = null where id = p_id;
  else
    update public.outbox_events set
      status = case when attempts >= 6 then 'dead'::public.job_status else 'failed'::public.job_status end,
      last_error = p_error,
      run_after = now() + make_interval(secs => least(3600, 30 * power(2, attempts - 1)) * (0.5 + random() * 0.5))
    where id = p_id;
  end if;
end $$;

-- Kết nối quá lâu không liên lạc: đánh dấu booking của nó "dữ liệu có thể đã cũ" (đặc tả §9.4).
create function public.worker_mark_stale_connections() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  update public.bookings b set sync_status = 'stale'
  from public.channel_connections c
  where b.connection_id = c.id and b.sync_status = 'synced' and c.mode <> 'mock'
    and c.last_success_at < now() - make_interval(mins => c.stale_after_minutes);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Chính sách lưu giữ: xóa payload sự kiện đã xử lý quá hạn, giữ lại khung sự kiện để truy vết.
create function public.worker_purge_payloads() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  update public.integration_events e set payload = '{"purged": true}'::jsonb
  from public.organizations o
  where o.id = e.organization_id and e.status in ('processed', 'ignored_stale')
    and e.received_at < now() - make_interval(days => o.payload_retention_days)
    and e.payload <> '{"purged": true}'::jsonb;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Dựng thông báo nội bộ cho một bản ghi outbox. dedupe_key chống tạo trùng khi worker chạy lại.
create function public.worker_notify(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.outbox_events%rowtype;
  v_code text;
begin
  select * into e from public.outbox_events where id = p_id;
  v_code := e.payload ->> 'code';
  if e.topic = 'booking.created' and coalesce((e.payload ->> 'needs_action')::boolean, false) then
    insert into public.notifications (organization_id, kind, title, body, link, dedupe_key)
    values (e.organization_id, 'booking_queue', 'Booking cần xử lý: ' || v_code, e.payload -> 'reasons' ->> 0,
      '/bookings/' || e.aggregate_id, 'outbox:' || e.id) on conflict do nothing;
  elsif e.topic = 'booking.created' then
    insert into public.notifications (organization_id, kind, title, link, dedupe_key)
    values (e.organization_id, 'booking_new', 'Booking mới: ' || v_code,
      '/bookings/' || e.aggregate_id, 'outbox:' || e.id) on conflict do nothing;
  elsif e.topic = 'booking.cancelled' then
    insert into public.notifications (organization_id, kind, title, link, dedupe_key)
    values (e.organization_id, 'booking_cancelled', 'Booking bị hủy: ' || v_code,
      '/bookings/' || e.aggregate_id, 'outbox:' || e.id) on conflict do nothing;
  elsif e.topic = 'booking.updated' and jsonb_array_length(coalesce(e.payload -> 'changes', '[]')) > 0 then
    insert into public.notifications (organization_id, kind, title, body, link, dedupe_key)
    values (e.organization_id, 'booking_changed', 'Booking thay đổi: ' || v_code, e.payload -> 'changes' ->> 0,
      '/bookings/' || e.aggregate_id, 'outbox:' || e.id) on conflict do nothing;
  end if;
end $$;
