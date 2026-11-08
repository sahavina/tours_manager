-- Nhiều chuyến cùng gói, ngày, giờ: một xe chỉ chở được sức chứa của gói, nên khách dư đi chuyến thứ 2, thứ 3.
-- Khách vẫn đi đúng giờ đã mua trên kênh, nên đổi giữa các chuyến này không phải sửa gì trên kênh.
alter table public.departures add column slot_no int not null default 1 check (slot_no >= 1);
drop index public.departures_slot_uq;
create unique index departures_slot_uq on public.departures
  (organization_id, tour_id, tour_option_id, local_date, local_time, slot_no) nulls not distinct;

create or replace function public._resolve_item(
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
  -- Ưu tiên chuyến riêng của gói hơn chuyến chung của tour, rồi chuyến cùng giờ còn chỗ có số nhỏ nhất.
  order by (d.tour_option_id is null), (public._pool_available(d.inventory_pool_id) <= 0), d.slot_no, d.id
  limit 1;
  if not found then
    select t.default_timezone into o_tz from public.tours t where t.id = o_tour;
    o_departure := null;
  end if;
end $$;

create or replace function public.move_booking_item(p_item uuid, p_departure uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_i public.booking_items%rowtype;
  v_b public.bookings%rowtype;
  v_to public.departures%rowtype;
  v_place text;
  v_first boolean;
  v_same_time boolean;
  v_channel_status public.channel_request_status;
begin
  select * into v_i from public.booking_items where id = p_item;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;
  perform public._require(v_i.organization_id, 'ops.manage');
  select * into v_b from public.bookings where id = v_i.booking_id for update;
  if v_b.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'booking_cancelled');
  end if;
  select * into v_to from public.departures
  where id = p_departure and organization_id = v_i.organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'departure_not_found');
  end if;

  v_first := v_i.departure_id is null
    and v_i.tour_id is not distinct from v_to.tour_id
    and v_i.local_date is not distinct from v_to.local_date
    and v_i.local_time is not distinct from v_to.local_time
    and (v_to.tour_option_id is null or v_to.tour_option_id is not distinct from v_i.tour_option_id);

  -- Đổi sang chuyến khác cùng gói, ngày, giờ: khách vẫn đi đúng giờ đã mua, không có gì phải sửa trên kênh.
  v_same_time := v_i.tour_id is not distinct from v_to.tour_id
    and v_i.local_date is not distinct from v_to.local_date
    and v_i.local_time is not distinct from v_to.local_time
    and (v_to.tour_option_id is null or v_to.tour_option_id is not distinct from v_i.tour_option_id);

  v_place := public._place_item(p_item, p_departure, v_i.seats);
  if v_place <> 'ok' then
    return jsonb_build_object('ok', false, 'code', v_place);
  end if;

  update public.booking_items set
    tour_id = v_to.tour_id, local_date = v_to.local_date, local_time = v_to.local_time, timezone = v_to.timezone,
    tour_option_id = coalesce(v_to.tour_option_id, tour_option_id)
  where id = p_item;

  perform public._flag_if_assigned(v_b.id, v_i.departure_id, 'Khách đã chuyển khỏi chuyến đã phân công');
  perform public._flag_if_assigned(v_b.id, p_departure, 'Có khách mới chuyển vào chuyến đã phân công');

  -- Đổi nội bộ không tự sang kênh. Booking từ kênh cần xử lý tay trên kênh và phải được ghi rõ.
  v_channel_status := case when v_b.connection_id is null or v_first or v_same_time then 'not_applicable'::public.channel_request_status
    else 'manual_required'::public.channel_request_status end;

  insert into public.booking_changes
    (organization_id, booking_id, change_type, summary, before_data, after_data, source, actor_id, channel_request_status)
  values (v_i.organization_id, v_b.id, case when v_first then 'placed' else 'moved' end,
    case when v_first then format('Xếp vào chuyến: %s %s', v_to.local_date, v_to.local_time)
      else format('Chuyển chuyến: %s %s → %s %s', v_i.local_date, v_i.local_time, v_to.local_date, v_to.local_time) end,
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure),
    'internal', (select auth.uid()), v_channel_status);

  -- Chỉ gỡ cờ chờ xếp chuyến do hệ thống đặt; cờ do người đánh dấu hoặc lý do khác vẫn giữ.
  update public.bookings set needs_action = false, action_reason = null
  where id = v_b.id and needs_action and public._is_waiting_departure_reason(action_reason)
    and not exists (select 1 from public.booking_items x where x.booking_id = v_b.id and x.departure_id is null);

  perform public._recompute_booking_ops(v_b.id);
  perform public._audit(v_i.organization_id, 'move', 'booking_items', p_item::text,
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure));
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_i.organization_id, 'availability.changed', p_item::text, '{}');

  return jsonb_build_object('ok', true, 'channel_request_status', v_channel_status);
end $$;

create or replace view public.v_departure_availability with (security_barrier = true) as
select
  d.id, d.organization_id, d.tour_id, d.tour_option_id, d.inventory_pool_id,
  d.local_date, d.local_time, d.timezone, d.starts_at, d.cutoff_at, d.sale_open, d.status, d.note,
  d.outcome, d.supplier_confirmed_at,
  t.code as tour_code, t.name as tour_name, o.name as option_name, o.code as option_code,
  p.name as pool_name, p.capacity, p.blocked_seats,
  c.seats as committed_seats,
  h.seats as held_seats,
  p.capacity - p.blocked_seats - c.seats - h.seats as available_seats,
  (select coalesce(sum(i.committed_seats), 0)::int from public.booking_items i where i.departure_id = d.id) as departure_seats,
  (select count(*)::int from public.guide_assignments g where g.departure_id = d.id) as guide_count,
  (select count(*)::int from public.vehicle_assignments v where v.departure_id = d.id) as vehicle_count,
  -- Chuyến "Mọi gói" có thể chứa booking gói riêng, nên phải xét cả gói của booking.
  coalesce(o.is_private, false) or m.has_private as is_private,
  m.bookings as booking_count,
  mix.channels as channel_mix,
  d.slot_no,
  o.default_capacity
from public.departures d
join public.tours t on t.id = d.tour_id
left join public.tour_options o on o.id = d.tour_option_id
join public.inventory_pools p on p.id = d.inventory_pool_id
cross join lateral (
  select coalesce(sum(i.committed_seats), 0)::int as seats
  from public.booking_items i join public.departures d2 on d2.id = i.departure_id
  where d2.inventory_pool_id = p.id and i.committed_seats > 0
) c
cross join lateral (
  select coalesce(sum(x.quantity), 0)::int as seats
  from public.inventory_holds x
  where x.inventory_pool_id = p.id and x.status = 'active' and x.expires_at > now()
) h
cross join lateral (
  select count(distinct i.booking_id)::int as bookings, coalesce(bool_or(op.is_private), false) as has_private
  from public.booking_items i
  left join public.tour_options op on op.id = i.tour_option_id
  where i.departure_id = d.id and i.committed_seats > 0
) m
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object('channel', z.channel, 'bookings', z.bookings, 'seats', z.seats) order by z.channel), '[]'::jsonb) as channels
  from (
    select coalesce(cc.channel::text, 'manual') as channel, count(distinct i.booking_id)::int as bookings, sum(i.committed_seats)::int as seats
    from public.booking_items i
    join public.bookings b on b.id = i.booking_id
    left join public.channel_connections cc on cc.id = b.connection_id
    where i.departure_id = d.id and i.committed_seats > 0
    group by 1
  ) z
) mix
where public.has_org_permission(d.organization_id, 'departure.read');

create or replace function public.ops_board(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'ops.read');
  return (
    select coalesce(jsonb_agg(row_to_json(x) order by x.starts_at), '[]'::jsonb) from (
      select
        d.id, d.starts_at, d.local_date, d.local_time, d.timezone, d.status, d.supplier_confirmed_at,
        t.name as tour_name, o.name as option_name,
        coalesce(s.seats, 0) as seats, coalesce(s.bookings, 0) as bookings,
        coalesce(g.n, 0) as guides, coalesce(v.n, 0) as vehicles, coalesce(v.seats, 0) as vehicle_seats,
        coalesce(s.seats, 0) > 0 and coalesce(g.n, 0) = 0 as missing_guide,
        coalesce(s.seats, 0) > 0 and coalesce(v.n, 0) = 0 as missing_vehicle,
        coalesce(s.seats, 0) > coalesce(v.seats, 0) and coalesce(v.n, 0) > 0 as vehicle_over,
        coalesce(s.missing_pickup, 0) as missing_pickup,
        coalesce(s.changed, 0) as changed_after_assignment,
        coalesce(s.needs_action, 0) as needs_contact,
        coalesce(s.unallocated, 0) as unallocated,
        d.supplier_confirmed_at is null and coalesce(v.n, 0) > 0 as supplier_unconfirmed,
        coalesce(o.is_private, false) or coalesce(s.has_private, false) as is_private,
        mix.channels as channel_mix,
        cl.guide_clash, cl.vehicle_clash, cl.possible_clash,
        d.slot_no
      from public.departures d
      join public.tours t on t.id = d.tour_id
      left join public.tour_options o on o.id = d.tour_option_id
      left join lateral (
        select sum(i.committed_seats)::int as seats, count(distinct i.booking_id)::int as bookings,
          count(*) filter (where op.has_transfer and coalesce(pk.hotel_name, pk.address, '') = '')::int as missing_pickup,
          count(distinct b.id) filter (where b.changed_after_assignment)::int as changed,
          count(distinct b.id) filter (where b.needs_action)::int as needs_action,
          count(*) filter (where not exists (select 1 from public.passenger_allocations a where a.booking_item_id = i.id and a.is_active))::int as unallocated,
          bool_or(op.is_private) as has_private
        from public.booking_items i
        join public.bookings b on b.id = i.booking_id
        left join public.tour_options op on op.id = i.tour_option_id
        left join public.booking_pickups pk on pk.booking_item_id = i.id
        where i.departure_id = d.id and i.committed_seats > 0
      ) s on true
      left join lateral (select count(*)::int as n from public.guide_assignments ga where ga.departure_id = d.id) g on true
      left join lateral (
        select count(*)::int as n, sum(ve.seats)::int as seats
        from public.vehicle_assignments va join public.vehicles ve on ve.id = va.vehicle_id
        where va.departure_id = d.id
      ) v on true
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('channel', z.channel, 'bookings', z.bookings, 'seats', z.seats) order by z.channel), '[]'::jsonb) as channels
        from (
          select coalesce(cc.channel::text, 'manual') as channel, count(distinct i.booking_id)::int as bookings, sum(i.committed_seats)::int as seats
          from public.booking_items i
          join public.bookings b on b.id = i.booking_id
          left join public.channel_connections cc on cc.id = b.connection_id
          where i.departure_id = d.id and i.committed_seats > 0
          group by 1
        ) z
      ) mix
      -- Chỉ tính HDV và xe đã gán vào chính chuyến này; danh sách đầy đủ để dành cho màn phân công.
      cross join lateral (
        select
          count(*) filter (where c.kind = 'guide' and c.level = 'overlap')::int as guide_clash,
          count(*) filter (where c.kind = 'vehicle' and c.level = 'overlap')::int as vehicle_clash,
          count(*) filter (where c.level = 'possible')::int as possible_clash
        from public._assignment_clashes(d.id) c
        where (c.kind = 'guide' and exists (select 1 from public.guide_assignments ga where ga.departure_id = d.id and ga.guide_id = c.resource_id))
           or (c.kind = 'vehicle' and exists (select 1 from public.vehicle_assignments va where va.departure_id = d.id and va.vehicle_id = c.resource_id))
      ) cl
      where d.organization_id = p_org and d.local_date between p_from and p_to
    ) x
  );
end $$;

-- Chuyến cùng giờ còn đủ chỗ cho một booking. Tour riêng chỉ nhận chuyến chưa có khách.
create function public._find_slot(p_org uuid, p_tour uuid, p_option uuid, p_date date, p_time time, p_seats int, p_private boolean, p_except uuid default null)
returns uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.departures d
  where d.organization_id = p_org and d.tour_id = p_tour and d.status = 'scheduled'
    and d.local_date = p_date and d.local_time = p_time
    and (d.tour_option_id = p_option or d.tour_option_id is null)
    and d.id is distinct from p_except
    and public._pool_available(d.inventory_pool_id) >= p_seats
    and (not p_private or not exists (select 1 from public.booking_items x where x.departure_id = d.id and x.committed_seats > 0))
  order by (d.tour_option_id is null), d.slot_no, d.id
  limit 1;
$$;

-- Mở chuyến tiếp theo cùng giờ. Người gọi phải kiểm tra quyền departure.manage.
create function public._create_slot(p_org uuid, p_tour uuid, p_option uuid, p_date date, p_time time, p_timezone text, p_capacity int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_pool uuid;
  v_id uuid;
  v_slot int;
begin
  select coalesce(max(d.slot_no), 0) + 1 into v_slot from public.departures d
  where d.organization_id = p_org and d.tour_id = p_tour and d.tour_option_id is not distinct from p_option
    and d.local_date = p_date and d.local_time = p_time;
  insert into public.inventory_pools (organization_id, name, capacity)
  values (p_org, format('%s %s #%s', p_date, p_time, v_slot), p_capacity) returning id into v_pool;
  insert into public.departures (organization_id, tour_id, tour_option_id, inventory_pool_id, local_date, local_time, timezone, starts_at, slot_no)
  values (p_org, p_tour, p_option, v_pool, p_date, p_time, p_timezone, now(), v_slot) returning id into v_id;
  perform public._audit(p_org, 'create', 'departures', v_id::text);
  return v_id;
end $$;

create or replace function public.place_waiting_bookings(
  p_org uuid, p_dry_run boolean default true, p_create_capacity int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g record;
  it record;
  v_dep uuid;
  v_available int;
  v_res jsonb;
  v_rows jsonb := '[]';
  v_placed int := 0;
  v_created int := 0;
  v_no_seats int := 0;
  v_private int := 0;
  v_row_placed int;
  v_row_private int;
  v_unmapped int;
  v_past int;
  v_capacity int;
  v_target uuid;
begin
  perform public._require(p_org, 'ops.manage');
  if p_create_capacity is not null and p_create_capacity < 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_capacity');
  end if;

  select
    count(*) filter (where i.tour_option_id is null or i.local_date is null or i.local_time is null)::int,
    count(*) filter (where i.tour_option_id is not null and i.local_date < (now() at time zone coalesce(i.timezone, 'UTC'))::date)::int
  into v_unmapped, v_past
  from public.booking_items i join public.bookings b on b.id = i.booking_id
  where i.organization_id = p_org and i.departure_id is null and b.status <> 'cancelled';

  for g in
    select i.tour_id, i.tour_option_id, i.local_date, i.local_time,
      coalesce(max(i.timezone), max(t.default_timezone)) as tz,
      t.name as tour_name, o.name as option_name, o.is_private, o.default_capacity,
      count(distinct i.booking_id)::int as bookings, sum(i.seats)::int as seats
    from public.booking_items i
    join public.bookings b on b.id = i.booking_id
    join public.tours t on t.id = i.tour_id
    join public.tour_options o on o.id = i.tour_option_id
    where i.organization_id = p_org and i.departure_id is null and b.status <> 'cancelled'
      and i.local_date is not null and i.local_time is not null
      and i.local_date >= (now() at time zone coalesce(i.timezone, 'UTC'))::date
    group by i.tour_id, i.tour_option_id, i.local_date, i.local_time, t.name, o.name, o.is_private, o.default_capacity
    order by i.local_date, i.local_time, t.name, o.name
  loop
    -- Cùng quy tắc với _resolve_item: ưu tiên chuyến của gói, rồi chuyến cùng giờ còn chỗ.
    select d.id into v_dep from public.departures d
    where d.organization_id = p_org and d.tour_id = g.tour_id and d.status = 'scheduled'
      and d.local_date = g.local_date and d.local_time = g.local_time
      and (d.tour_option_id = g.tour_option_id or d.tour_option_id is null)
    order by (d.tour_option_id is null), (public._pool_available(d.inventory_pool_id) <= 0), d.slot_no, d.id
    limit 1;

    v_available := null;
    if v_dep is not null then
      select public._pool_available(d.inventory_pool_id) into v_available from public.departures d where d.id = v_dep;
    end if;
    v_row_placed := 0;
    v_row_private := 0;

    if not p_dry_run then
      v_capacity := coalesce(g.default_capacity, p_create_capacity);
      for it in
        select i.id, i.seats from public.booking_items i
        join public.bookings b on b.id = i.booking_id
        where i.organization_id = p_org and i.departure_id is null and b.status <> 'cancelled'
          and i.tour_option_id = g.tour_option_id and i.local_date = g.local_date and i.local_time = g.local_time
        order by b.booked_at nulls last, i.id
      loop
        v_target := public._find_slot(p_org, g.tour_id, g.tour_option_id, g.local_date, g.local_time, it.seats, g.is_private);
        if v_target is null and v_capacity is not null then
          -- Chuyến cùng giờ đã đủ: mở chuyến tiếp theo. Đoàn lớn hơn sức chứa đi trọn một chuyến, không tách đoàn.
          perform public._require(p_org, 'departure.manage');
          v_target := public._create_slot(p_org, g.tour_id, g.tour_option_id, g.local_date, g.local_time, g.tz, greatest(v_capacity, it.seats));
          v_created := v_created + 1;
        end if;
        if v_target is null then
          if g.is_private and v_dep is not null then
            v_private := v_private + 1;
            v_row_private := v_row_private + 1;
          elsif v_dep is not null then
            v_no_seats := v_no_seats + 1;
          end if;
          continue;
        end if;
        v_res := public.move_booking_item(it.id, v_target);
        if (v_res ->> 'ok')::boolean then
          v_placed := v_placed + 1;
          v_row_placed := v_row_placed + 1;
          v_dep := v_target;
        else
          v_no_seats := v_no_seats + 1;
        end if;
      end loop;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'tour_name', g.tour_name, 'option_name', g.option_name, 'is_private', g.is_private, 'default_capacity', g.default_capacity,
      'local_date', g.local_date, 'local_time', g.local_time,
      'bookings', g.bookings, 'seats', g.seats,
      'departure_id', v_dep, 'available_seats', v_available,
      'placed', v_row_placed, 'skipped_private', v_row_private);
  end loop;

  return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'rows', v_rows,
    'placed', v_placed, 'created', v_created, 'no_seats', v_no_seats, 'skipped_private', v_private,
    'unmapped', v_unmapped, 'past', v_past);
end $$;

-- Tách chuyến đang quá sức chứa của gói: giữ lại khách đến khi đủ, chuyển phần dư sang chuyến khác cùng giờ.
-- Không tách một booking: đoàn lớn hơn sức chứa đi trọn một chuyến và được báo lại.
create function public.split_departure(p_departure uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_d public.departures%rowtype;
  v_cap int;
  v_private boolean;
  v_blocked int;
  v_kept int := 0;
  v_moved int := 0;
  v_created int := 0;
  v_failed int := 0;
  v_over jsonb := '[]';
  v_target uuid;
  v_res jsonb;
  it record;
begin
  select * into v_d from public.departures where id = p_departure;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'departure_not_found');
  end if;
  perform public._require(v_d.organization_id, 'departure.manage');
  perform public._require(v_d.organization_id, 'ops.manage');
  if v_d.status <> 'scheduled' then
    return jsonb_build_object('ok', false, 'code', 'not_scheduled');
  end if;
  select o.default_capacity, o.is_private into v_cap, v_private from public.tour_options o where o.id = v_d.tour_option_id;
  if v_cap is null then
    return jsonb_build_object('ok', false, 'code', 'no_default_capacity');
  end if;
  if (select count(*) from public.departures x where x.inventory_pool_id = v_d.inventory_pool_id) > 1 then
    return jsonb_build_object('ok', false, 'code', 'shared_pool');
  end if;

  -- Đoàn lớn trước, để đoàn nhỏ lấp vào chỗ còn lại thay vì mở thêm chuyến.
  for it in
    select i.id, i.committed_seats as seats, b.code
    from public.booking_items i join public.bookings b on b.id = i.booking_id
    where i.departure_id = p_departure and i.committed_seats > 0
    order by i.committed_seats desc, b.booked_at nulls last, i.id
  loop
    if it.seats > v_cap then
      v_over := v_over || jsonb_build_object('code', it.code, 'seats', it.seats);
    end if;
    if v_kept = 0 or (v_kept + it.seats <= v_cap and not v_private) then
      v_kept := v_kept + it.seats;
      continue;
    end if;
    v_target := public._find_slot(v_d.organization_id, v_d.tour_id, v_d.tour_option_id, v_d.local_date, v_d.local_time, it.seats, coalesce(v_private, false), p_departure);
    if v_target is null then
      v_target := public._create_slot(v_d.organization_id, v_d.tour_id, v_d.tour_option_id, v_d.local_date, v_d.local_time, v_d.timezone, greatest(v_cap, it.seats));
      v_created := v_created + 1;
    end if;
    v_res := public.move_booking_item(it.id, v_target);
    if (v_res ->> 'ok')::boolean then
      v_moved := v_moved + 1;
    else
      v_failed := v_failed + 1;
      v_kept := v_kept + it.seats;
    end if;
  end loop;

  select p.blocked_seats into v_blocked from public.inventory_pools p where p.id = v_d.inventory_pool_id;
  v_res := public.update_pool_capacity(v_d.inventory_pool_id, greatest(v_cap, v_kept), v_blocked);
  return jsonb_build_object('ok', true, 'moved', v_moved, 'created', v_created, 'failed', v_failed, 'kept', v_kept, 'oversized', v_over, 'capacity_set', (v_res ->> 'ok')::boolean);
end $$;

revoke all on function public.split_departure(uuid), public._find_slot(uuid, uuid, uuid, date, time, int, boolean, uuid), public._create_slot(uuid, uuid, uuid, date, time, text, int) from public, anon, authenticated;
grant execute on function public.split_departure(uuid) to authenticated, service_role;
grant execute on function public._find_slot(uuid, uuid, uuid, date, time, int, boolean, uuid), public._create_slot(uuid, uuid, uuid, date, time, text, int) to service_role;
