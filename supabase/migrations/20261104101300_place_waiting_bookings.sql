-- Xếp hàng loạt các booking đã ghép mã nhưng chưa có chuyến, thay vì mở từng booking.
-- Chỉ chạy khi người dùng bấm: đường nhận dữ liệu từ kênh vẫn không tự tạo chuyến.
-- Từng booking đi qua move_booking_item nên vẫn có kiểm tra chỗ, lịch sử, nhật ký và gỡ cờ chờ.
create function public.place_waiting_bookings(
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
      t.name as tour_name, o.name as option_name, o.is_private,
      count(distinct i.booking_id)::int as bookings, sum(i.seats)::int as seats
    from public.booking_items i
    join public.bookings b on b.id = i.booking_id
    join public.tours t on t.id = i.tour_id
    join public.tour_options o on o.id = i.tour_option_id
    where i.organization_id = p_org and i.departure_id is null and b.status <> 'cancelled'
      and i.local_date is not null and i.local_time is not null
      and i.local_date >= (now() at time zone coalesce(i.timezone, 'UTC'))::date
    group by i.tour_id, i.tour_option_id, i.local_date, i.local_time, t.name, o.name, o.is_private
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
      if v_dep is null and p_create_capacity is not null then
        v_res := public.create_departure(p_org, g.tour_id, g.tour_option_id, g.local_date, g.local_time, g.tz, p_create_capacity, null);
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
      'tour_name', g.tour_name, 'option_name', g.option_name, 'is_private', g.is_private,
      'local_date', g.local_date, 'local_time', g.local_time,
      'bookings', g.bookings, 'seats', g.seats,
      'departure_id', v_dep, 'available_seats', v_available,
      'placed', v_row_placed, 'skipped_private', v_row_private);
  end loop;

  return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'rows', v_rows,
    'placed', v_placed, 'created', v_created, 'no_seats', v_no_seats, 'skipped_private', v_private,
    'unmapped', v_unmapped, 'past', v_past);
end $$;

revoke all on function public.place_waiting_bookings(uuid, boolean, int) from public, anon, authenticated;
grant execute on function public.place_waiting_bookings(uuid, boolean, int) to authenticated, service_role;
