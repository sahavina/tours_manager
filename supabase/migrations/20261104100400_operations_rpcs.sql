-- RPC cho giao diện: chuyến, booking thủ công, điều hành, hướng dẫn viên.

create function public._departure_org(p_departure uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select organization_id from public.departures where id = p_departure;
$$;

-- Tự xác thực quyền qua `where`: view chạy bằng quyền owner để số chỗ không bị RLS làm thiếu
-- (RLS chặn thì ra số nhỏ hơn, tức báo còn nhiều chỗ hơn thực tế, không có lỗi nào hiện ra).
create view public.v_departure_availability with (security_barrier = true) as
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
  (select count(*)::int from public.vehicle_assignments v where v.departure_id = d.id) as vehicle_count
from public.departures d
join public.tours t on t.id = d.tour_id
left join public.tour_options o on o.id = d.tour_option_id
join public.inventory_pools p on p.id = d.inventory_pool_id
-- Viết thẳng phép tính thay vì gọi _pool_committed: hàm trong view được kiểm EXECUTE theo người gọi,
-- và hàm nội bộ không được cấp cho authenticated.
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
where public.has_org_permission(d.organization_id, 'departure.read');

create view public.v_booking_list with (security_invoker = true) as
select
  b.id, b.organization_id, b.code, b.external_ref, b.source, b.status, b.channel_status, b.ops_status,
  b.payment_status, b.reconciliation_status, b.sync_status, b.gross_amount, b.currency, b.booked_at,
  b.owner_id, b.needs_action, b.action_reason, b.changed_after_assignment, b.lead_name, b.lead_email,
  b.lead_phone, b.customer_id, b.connection_id, b.updated_at,
  c.channel, c.account_name, c.mode as connection_mode,
  i.tour_id, i.tour_option_id, i.departure_id, i.local_date, i.local_time, i.timezone,
  i.external_product_code, i.total_pax as pax_total, i.item_count,
  t.name as tour_name, o.name as option_name,
  pk.hotel_name as pickup_hotel, pk.address as pickup_address,
  own.full_name as owner_name,
  lower(concat_ws(' ', b.code, b.external_ref, b.lead_name, b.lead_email, b.lead_phone, t.name)) as search_text
from public.bookings b
left join public.channel_connections c on c.id = b.connection_id
left join lateral (
  select
    (array_agg(x.id order by x.local_date nulls last, x.item_ref))[1] as first_item_id,
    (array_agg(x.tour_id order by x.local_date nulls last, x.item_ref))[1] as tour_id,
    (array_agg(x.tour_option_id order by x.local_date nulls last, x.item_ref))[1] as tour_option_id,
    (array_agg(x.departure_id order by x.local_date nulls last, x.item_ref))[1] as departure_id,
    min(x.local_date) as local_date,
    (array_agg(x.local_time order by x.local_date nulls last, x.item_ref))[1] as local_time,
    (array_agg(x.timezone order by x.local_date nulls last, x.item_ref))[1] as timezone,
    (array_agg(x.external_product_code order by x.local_date nulls last, x.item_ref))[1] as external_product_code,
    sum(x.pax_total)::int as total_pax,
    count(*)::int as item_count
  from public.booking_items x where x.booking_id = b.id
) i on true
left join public.tours t on t.id = i.tour_id
left join public.tour_options o on o.id = i.tour_option_id
left join public.booking_pickups pk on pk.booking_item_id = i.first_item_id
left join public.profiles own on own.id = b.owner_id;

-- ---------------------------- Chuyến ----------------------------

create function public.create_departure(
  p_org uuid, p_tour uuid, p_option uuid, p_date date, p_time time, p_timezone text,
  p_capacity int, p_pool uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pool uuid := p_pool;
  v_id uuid;
begin
  perform public._require(p_org, 'departure.manage');
  if v_pool is null then
    if p_capacity is null or p_capacity < 0 then
      return jsonb_build_object('ok', false, 'code', 'invalid_capacity');
    end if;
    insert into public.inventory_pools (organization_id, name, capacity)
    values (p_org, format('%s %s', p_date, p_time), p_capacity) returning id into v_pool;
  end if;
  insert into public.departures (organization_id, tour_id, tour_option_id, inventory_pool_id, local_date, local_time, timezone, starts_at)
  values (p_org, p_tour, p_option, v_pool, p_date, p_time, p_timezone, now())
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    if p_pool is null then
      delete from public.inventory_pools where id = v_pool;
    end if;
    return jsonb_build_object('ok', false, 'code', 'duplicate_departure');
  end if;
  perform public._audit(p_org, 'create', 'departures', v_id::text);
  return jsonb_build_object('ok', true, 'departure_id', v_id);
end $$;

-- Tạo chuyến lặp. dry_run trả xem trước; chạy thật bỏ qua các ô đã có nên chạy lại an toàn.
create function public.generate_departures(
  p_org uuid, p_tour uuid, p_option uuid, p_from date, p_to date, p_weekdays int[], p_times time[],
  p_timezone text, p_capacity int, p_dry_run boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_date date;
  v_time time;
  v_rows jsonb := '[]';
  v_exists boolean;
  v_created int := 0;
  v_skipped int := 0;
  v_res jsonb;
begin
  perform public._require(p_org, 'departure.manage');
  if p_to < p_from or p_to - p_from > 366 then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  for v_date in select generate_series(p_from, p_to, interval '1 day')::date loop
    -- p_weekdays theo ISO: 1 = thứ Hai ... 7 = Chủ nhật.
    continue when not (extract(isodow from v_date)::int = any (p_weekdays));
    foreach v_time in array p_times loop
      select exists (
        select 1 from public.departures d
        where d.organization_id = p_org and d.tour_id = p_tour
          and d.tour_option_id is not distinct from p_option
          and d.local_date = v_date and d.local_time = v_time
      ) into v_exists;
      if v_exists then
        v_skipped := v_skipped + 1;
      elsif not p_dry_run then
        v_res := public.create_departure(p_org, p_tour, p_option, v_date, v_time, p_timezone, p_capacity);
        if (v_res ->> 'ok')::boolean then v_created := v_created + 1; else v_skipped := v_skipped + 1; end if;
      else
        v_created := v_created + 1;
      end if;
      v_rows := v_rows || jsonb_build_object('date', v_date, 'time', v_time, 'exists', v_exists);
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'created', v_created, 'skipped', v_skipped, 'rows', v_rows);
end $$;

create function public.set_departure_sale(p_departure uuid, p_open boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  perform public._require(v_org, 'departure.manage');
  update public.departures set sale_open = p_open where id = p_departure;
  perform public._audit(v_org, 'set_sale', 'departures', p_departure::text, null, jsonb_build_object('sale_open', p_open));
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_org, 'availability.changed', p_departure::text, '{}');
  return jsonb_build_object('ok', true);
end $$;

-- Không giảm dưới lượng đã cam kết (chỗ đặt + chỗ giữ).
create function public.update_pool_capacity(p_pool uuid, p_capacity int, p_blocked int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.inventory_pools%rowtype;
  v_committed int;
  v_held int;
begin
  select * into v_p from public.inventory_pools where id = p_pool;
  perform public._require(v_p.organization_id, 'departure.manage');
  perform public._lock_pools(array[p_pool]);
  v_committed := public._pool_committed(p_pool);
  v_held := public._pool_held(p_pool);
  if p_capacity < 0 or p_blocked < 0 or p_capacity - p_blocked < v_committed + v_held then
    return jsonb_build_object('ok', false, 'code', 'below_committed',
      'committed', v_committed, 'held', v_held);
  end if;
  update public.inventory_pools set capacity = p_capacity, blocked_seats = p_blocked where id = p_pool;
  perform public._audit(v_p.organization_id, 'update_capacity', 'inventory_pools', p_pool::text,
    to_jsonb(v_p), jsonb_build_object('capacity', p_capacity, 'blocked_seats', p_blocked));
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_p.organization_id, 'availability.changed', p_pool::text, '{}');
  return jsonb_build_object('ok', true);
end $$;

create function public.complete_departure(p_departure uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  perform public._require(v_org, 'ops.manage');
  update public.departures set status = 'completed', outcome = p_outcome where id = p_departure;
  perform public._recompute_departure_bookings(p_departure);
  perform public._audit(v_org, 'complete', 'departures', p_departure::text, null, jsonb_build_object('outcome', p_outcome));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------- Booking ----------------------------

-- p_data: {tour_option_id, departure_id, lead:{name,email,phone}, pax:{adult:2}, gross_amount, currency,
--          special_requests, pickup:{hotel,address}, external_ref?}
create function public.create_manual_booking(p_org uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_booking uuid;
  v_item uuid;
  v_code text;
  v_customer uuid;
  v_dep public.departures%rowtype;
  v_seats int;
  v_place text;
begin
  perform public._require(p_org, 'booking.manage');

  if coalesce(p_data #>> '{lead,name}', '') = '' then
    return jsonb_build_object('ok', false, 'code', 'missing_lead');
  end if;
  select * into v_dep from public.departures
  where id = (p_data ->> 'departure_id')::uuid and organization_id = p_org;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'departure_not_found');
  end if;
  v_seats := public._pax_seats(p_org, p_data -> 'pax');
  if public._pax_total(p_data -> 'pax') <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_pax');
  end if;

  begin
    insert into public.customers (organization_id, full_name, email, phone, source)
    values (p_org, p_data #>> '{lead,name}', p_data #>> '{lead,email}', p_data #>> '{lead,phone}', 'manual')
    returning id into v_customer;

    v_code := public._next_booking_code(p_org);
    insert into public.bookings
      (organization_id, code, source, customer_id, lead_name, lead_email, lead_phone, special_requests,
       status, gross_amount, currency, owner_id, sync_status)
    values (p_org, v_code, 'manual', v_customer, p_data #>> '{lead,name}', p_data #>> '{lead,email}',
      p_data #>> '{lead,phone}', p_data ->> 'special_requests', 'confirmed',
      (p_data ->> 'gross_amount')::numeric, p_data ->> 'currency', (select auth.uid()), 'manual')
    returning id into v_booking;

    insert into public.booking_items
      (organization_id, booking_id, tour_option_id, tour_id, local_date, local_time, timezone, pax, pax_total, seats, amount, currency)
    values (p_org, v_booking, coalesce((p_data ->> 'tour_option_id')::uuid, v_dep.tour_option_id), v_dep.tour_id,
      v_dep.local_date, v_dep.local_time, v_dep.timezone, p_data -> 'pax', public._pax_total(p_data -> 'pax'), v_seats,
      (p_data ->> 'gross_amount')::numeric, p_data ->> 'currency')
    returning id into v_item;

    v_place := public._place_item(v_item, v_dep.id, v_seats);
    if v_place <> 'ok' then
      -- Rollback toàn bộ khối để không để lại booking mồ côi hay nhảy mã.
      raise exception '%', v_place using errcode = 'TH003';
    end if;

    if p_data ? 'pickup' then
      insert into public.booking_pickups (booking_item_id, organization_id, hotel_name, address)
      values (v_item, p_org, p_data #>> '{pickup,hotel}', p_data #>> '{pickup,address}');
    end if;

    insert into public.booking_financials (booking_id, organization_id, currency, source)
    values (v_booking, p_org, p_data ->> 'currency', 'manual');

    insert into public.booking_changes (organization_id, booking_id, change_type, summary, source, actor_id)
    values (p_org, v_booking, 'created', 'Tạo booking thủ công', 'manual', (select auth.uid()));

    perform public._recompute_booking_ops(v_booking);
    perform public._audit(p_org, 'create', 'bookings', v_booking::text);
    insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
    values (p_org, 'booking.created', v_booking::text, jsonb_build_object('code', v_code)),
           (p_org, 'availability.changed', v_booking::text, '{}');
  exception when sqlstate 'TH003' then
    return jsonb_build_object('ok', false, 'code', sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'booking_id', v_booking, 'code', v_code);
end $$;

-- Sửa thông tin nội bộ: không cột nào được coi là đã cập nhật sang kênh.
create function public.update_booking_internal(p_booking uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
begin
  select * into v_b from public.bookings where id = p_booking;
  perform public._require(v_b.organization_id, 'booking.manage');
  update public.bookings set
    owner_id = case when p_patch ? 'owner_id' then (p_patch ->> 'owner_id')::uuid else owner_id end,
    needs_action = case when p_patch ? 'needs_action' then (p_patch ->> 'needs_action')::boolean else needs_action end,
    action_reason = case when p_patch ? 'action_reason' then p_patch ->> 'action_reason' else action_reason end,
    changed_after_assignment = case when p_patch ? 'changed_after_assignment'
      then (p_patch ->> 'changed_after_assignment')::boolean else changed_after_assignment end,
    payment_status = case when p_patch ? 'payment_status'
      then (p_patch ->> 'payment_status')::public.payment_status else payment_status end
  where id = p_booking;
  perform public._audit(v_b.organization_id, 'update_internal', 'bookings', p_booking::text, null, p_patch);
  return jsonb_build_object('ok', true);
end $$;

create function public.add_booking_note(p_booking uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.bookings where id = p_booking;
  perform public._require(v_org, 'booking.manage');
  insert into public.booking_notes (organization_id, booking_id, author_id, body)
  values (v_org, p_booking, (select auth.uid()), p_body);
  return jsonb_build_object('ok', true);
end $$;

-- Đổi chuyến: kiểm tra chỗ đích và trả chỗ nguồn trong cùng giao dịch (`_place_item`).
create function public.move_booking_item(p_item uuid, p_departure uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_i public.booking_items%rowtype;
  v_b public.bookings%rowtype;
  v_to public.departures%rowtype;
  v_place text;
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
  v_channel_status := case when v_b.connection_id is null then 'not_applicable'::public.channel_request_status
    else 'manual_required'::public.channel_request_status end;

  insert into public.booking_changes
    (organization_id, booking_id, change_type, summary, before_data, after_data, source, actor_id, channel_request_status)
  values (v_i.organization_id, v_b.id, 'moved',
    format('Chuyển chuyến: %s %s → %s %s', v_i.local_date, v_i.local_time, v_to.local_date, v_to.local_time),
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure),
    'internal', (select auth.uid()), v_channel_status);

  perform public._recompute_booking_ops(v_b.id);
  perform public._audit(v_i.organization_id, 'move', 'booking_items', p_item::text,
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure));
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_i.organization_id, 'availability.changed', p_item::text, '{}');

  return jsonb_build_object('ok', true, 'channel_request_status', v_channel_status);
end $$;

create function public.update_item_pax(p_item uuid, p_pax jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_i public.booking_items%rowtype;
  v_b public.bookings%rowtype;
  v_seats int;
  v_place text;
begin
  select * into v_i from public.booking_items where id = p_item;
  perform public._require(v_i.organization_id, 'booking.manage');
  select * into v_b from public.bookings where id = v_i.booking_id for update;
  if v_b.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'booking_cancelled');
  end if;
  v_seats := public._pax_seats(v_i.organization_id, p_pax);
  if public._pax_total(p_pax) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_pax');
  end if;
  if v_i.departure_id is not null then
    v_place := public._place_item(p_item, v_i.departure_id, v_seats);
    if v_place <> 'ok' then
      return jsonb_build_object('ok', false, 'code', v_place);
    end if;
  end if;
  update public.booking_items set pax = p_pax, pax_total = public._pax_total(p_pax), seats = v_seats where id = p_item;
  perform public._flag_if_assigned(v_b.id, v_i.departure_id, 'Đổi số khách sau khi đã phân công');
  insert into public.booking_changes
    (organization_id, booking_id, change_type, summary, source, actor_id, channel_request_status)
  values (v_i.organization_id, v_b.id, 'pax', format('Đổi số khách: %s → %s', v_i.pax, p_pax), 'internal', (select auth.uid()),
    case when v_b.connection_id is null then 'not_applicable'::public.channel_request_status else 'manual_required' end);
  return jsonb_build_object('ok', true);
end $$;

-- Hủy phía nội bộ. Booking từ kênh: hủy trên hệ thống này KHÔNG hủy trên kênh, phải ghi manual_required.
create function public.cancel_booking_internal(p_booking uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  v_did boolean;
begin
  select * into v_b from public.bookings where id = p_booking;
  perform public._require(v_b.organization_id, 'booking.manage');
  v_did := public._cancel_booking(p_booking, 'internal');
  if v_did and v_b.connection_id is not null then
    insert into public.booking_changes
      (organization_id, booking_id, change_type, summary, source, actor_id, channel_request_status)
    values (v_b.organization_id, p_booking, 'cancel_request',
      'Đã hủy nội bộ, cần hủy tay trên kênh. Lý do: ' || coalesce(p_reason, '(không ghi)'),
      'internal', (select auth.uid()), 'manual_required');
  end if;
  perform public._audit(v_b.organization_id, 'cancel', 'bookings', p_booking::text, null, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true, 'changed', v_did,
    'channel_action_required', v_b.connection_id is not null);
end $$;

-- Người dùng ghi nhận đã xử lý trên kênh; chỉ phản ánh điều họ khai, không phải kênh trả lời.
create function public.set_channel_request_status(p_change uuid, p_status public.channel_request_status) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.booking_changes%rowtype;
begin
  select * into v_c from public.booking_changes where id = p_change;
  perform public._require(v_c.organization_id, 'booking.manage');
  update public.booking_changes set channel_request_status = p_status where id = p_change;
  perform public._audit(v_c.organization_id, 'channel_request_status', 'booking_changes', p_change::text,
    jsonb_build_object('status', v_c.channel_request_status), jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------- Điều hành ----------------------------

create function public.assign_guide(p_departure uuid, p_guide uuid, p_role text default 'lead') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  perform public._require(v_org, 'ops.manage');
  insert into public.guide_assignments (organization_id, departure_id, guide_id, role)
  values (v_org, p_departure, p_guide, coalesce(p_role, 'lead'))
  on conflict (departure_id, guide_id) do update set role = excluded.role;
  perform public._recompute_departure_bookings(p_departure);
  perform public._audit(v_org, 'assign_guide', 'departures', p_departure::text, null, jsonb_build_object('guide_id', p_guide));
  return jsonb_build_object('ok', true);
end $$;

create function public.unassign_guide(p_assignment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.guide_assignments%rowtype;
begin
  select * into v_a from public.guide_assignments where id = p_assignment;
  perform public._require(v_a.organization_id, 'ops.manage');
  delete from public.guide_assignments where id = p_assignment;
  perform public._recompute_departure_bookings(v_a.departure_id);
  perform public._audit(v_a.organization_id, 'unassign_guide', 'departures', v_a.departure_id::text, to_jsonb(v_a));
  return jsonb_build_object('ok', true);
end $$;

create function public.assign_vehicle(
  p_departure uuid, p_vehicle uuid, p_driver_name text default null, p_driver_phone text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
  v_v public.vehicles%rowtype;
begin
  perform public._require(v_org, 'ops.manage');
  select * into v_v from public.vehicles where id = p_vehicle and organization_id = v_org;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'vehicle_not_found');
  end if;
  insert into public.vehicle_assignments (organization_id, departure_id, vehicle_id, driver_name, driver_phone)
  values (v_org, p_departure, p_vehicle, coalesce(p_driver_name, v_v.driver_name), coalesce(p_driver_phone, v_v.driver_phone))
  on conflict (departure_id, vehicle_id) do update
    set driver_name = excluded.driver_name, driver_phone = excluded.driver_phone;
  perform public._recompute_departure_bookings(p_departure);
  perform public._audit(v_org, 'assign_vehicle', 'departures', p_departure::text, null, jsonb_build_object('vehicle_id', p_vehicle));
  return jsonb_build_object('ok', true);
end $$;

create function public.unassign_vehicle(p_assignment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.vehicle_assignments%rowtype;
begin
  select * into v_a from public.vehicle_assignments where id = p_assignment;
  perform public._require(v_a.organization_id, 'ops.manage');
  if exists (select 1 from public.passenger_allocations where vehicle_assignment_id = p_assignment and is_active) then
    return jsonb_build_object('ok', false, 'code', 'has_allocations');
  end if;
  delete from public.vehicle_assignments where id = p_assignment;
  perform public._recompute_departure_bookings(v_a.departure_id);
  perform public._audit(v_a.organization_id, 'unassign_vehicle', 'departures', v_a.departure_id::text, to_jsonb(v_a));
  return jsonb_build_object('ok', true);
end $$;

-- Chia khách theo xe, kiểm tra cùng chuyến và sức chứa xe.
create function public.allocate_passengers(p_assignment uuid, p_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.vehicle_assignments%rowtype;
  v_i public.booking_items%rowtype;
  v_capacity int;
  v_used int;
begin
  select * into v_a from public.vehicle_assignments where id = p_assignment for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'assignment_not_found');
  end if;
  perform public._require(v_a.organization_id, 'ops.manage');
  select * into v_i from public.booking_items where id = p_item and organization_id = v_a.organization_id;
  if not found or v_i.departure_id is distinct from v_a.departure_id then
    return jsonb_build_object('ok', false, 'code', 'different_departure');
  end if;
  if v_i.committed_seats = 0 then
    return jsonb_build_object('ok', false, 'code', 'no_committed_seats');
  end if;
  select seats into v_capacity from public.vehicles where id = v_a.vehicle_id;
  select coalesce(sum(seats), 0)::int into v_used from public.passenger_allocations
  where vehicle_assignment_id = p_assignment and is_active and booking_item_id <> p_item;
  if v_used + v_i.committed_seats > v_capacity then
    return jsonb_build_object('ok', false, 'code', 'vehicle_full', 'capacity', v_capacity, 'used', v_used);
  end if;
  update public.passenger_allocations set is_active = false where booking_item_id = p_item and is_active;
  insert into public.passenger_allocations (organization_id, departure_id, vehicle_assignment_id, booking_item_id, seats)
  values (v_a.organization_id, v_a.departure_id, p_assignment, p_item, v_i.committed_seats);
  return jsonb_build_object('ok', true, 'used', v_used + v_i.committed_seats, 'capacity', v_capacity);
end $$;

create function public.deallocate_passengers(p_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.booking_items where id = p_item;
  perform public._require(v_org, 'ops.manage');
  update public.passenger_allocations set is_active = false where booking_item_id = p_item and is_active;
  return jsonb_build_object('ok', true);
end $$;

create function public.set_pickup(p_item uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_i public.booking_items%rowtype;
begin
  select * into v_i from public.booking_items where id = p_item;
  perform public._require(v_i.organization_id, 'ops.manage');
  insert into public.booking_pickups (booking_item_id, organization_id) values (p_item, v_i.organization_id)
  on conflict (booking_item_id) do nothing;
  update public.booking_pickups set
    hotel_name = case when p_patch ? 'hotel_name' then p_patch ->> 'hotel_name' else hotel_name end,
    address = case when p_patch ? 'address' then p_patch ->> 'address' else address end,
    pickup_local_time = case when p_patch ? 'pickup_local_time' then (p_patch ->> 'pickup_local_time')::time else pickup_local_time end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::int else sort_order end,
    ops_note = case when p_patch ? 'ops_note' then p_patch ->> 'ops_note' else ops_note end,
    updated_at = now()
  where booking_item_id = p_item;
  perform public._recompute_booking_ops(v_i.booking_id);
  perform public._audit(v_i.organization_id, 'set_pickup', 'booking_items', p_item::text, null, p_patch);
  return jsonb_build_object('ok', true);
end $$;

create function public.reorder_pickups(p_departure uuid, p_items uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
  v_item uuid;
  v_i int := 0;
begin
  perform public._require(v_org, 'ops.manage');
  foreach v_item in array p_items loop
    v_i := v_i + 1;
    continue when not exists (select 1 from public.booking_items where id = v_item and departure_id = p_departure);
    insert into public.booking_pickups (booking_item_id, organization_id, sort_order)
    values (v_item, v_org, v_i)
    on conflict (booking_item_id) do update set sort_order = excluded.sort_order, updated_at = now();
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- Ghi nhận đã thông báo / đã xác nhận cho phân công hoặc nhà cung cấp.
create function public.set_assignment_ack(p_kind text, p_id uuid, p_field text, p_value boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_at timestamptz := case when p_value then now() end;
begin
  if p_field not in ('notified', 'confirmed') or p_kind not in ('guide', 'vehicle') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_kind = 'guide' then
    select organization_id into v_org from public.guide_assignments where id = p_id;
    perform public._require(v_org, 'ops.manage');
    update public.guide_assignments set
      notified_at = case when p_field = 'notified' then v_at else notified_at end,
      confirmed_at = case when p_field = 'confirmed' then v_at else confirmed_at end
    where id = p_id;
  else
    select organization_id into v_org from public.vehicle_assignments where id = p_id;
    perform public._require(v_org, 'ops.manage');
    update public.vehicle_assignments set
      notified_at = case when p_field = 'notified' then v_at else notified_at end,
      confirmed_at = case when p_field = 'confirmed' then v_at else confirmed_at end
    where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.set_supplier_confirmed(p_departure uuid, p_value boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  perform public._require(v_org, 'ops.manage');
  update public.departures set supplier_confirmed_at = case when p_value then now() end where id = p_departure;
  return jsonb_build_object('ok', true);
end $$;

-- Bảng công việc theo chuyến.
create function public.ops_board(p_org uuid, p_from date, p_to date) returns jsonb
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
        d.supplier_confirmed_at is null and coalesce(v.n, 0) > 0 as supplier_unconfirmed
      from public.departures d
      join public.tours t on t.id = d.tour_id
      left join public.tour_options o on o.id = d.tour_option_id
      left join lateral (
        select sum(i.committed_seats)::int as seats, count(distinct i.booking_id)::int as bookings,
          count(*) filter (where op.has_transfer and coalesce(pk.hotel_name, pk.address, '') = '')::int as missing_pickup,
          count(distinct b.id) filter (where b.changed_after_assignment)::int as changed,
          count(distinct b.id) filter (where b.needs_action)::int as needs_action,
          count(*) filter (where not exists (select 1 from public.passenger_allocations a where a.booking_item_id = i.id and a.is_active))::int as unallocated
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
      where d.organization_id = p_org and d.local_date between p_from and p_to
    ) x
  );
end $$;

-- Danh sách phục vụ của một chuyến cho điều hành. Tiền không có mặt ở đây.
create function public.departure_manifest(p_departure uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  if not (public.has_org_permission(v_org, 'ops.read') or public.has_org_permission(v_org, 'departure.read')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._manifest_rows(p_departure);
end $$;

create function public._manifest_rows(p_departure uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.sort_order nulls last, x.pickup_local_time nulls last, x.code), '[]'::jsonb)
  from (
    select
      i.id as item_id, b.id as booking_id, b.code, b.lead_name, b.lead_phone, b.special_requests,
      i.pax, i.pax_total, i.seats, i.committed_seats, i.language, b.status,
      -- Khách đã rời chuyến vẫn hiện nếu từng được điểm danh, để không mất dấu vết.
      case when b.status = 'cancelled' then 'cancelled'
           when i.departure_id is distinct from p_departure then 'moved'
           else 'active' end as presence,
      pk.hotel_name, pk.address, pk.latitude, pk.longitude, pk.pickup_local_time, pk.sort_order, pk.ops_note,
      a.status as attendance, a.note as attendance_note, a.recorded_at,
      alloc.vehicle_assignment_id, ve.name as vehicle_name
    from public.booking_items i
    join public.bookings b on b.id = i.booking_id
    left join public.booking_pickups pk on pk.booking_item_id = i.id
    left join public.attendance_records a on a.booking_item_id = i.id and a.departure_id = p_departure
    left join public.passenger_allocations alloc on alloc.booking_item_id = i.id and alloc.is_active and alloc.departure_id = p_departure
    left join public.vehicle_assignments va on va.id = alloc.vehicle_assignment_id
    left join public.vehicles ve on ve.id = va.vehicle_id
    where i.departure_id = p_departure or a.id is not null
  ) x;
$$;

-- ---------------------------- Hướng dẫn viên ----------------------------

create function public._is_assigned_guide(p_departure uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.guide_assignments ga
    join public.guides g on g.id = ga.guide_id
    where ga.departure_id = p_departure and g.profile_id = (select auth.uid()) and g.deleted_at is null
  );
$$;

create function public.guide_my_departures(p_from date default null, p_to date default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.starts_at), '[]'::jsonb) from (
    select d.id, d.organization_id, d.local_date, d.local_time, d.timezone, d.starts_at, d.status,
      t.name as tour_name, t.joining_instructions, t.itinerary, o.name as option_name, ga.role,
      (select coalesce(sum(i.pax_total), 0)::int from public.booking_items i where i.departure_id = d.id and i.committed_seats > 0) as pax
    from public.guide_assignments ga
    join public.guides g on g.id = ga.guide_id
    join public.departures d on d.id = ga.departure_id
    join public.tours t on t.id = d.tour_id
    left join public.tour_options o on o.id = d.tour_option_id
    where g.profile_id = (select auth.uid())
      and d.local_date >= coalesce(p_from, (now() at time zone d.timezone)::date - 1)
      and (p_to is null or d.local_date <= p_to)
  ) x;
$$;

-- Trả mảng rỗng (không lỗi) nếu không được giao chuyến, để không tiết lộ chuyến tồn tại hay không.
create function public.guide_manifest(p_departure uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._is_assigned_guide(p_departure) then
    return '[]'::jsonb;
  end if;
  return public._manifest_rows(p_departure);
end $$;

-- Hướng dẫn viên được giao hoặc người có ops.manage. Đổi nhiều lần vẫn một dòng, lịch sử ở audit_logs.
create function public.set_attendance(p_departure uuid, p_item uuid, p_status public.attendance_status, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
  v_i public.booking_items%rowtype;
  v_prev public.attendance_records%rowtype;
begin
  if not (public._is_assigned_guide(p_departure) or public.has_org_permission(v_org, 'ops.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_i from public.booking_items where id = p_item and organization_id = v_org;
  select * into v_prev from public.attendance_records where departure_id = p_departure and booking_item_id = p_item;
  -- Khách đã chuyển đi chỉ sửa được nếu từng có bản ghi ở chuyến này.
  if v_i.id is null or (v_i.departure_id is distinct from p_departure and v_prev.id is null) then
    return jsonb_build_object('ok', false, 'code', 'not_on_departure');
  end if;
  insert into public.attendance_records (organization_id, departure_id, booking_item_id, status, note, recorded_by)
  values (v_org, p_departure, p_item, p_status, p_note, (select auth.uid()))
  on conflict (departure_id, booking_item_id) do update
    set status = excluded.status, note = coalesce(excluded.note, public.attendance_records.note),
        recorded_by = excluded.recorded_by, recorded_at = now();
  perform public._audit(v_org, 'attendance', 'booking_items', p_item::text,
    case when v_prev.id is null then null else jsonb_build_object('status', v_prev.status) end,
    jsonb_build_object('status', p_status, 'departure_id', p_departure));
  return jsonb_build_object('ok', true);
end $$;

create function public.report_incident(p_departure uuid, p_severity text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  if not (public._is_assigned_guide(p_departure) or public.has_org_permission(v_org, 'ops.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.departure_incidents (organization_id, departure_id, severity, body, reported_by)
  values (v_org, p_departure, coalesce(p_severity, 'normal'), p_body, (select auth.uid()));
  insert into public.notifications (organization_id, required_permission, kind, title, body, link)
  values (v_org, 'ops.read', 'incident', 'Sự cố trên chuyến', left(p_body, 200), '/operations?departure=' || p_departure);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------- Khách hàng ----------------------------

-- Chỉ gợi ý trên dữ liệu đủ tin cậy (email hoặc số điện thoại trùng khớp). Không bao giờ theo tên.
create function public.customer_duplicate_suggestions(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'customer.read');
  return (
    select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select 'email' as matched_on, lower(c.email) as value,
        jsonb_agg(jsonb_build_object('id', c.id, 'full_name', c.full_name, 'source', c.source) order by c.created_at) as customers
      from public.customers c
      where c.organization_id = p_org and c.merged_into_id is null and coalesce(c.email, '') <> ''
      group by lower(c.email) having count(*) > 1
      union all
      select 'phone', regexp_replace(c.phone, '\D', '', 'g'),
        jsonb_agg(jsonb_build_object('id', c.id, 'full_name', c.full_name, 'source', c.source) order by c.created_at)
      from public.customers c
      where c.organization_id = p_org and c.merged_into_id is null and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 8
      group by regexp_replace(c.phone, '\D', '', 'g') having count(*) > 1
    ) x
  );
end $$;

create function public.merge_customers(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_keep public.customers%rowtype;
  v_drop public.customers%rowtype;
begin
  select * into v_keep from public.customers where id = p_keep;
  select * into v_drop from public.customers where id = p_drop;
  if v_keep.id is null or v_drop.id is null or v_keep.organization_id <> v_drop.organization_id or p_keep = p_drop then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  perform public._require(v_keep.organization_id, 'customer.manage');
  update public.bookings set customer_id = p_keep where customer_id = p_drop;
  update public.customers set merged_into_id = p_keep where id = p_drop;
  perform public._audit(v_keep.organization_id, 'merge', 'customers', p_keep::text, to_jsonb(v_drop), null);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------- Kết nối ----------------------------

create function public.connection_create(
  p_org uuid, p_channel public.channel_kind, p_account text, p_capabilities jsonb, p_ttl int default 900
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public._require(p_org, 'connection.manage');
  -- Nguồn nội bộ (nhập file) không phải kênh ngoài: không có gì để mô phỏng hay chờ phê duyệt, và
  -- booking của nó không được mang nhãn "Mô phỏng".
  insert into public.channel_connections
    (organization_id, channel, account_name, mode, status, approval_status, capabilities, hold_ttl_seconds)
  values (p_org, p_channel, p_account,
    case when p_channel = 'manual' then 'production'::public.connection_mode else 'mock'::public.connection_mode end,
    case when p_channel = 'manual' then 'connected'::public.connection_status else 'simulated'::public.connection_status end,
    case when p_channel = 'manual' then 'not_required' else 'not_requested' end,
    coalesce(p_capabilities, '{}'), coalesce(p_ttl, 900))
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'duplicate_connection');
  end if;
  perform public._audit(p_org, 'create', 'channel_connections', v_id::text);
  return jsonb_build_object('ok', true, 'connection_id', v_id);
end $$;

-- Không có đường nào từ giao diện đặt status='connected'. Chỉ cổng thật dùng service_role mới báo được.
create function public.connection_update(p_connection uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections%rowtype;
  v_mode public.connection_mode;
begin
  select * into v_c from public.channel_connections where id = p_connection;
  perform public._require(v_c.organization_id, 'connection.manage');
  v_mode := coalesce((p_patch ->> 'mode')::public.connection_mode, v_c.mode);
  if v_mode = 'production' and coalesce(p_patch ->> 'approval_status', v_c.approval_status) <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'production_needs_approval');
  end if;
  update public.channel_connections set
    account_name = coalesce(p_patch ->> 'account_name', account_name),
    supplier_account_ref = coalesce(p_patch ->> 'supplier_account_ref', supplier_account_ref),
    mode = v_mode,
    status = case
      when v_mode = v_c.mode then status
      when v_mode = 'mock' then 'simulated'::public.connection_status
      else 'not_configured'::public.connection_status
    end,
    last_success_at = case when v_mode = 'mock' then null else last_success_at end,
    approval_status = coalesce(p_patch ->> 'approval_status', approval_status),
    hold_ttl_seconds = coalesce((p_patch ->> 'hold_ttl_seconds')::int, hold_ttl_seconds),
    credential_ref = coalesce(p_patch ->> 'credential_ref', credential_ref),
    stale_after_minutes = coalesce((p_patch ->> 'stale_after_minutes')::int, stale_after_minutes)
  where id = p_connection;
  perform public._audit(v_c.organization_id, 'update', 'channel_connections', p_connection::text, to_jsonb(v_c), p_patch);
  return jsonb_build_object('ok', true);
end $$;

-- Chỉ service_role (cổng thật sau khi đã xác minh). Không cấp cho authenticated.
create function public.connection_mark_health(p_connection uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.channel_connections set
    status = case when p_ok then 'connected'::public.connection_status else 'error'::public.connection_status end,
    last_success_at = case when p_ok then now() else last_success_at end,
    last_error = case when p_ok then null else p_error end,
    last_error_at = case when p_ok then last_error_at else now() end
  where id = p_connection;
end $$;

-- Lưu ánh xạ, và khi đã kiểm tra thì xếp lại các booking đang chờ.
create function public.mapping_save(
  p_mapping uuid, p_org uuid, p_connection uuid, p_product text, p_option text, p_tour_option uuid,
  p_language text, p_default_time time, p_traveler_map jsonb, p_verified boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_mapping;
  v_moved int := 0;
  r record;
  v_res record;
  v_place text;
begin
  perform public._require(p_org, 'connection.manage');
  if p_verified and p_tour_option is null then
    return jsonb_build_object('ok', false, 'code', 'verified_needs_target');
  end if;
  insert into public.channel_product_mappings
    (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, language,
     default_local_time, traveler_map, is_verified, verified_by, verified_at)
  values (p_org, p_connection, p_product, coalesce(p_option, ''), p_tour_option, p_language, p_default_time,
    coalesce(p_traveler_map, '{}'), p_verified, case when p_verified then (select auth.uid()) end, case when p_verified then now() end)
  on conflict (organization_id, connection_id, external_product_code, external_option_code) do update set
    tour_option_id = excluded.tour_option_id, language = excluded.language,
    default_local_time = excluded.default_local_time, traveler_map = excluded.traveler_map,
    is_verified = excluded.is_verified, verified_by = excluded.verified_by, verified_at = excluded.verified_at
  returning id into v_id;

  perform public._audit(p_org, 'save', 'channel_product_mappings', v_id::text);

  if p_verified then
    for r in
      select i.*, b.status as b_status from public.booking_items i
      join public.bookings b on b.id = i.booking_id
      where b.organization_id = p_org and b.connection_id = p_connection and b.status <> 'cancelled'
        and i.tour_option_id is null and i.external_product_code = p_product
        and coalesce(i.external_option_code, '') = coalesce(p_option, '')
    loop
      select * into v_res from public._resolve_item(p_org, p_connection, p_product, coalesce(p_option, ''), r.local_date, r.local_time);
      update public.booking_items set tour_option_id = v_res.o_option, tour_id = v_res.o_tour,
        local_time = v_res.o_time, timezone = coalesce(timezone, v_res.o_tz)
      where id = r.id;
      if v_res.o_departure is not null then
        v_place := public._place_item(r.id, v_res.o_departure, r.seats);
        if v_place = 'ok' then
          v_moved := v_moved + 1;
        end if;
      end if;
      update public.bookings set
        needs_action = exists (select 1 from public.booking_items x where x.booking_id = r.booking_id and x.departure_id is null),
        action_reason = case when exists (select 1 from public.booking_items x where x.booking_id = r.booking_id and x.departure_id is null)
          then 'Đã ghép mã, chưa xếp được chuyến' end
      where id = r.booking_id;
      perform public._recompute_booking_ops(r.booking_id);
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'mapping_id', v_id, 'placed', v_moved);
end $$;

-- Chạy lại một sự kiện lỗi từ giao diện.
create function public.retry_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_e public.integration_events%rowtype;
begin
  select * into v_e from public.integration_events where id = p_event;
  perform public._require(v_e.organization_id, 'connection.manage');
  if v_e.status not in ('failed', 'dead') then
    return jsonb_build_object('ok', false, 'code', 'not_retryable');
  end if;
  update public.integration_events set status = 'failed', attempts = 0 where id = p_event;
  return public._process_event(p_event);
end $$;

-- Thông báo: mọi thành viên có quyền phù hợp, hoặc đúng người nhận.
create function public.notifications_mark_read(p_org uuid, p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.notifications set read_at = now()
  where organization_id = p_org and read_at is null and (p_id is null or id = p_id)
    and (user_id is null or user_id = (select auth.uid()))
    and public.has_org_permission(p_org, required_permission);
  return jsonb_build_object('ok', true);
end $$;

-- Thành viên.
create function public.member_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'member.manage');
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'user_id', m.user_id, 'email', p.email,
      'full_name', p.full_name, 'role_key', m.role_key, 'is_active', m.is_active,
      'granted_permissions', m.granted_permissions, 'revoked_permissions', m.revoked_permissions) order by p.email), '[]'::jsonb)
    from public.memberships m join public.profiles p on p.id = m.user_id
    where m.organization_id = p_org
  );
end $$;

create function public.member_upsert(
  p_org uuid, p_email text, p_role text, p_granted text[] default '{}', p_revoked text[] default '{}', p_active boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  perform public._require(p_org, 'member.manage');
  if p_role = 'owner' and not public.has_org_permission(p_org, 'org.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(p_email);
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;
  -- Không tự khóa mình và không để doanh nghiệp mất chủ.
  if v_user = (select auth.uid()) and not coalesce(p_active, true) then
    return jsonb_build_object('ok', false, 'code', 'cannot_deactivate_self');
  end if;
  if exists (select 1 from public.memberships where organization_id = p_org and user_id = v_user and role_key = 'owner')
     and (p_role <> 'owner' or not coalesce(p_active, true))
     and (select count(*) from public.memberships where organization_id = p_org and role_key = 'owner' and is_active) <= 1 then
    return jsonb_build_object('ok', false, 'code', 'last_owner');
  end if;
  insert into public.memberships (organization_id, user_id, role_key, granted_permissions, revoked_permissions, is_active)
  values (p_org, v_user, p_role, coalesce(p_granted, '{}'), coalesce(p_revoked, '{}'), coalesce(p_active, true))
  on conflict (organization_id, user_id) do update set
    role_key = excluded.role_key, granted_permissions = excluded.granted_permissions,
    revoked_permissions = excluded.revoked_permissions, is_active = excluded.is_active;
  perform public._audit(p_org, 'member_upsert', 'memberships', v_user::text, null,
    jsonb_build_object('role', p_role, 'active', p_active));
  return jsonb_build_object('ok', true);
end $$;
