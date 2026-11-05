-- Xếp lần đầu một booking đang chờ vào đúng chuyến khách đã đặt thì không có gì khác với kênh,
-- nên không được ghi "cần xử lý tay trên kênh", và phải gỡ cờ "chưa xếp được chuyến" khi đã xếp đủ.
-- Đổi sang ngày, giờ, tour hoặc gói khác vẫn là manual_required như cũ.
create or replace function public.move_booking_item(p_item uuid, p_departure uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_i public.booking_items%rowtype;
  v_b public.bookings%rowtype;
  v_to public.departures%rowtype;
  v_place text;
  v_first boolean;
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
  v_channel_status := case when v_b.connection_id is null or v_first then 'not_applicable'::public.channel_request_status
    else 'manual_required'::public.channel_request_status end;

  insert into public.booking_changes
    (organization_id, booking_id, change_type, summary, before_data, after_data, source, actor_id, channel_request_status)
  values (v_i.organization_id, v_b.id, case when v_first then 'placed' else 'moved' end,
    case when v_first then format('Xếp vào chuyến: %s %s', v_to.local_date, v_to.local_time)
      else format('Chuyển chuyến: %s %s → %s %s', v_i.local_date, v_i.local_time, v_to.local_date, v_to.local_time) end,
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure),
    'internal', (select auth.uid()), v_channel_status);

  -- Chỉ gỡ đúng cờ do mapping_save đặt; cờ do người đánh dấu hoặc lý do khác vẫn giữ.
  update public.bookings set needs_action = false, action_reason = null
  where id = v_b.id and needs_action and action_reason = 'Đã ghép mã, chưa xếp được chuyến'
    and not exists (select 1 from public.booking_items x where x.booking_id = v_b.id and x.departure_id is null);

  perform public._recompute_booking_ops(v_b.id);
  perform public._audit(v_i.organization_id, 'move', 'booking_items', p_item::text,
    jsonb_build_object('departure_id', v_i.departure_id), jsonb_build_object('departure_id', p_departure));
  insert into public.outbox_events (organization_id, topic, aggregate_id, payload)
  values (v_i.organization_id, 'availability.changed', p_item::text, '{}');

  return jsonb_build_object('ok', true, 'channel_request_status', v_channel_status);
end $$;
