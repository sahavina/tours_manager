-- Sức chứa mặc định theo gói: xe jeep, xe máy hay xe khách chở số khách khác nhau, nên không dùng một con số chung.
-- Dùng khi tạo chuyến mới cho gói, và có thể áp lại cho các chuyến sắp chạy của gói.
alter table public.tour_options
  add column default_capacity int check (default_capacity is null or default_capacity > 0);

create or replace function public.place_waiting_bookings(
  p_org uuid, p_dry_run boolean default true, p_create_capacity int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g record;
  it record;
  v_dep uuid;
  v_available int;
  v_used int;
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
    -- Cùng quy tắc với _resolve_item: ưu tiên chuyến của gói, rồi tới chuyến "Mọi gói".
    select d.id into v_dep from public.departures d
    where d.organization_id = p_org and d.tour_id = g.tour_id and d.status = 'scheduled'
      and d.local_date = g.local_date and d.local_time = g.local_time
      and (d.tour_option_id = g.tour_option_id or d.tour_option_id is null)
    order by (d.tour_option_id is null), d.id
    limit 1;

    v_available := null;
    if v_dep is not null then
      select public._pool_available(d.inventory_pool_id) into v_available from public.departures d where d.id = v_dep;
    end if;
    v_row_placed := 0;
    v_row_private := 0;

    if not p_dry_run then
      -- Sức chứa cấu hình ở gói được ưu tiên; số người dùng nhập chỉ dùng cho gói chưa cấu hình.
      if v_dep is null and coalesce(g.default_capacity, p_create_capacity) is not null then
        v_res := public.create_departure(p_org, g.tour_id, g.tour_option_id, g.local_date, g.local_time, g.tz, coalesce(g.default_capacity, p_create_capacity), null);
        if (v_res ->> 'ok')::boolean then
          v_dep := (v_res ->> 'departure_id')::uuid;
          v_created := v_created + 1;
        end if;
      end if;

      if v_dep is not null then
        for it in
          select i.id from public.booking_items i
          join public.bookings b on b.id = i.booking_id
          where i.organization_id = p_org and i.departure_id is null and b.status <> 'cancelled'
            and i.tour_option_id = g.tour_option_id and i.local_date = g.local_date and i.local_time = g.local_time
          order by b.booked_at nulls last, i.id
        loop
          -- Không tự gộp khách vào tour riêng: chuyến đã có khách thì để người điều hành quyết định.
          if g.is_private then
            select count(*) into v_used from public.booking_items x where x.departure_id = v_dep and x.committed_seats > 0;
            if v_used > 0 then
              v_private := v_private + 1;
              v_row_private := v_row_private + 1;
              continue;
            end if;
          end if;
          v_res := public.move_booking_item(it.id, v_dep);
          if (v_res ->> 'ok')::boolean then
            v_placed := v_placed + 1;
            v_row_placed := v_row_placed + 1;
          else
            v_no_seats := v_no_seats + 1;
          end if;
        end loop;
      end if;
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

-- Áp sức chứa của gói cho các chuyến sắp chạy. Chuyến đã có nhiều khách hơn sức chứa mới, hoặc dùng chung nguồn chỗ
-- với chuyến khác, thì giữ nguyên và được trả về để người dùng xử lý, không bao giờ làm khách mất chỗ.
create function public.apply_option_capacity(p_option uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_o public.tour_options%rowtype;
  d record;
  v_res jsonb;
  v_updated int := 0;
  v_same int := 0;
  v_skipped jsonb := '[]';
begin
  select * into v_o from public.tour_options where id = p_option;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'option_not_found');
  end if;
  perform public._require(v_o.organization_id, 'departure.manage');
  if v_o.default_capacity is null then
    return jsonb_build_object('ok', false, 'code', 'no_default_capacity');
  end if;

  for d in
    select x.id, x.local_date, x.local_time, x.inventory_pool_id, p.capacity, p.blocked_seats,
      (select count(*) from public.departures y where y.inventory_pool_id = x.inventory_pool_id) as pool_users
    from public.departures x join public.inventory_pools p on p.id = x.inventory_pool_id
    where x.tour_option_id = p_option and x.status = 'scheduled' and x.starts_at > now()
    order by x.starts_at
  loop
    if d.capacity = v_o.default_capacity then
      v_same := v_same + 1;
      continue;
    end if;
    if d.pool_users > 1 then
      v_skipped := v_skipped || jsonb_build_object('departure_id', d.id, 'local_date', d.local_date, 'local_time', d.local_time, 'code', 'shared_pool');
      continue;
    end if;
    v_res := public.update_pool_capacity(d.inventory_pool_id, v_o.default_capacity, d.blocked_seats);
    if (v_res ->> 'ok')::boolean then
      v_updated := v_updated + 1;
    else
      v_skipped := v_skipped || jsonb_build_object('departure_id', d.id, 'local_date', d.local_date, 'local_time', d.local_time,
        'code', v_res ->> 'code', 'committed', v_res -> 'committed');
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'capacity', v_o.default_capacity, 'updated', v_updated, 'unchanged', v_same, 'skipped', v_skipped);
end $$;

revoke all on function public.apply_option_capacity(uuid) from public, anon, authenticated;
grant execute on function public.apply_option_capacity(uuid) to authenticated, service_role;
