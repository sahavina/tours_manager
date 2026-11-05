-- Người có thể được gán phụ trách booking. Nhân viên booking cần gán người phụ trách (đặc tả §7.2) nhưng không có
-- member.manage: member_list thì lộ email và quyền của mọi thành viên, nên có hàm riêng chỉ trả mã và tên.
create function public.member_assignable(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'booking.manage');
  return (
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(p.full_name, p.email)) order by coalesce(p.full_name, p.email)), '[]'::jsonb)
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    where m.organization_id = p_org and m.is_active and m.role_key <> 'guide'
  );
end $$;

revoke all on function public.member_assignable(uuid) from public, anon, authenticated;
grant execute on function public.member_assignable(uuid) to authenticated, service_role;
