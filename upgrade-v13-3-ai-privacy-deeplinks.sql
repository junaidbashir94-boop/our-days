-- Our Days Off v13.3
-- Run AFTER v13.2. Privacy search, per-circle working/viewer role,
-- profile initials, shift dictionary, activity fix and AI-import support.
begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ============================================================
-- 1) PROFILE + CIRCLE ROLE METADATA
-- ============================================================
alter table public.members add column if not exists calendar_initials text;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname='members_calendar_initials_v13_3_check'
  ) then
    alter table public.members add constraint members_calendar_initials_v13_3_check
      check (calendar_initials is null or calendar_initials ~ '^[A-Za-z0-9]{1,3}$');
  end if;
end $$;

alter table public.shared_circles add column if not exists discoverability text not null default 'searchable';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='shared_circles_discoverability_v13_3_check') then
    alter table public.shared_circles add constraint shared_circles_discoverability_v13_3_check
      check (discoverability in ('searchable','invite_only'));
  end if;
end $$;

alter table public.shared_circle_memberships add column if not exists member_type text not null default 'working';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='shared_circle_memberships_member_type_v13_3_check') then
    alter table public.shared_circle_memberships add constraint shared_circle_memberships_member_type_v13_3_check
      check (member_type in ('working','viewer'));
  end if;
end $$;

update public.shared_circle_memberships scm
set member_type=case when m.role='viewer' then 'viewer' else 'working' end
from public.members m
where m.id=scm.member_id
  and (scm.member_type is null or scm.member_type='working');

alter table public.circle_join_requests add column if not exists requested_member_type text not null default 'working';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='circle_join_requests_member_type_v13_3_check') then
    alter table public.circle_join_requests add constraint circle_join_requests_member_type_v13_3_check
      check (requested_member_type in ('working','viewer'));
  end if;
end $$;

create index if not exists shared_circles_search_v13_3_idx
  on public.shared_circles using gin (lower(name) extensions.gin_trgm_ops);

-- ============================================================
-- 2) PRIVACY: CIRCLE TABLE IS MEMBERSHIP-ONLY AGAIN
-- ============================================================
drop policy if exists "v13 circles visible" on public.shared_circles;
drop policy if exists "v13_3 circles visible to members" on public.shared_circles;
create policy "v13_3 circles visible to members" on public.shared_circles
for select to authenticated
using (
  exists(
    select 1 from public.shared_circle_memberships x
    where x.circle_id=shared_circles.id
      and x.member_id=public.current_member_id()
  )
);

-- Keep direct-table selection narrow. Search/invite previews are SECURITY DEFINER RPCs.
revoke select on public.shared_circles from authenticated;
grant select(id,group_id,name,icon,description,is_default,created_at,archived_at,discoverability)
  on public.shared_circles to authenticated;

-- Joined circles only; locked circles are no longer returned as a directory.
drop function if exists public.get_shared_circles_v13();
create function public.get_shared_circles_v13()
returns table(
  id uuid,name text,icon text,description text,my_role text,my_member_type text,
  is_default boolean,member_count integer,archived_at timestamptz,discoverability text
)
language sql security definer set search_path=public as $$
  select c.id,c.name,c.icon,c.description,m.role,m.member_type,c.is_default,
    (select count(*)::integer from public.shared_circle_memberships x where x.circle_id=c.id),
    c.archived_at,c.discoverability
  from public.shared_circles c
  join public.shared_circle_memberships m
    on m.circle_id=c.id and m.member_id=public.current_member_id()
  where c.group_id=public.current_group_id()
  order by (c.archived_at is not null),c.is_default desc,c.created_at,c.name;
$$;
revoke all on function public.get_shared_circles_v13() from public;
grant execute on function public.get_shared_circles_v13() to authenticated;

-- Return memberships only from circles the caller belongs to.
drop function if exists public.get_shared_circle_memberships_v13();
create function public.get_shared_circle_memberships_v13()
returns table(circle_id uuid,member_id uuid,role text,member_type text,joined_at timestamptz)
language sql security definer set search_path=public as $$
  select x.circle_id,x.member_id,x.role,x.member_type,x.joined_at
  from public.shared_circle_memberships x
  where exists(
    select 1 from public.shared_circle_memberships mine
    where mine.circle_id=x.circle_id and mine.member_id=public.current_member_id()
  );
$$;
revoke all on function public.get_shared_circle_memberships_v13() from public;
grant execute on function public.get_shared_circle_memberships_v13() to authenticated;

-- Minimal fuzzy discovery. Never returns member/admin/count/plan information.
create or replace function public.search_shared_circles_v13_3(p_query text)
returns table(circle_id uuid,name text,icon text,description text)
language sql security definer set search_path=public,extensions as $$
  with q as (select lower(trim(coalesce(p_query,''))) as value)
  select c.id,c.name,c.icon,c.description
  from public.shared_circles c,q
  where c.group_id=public.current_group_id()
    and c.archived_at is null
    and c.discoverability='searchable'
    and char_length(q.value)>=2
    and not exists(
      select 1 from public.shared_circle_memberships mine
      where mine.circle_id=c.id and mine.member_id=public.current_member_id()
    )
    and (
      lower(c.name) like '%'||q.value||'%'
      or similarity(lower(c.name),q.value)>=0.22
      or word_similarity(q.value,lower(c.name))>=0.30
    )
  order by greatest(similarity(lower(c.name),q.value),word_similarity(q.value,lower(c.name))) desc,c.name
  limit 8;
$$;
revoke all on function public.search_shared_circles_v13_3(text) from public;
grant execute on function public.search_shared_circles_v13_3(text) to authenticated;

-- Invite-only safe preview: minimal public metadata for a valid active invite.
create or replace function public.get_circle_invite_preview_v13_3(p_circle_code text)
returns table(circle_id uuid,name text,icon text,description text)
language sql security definer set search_path=public as $$
  select c.id,c.name,c.icon,c.description
  from public.circle_invites i
  join public.shared_circles c on c.id=i.circle_id
  where i.code=upper(regexp_replace(coalesce(p_circle_code,''),'[^A-Za-z0-9]','','g'))
    and i.active and c.archived_at is null
  order by i.created_at desc limit 1;
$$;
revoke all on function public.get_circle_invite_preview_v13_3(text) from public;
grant execute on function public.get_circle_invite_preview_v13_3(text) to authenticated;

-- ============================================================
-- 3) JOIN REQUESTS: WORKING MEMBER OR VIEWER, ADMIN OVERRIDES
-- ============================================================
create or replace function public.request_circle_join_by_id_v13_3(p_circle_id uuid,p_member_type text default 'working')
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_group uuid:=public.current_group_id();v_member uuid:=public.current_member_id();
  v_existing uuid;v_request uuid;v_type text:=lower(coalesce(p_member_type,'working'));
begin
  if v_group is null or v_member is null then raise exception 'Your account is not linked.'; end if;
  if v_type not in ('working','viewer') then raise exception 'Choose Working member or Viewer.'; end if;
  if not exists(select 1 from public.shared_circles c where c.id=p_circle_id and c.group_id=v_group and c.archived_at is null and c.discoverability='searchable') then
    raise exception 'Circle not found in search.';
  end if;
  if exists(select 1 from public.shared_circle_memberships x where x.circle_id=p_circle_id and x.member_id=v_member) then raise exception 'You already belong to this circle.'; end if;
  select r.id into v_existing from public.circle_join_requests r
  where r.group_id=v_group and r.circle_id=p_circle_id and r.member_id=v_member and r.status='pending'
  order by r.requested_at desc limit 1;
  if v_existing is not null then
    update public.circle_join_requests set requested_member_type=v_type where id=v_existing;
    return v_existing;
  end if;
  insert into public.circle_join_requests(group_id,circle_id,member_id,request_type,status,requested_member_type)
  values(v_group,p_circle_id,v_member,'join','pending',v_type) returning id into v_request;
  return v_request;
end;$$;
revoke all on function public.request_circle_join_by_id_v13_3(uuid,text) from public;
grant execute on function public.request_circle_join_by_id_v13_3(uuid,text) to authenticated;

-- Invite links work for searchable OR invite-only circles.
create or replace function public.request_circle_join_v13_3(p_circle_code text,p_member_type text default 'working')
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_circle uuid;v_group uuid;v_member uuid:=public.current_member_id();v_type text:=lower(coalesce(p_member_type,'working'));
  v_existing uuid;v_request uuid;
begin
  if v_member is null then raise exception 'Start or continue your account first.'; end if;
  if v_type not in ('working','viewer') then raise exception 'Choose Working member or Viewer.'; end if;
  select i.circle_id,i.group_id into v_circle,v_group
  from public.circle_invites i join public.shared_circles c on c.id=i.circle_id
  where i.code=upper(regexp_replace(coalesce(p_circle_code,''),'[^A-Za-z0-9]','','g')) and i.active and c.archived_at is null
  order by i.created_at desc limit 1;
  if v_circle is null or v_group<>public.current_group_id() then raise exception 'Circle invite not found.'; end if;
  if exists(select 1 from public.shared_circle_memberships x where x.circle_id=v_circle and x.member_id=v_member) then return v_member; end if;
  select r.id into v_existing from public.circle_join_requests r where r.circle_id=v_circle and r.member_id=v_member and r.status='pending' order by requested_at desc limit 1;
  if v_existing is not null then update public.circle_join_requests set requested_member_type=v_type where id=v_existing;return v_existing;end if;
  insert into public.circle_join_requests(group_id,circle_id,member_id,request_type,status,requested_member_type)
  values(v_group,v_circle,v_member,'join','pending',v_type) returning id into v_request;
  return v_request;
end;$$;
revoke all on function public.request_circle_join_v13_3(text,text) from public;
grant execute on function public.request_circle_join_v13_3(text,text) to authenticated;

-- Request list includes requested member type.
drop function if exists public.get_join_requests_v13();
create function public.get_join_requests_v13()
returns table(request_id uuid,member_id uuid,member_name text,public_handle text,circle_id uuid,circle_name text,requested_at timestamptz,request_type text,requested_member_type text)
language sql security definer set search_path=public as $$
  select r.id,m.id,m.name,m.public_handle,r.circle_id,c.name,r.requested_at,r.request_type,r.requested_member_type
  from public.circle_join_requests r
  join public.members m on m.id=r.member_id
  left join public.shared_circles c on c.id=r.circle_id
  where r.group_id=public.current_group_id() and r.status='pending'
    and (
      r.member_id=public.current_member_id()
      or (r.circle_id is not null and public.v13_can_manage_circle(r.circle_id))
      or (r.circle_id is null and public.v13_is_network_owner())
    )
  order by r.requested_at;
$$;
revoke all on function public.get_join_requests_v13() from public;
grant execute on function public.get_join_requests_v13() to authenticated;

create or replace function public.approve_join_request_v13_3(p_request_id uuid,p_member_type text default null)
returns void language plpgsql security definer set search_path=public as $$
declare r public.circle_join_requests%rowtype;v_type text;
begin
  select * into r from public.circle_join_requests where id=p_request_id and status='pending';
  if r.id is null then raise exception 'Request not found.'; end if;
  if r.group_id<>public.current_group_id() then raise exception 'Request not available.'; end if;
  if r.circle_id is null or not public.v13_can_manage_circle(r.circle_id) then raise exception 'Circle admin approval required.'; end if;
  v_type:=lower(coalesce(p_member_type,r.requested_member_type,'working'));
  if v_type not in ('working','viewer') then raise exception 'Invalid member type.'; end if;
  insert into public.shared_circle_memberships(circle_id,member_id,role,member_type)
  values(r.circle_id,r.member_id,'member',v_type)
  on conflict(circle_id,member_id) do update set member_type=excluded.member_type;
  update public.members set role=case when role='pending' then 'member' else role end where id=r.member_id;
  update public.circle_join_requests set status='approved',decided_at=now(),decided_by_member_id=public.current_member_id() where id=p_request_id;
end;$$;
revoke all on function public.approve_join_request_v13_3(uuid,text) from public;
grant execute on function public.approve_join_request_v13_3(uuid,text) to authenticated;

create or replace function public.set_circle_member_type_v13_3(p_circle_id uuid,p_target_member_id uuid,p_member_type text)
returns void language plpgsql security definer set search_path=public as $$
declare v_type text:=lower(coalesce(p_member_type,''));begin
  if not public.v13_can_manage_circle(p_circle_id) then raise exception 'Circle admin access required.'; end if;
  if v_type not in ('working','viewer') then raise exception 'Invalid member type.'; end if;
  update public.shared_circle_memberships set member_type=v_type where circle_id=p_circle_id and member_id=p_target_member_id;
  if not found then raise exception 'Member not found in this circle.'; end if;
end;$$;
revoke all on function public.set_circle_member_type_v13_3(uuid,uuid,text) from public;
grant execute on function public.set_circle_member_type_v13_3(uuid,uuid,text) to authenticated;

-- ============================================================
-- 4) EDIT PROFILE NAME + INITIALS
-- ============================================================
create or replace function public.update_my_profile_v13_3(p_name text,p_initials text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_member_id();v_name text:=trim(coalesce(p_name,''));v_initials text:=upper(nullif(regexp_replace(trim(coalesce(p_initials,'')),'[^A-Za-z0-9]','','g'),''));begin
  if v_me is null then raise exception 'Account not found.'; end if;
  if char_length(v_name)<1 or char_length(v_name)>60 then raise exception 'Name must be 1–60 characters.'; end if;
  if v_initials is not null and char_length(v_initials)>3 then raise exception 'Initials must be 1–3 characters.'; end if;
  update public.members set name=v_name,calendar_initials=v_initials where id=v_me;
end;$$;
revoke all on function public.update_my_profile_v13_3(text,text) from public;
grant execute on function public.update_my_profile_v13_3(text,text) to authenticated;

-- ============================================================
-- 5) PERSONAL SHIFT DICTIONARY
-- ============================================================
create table if not exists public.member_shift_definitions(
  id bigserial primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  code text not null,
  normalized_code text not null,
  kind text not null check(kind in ('working','off','development','leave','busy')),
  start_min integer check(start_min is null or start_min between 0 and 1439),
  end_min integer check(end_min is null or end_min between 0 and 1439),
  updated_at timestamptz not null default now(),
  unique(member_id,normalized_code),
  check(kind<>'working' or (start_min is not null and end_min is not null))
);
alter table public.member_shift_definitions enable row level security;
revoke all on public.member_shift_definitions from authenticated;

create or replace function public.get_my_shift_definitions_v13_3()
returns table(id bigint,code text,kind text,start_min integer,end_min integer,updated_at timestamptz)
language sql security definer set search_path=public as $$
  select d.id,d.code,d.kind,d.start_min,d.end_min,d.updated_at
  from public.member_shift_definitions d
  where d.member_id=public.current_member_id()
  order by upper(d.code);
$$;
revoke all on function public.get_my_shift_definitions_v13_3() from public;
grant execute on function public.get_my_shift_definitions_v13_3() to authenticated;

create or replace function public.upsert_my_shift_definition_v13_3(p_code text,p_kind text,p_start_min integer default null,p_end_min integer default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_member_id();v_code text:=trim(coalesce(p_code,''));v_norm text:=upper(regexp_replace(trim(coalesce(p_code,'')),'[^A-Za-z0-9]+','','g'));v_kind text:=lower(coalesce(p_kind,''));v_id bigint;begin
  if v_me is null then raise exception 'Account not found.'; end if;
  if char_length(v_code)<1 or char_length(v_code)>30 then raise exception 'Shift code must be 1–30 characters.'; end if;
  if v_kind not in ('working','off','development','leave','busy') then raise exception 'Invalid shift type.'; end if;
  if v_kind='working' and (p_start_min is null or p_end_min is null) then raise exception 'Working shifts need start and finish times.'; end if;
  insert into public.member_shift_definitions(member_id,code,normalized_code,kind,start_min,end_min,updated_at)
  values(v_me,v_code,v_norm,v_kind,case when v_kind='working' then p_start_min else null end,case when v_kind='working' then p_end_min else null end,now())
  on conflict(member_id,normalized_code) do update set code=excluded.code,kind=excluded.kind,start_min=excluded.start_min,end_min=excluded.end_min,updated_at=now()
  returning id into v_id;
  return v_id;
end;$$;
revoke all on function public.upsert_my_shift_definition_v13_3(text,text,integer,integer) from public;
grant execute on function public.upsert_my_shift_definition_v13_3(text,text,integer,integer) to authenticated;

create or replace function public.delete_my_shift_definition_v13_3(p_id bigint)
returns void language sql security definer set search_path=public as $$
  delete from public.member_shift_definitions where id=p_id and member_id=public.current_member_id();
$$;
revoke all on function public.delete_my_shift_definition_v13_3(bigint) from public;
grant execute on function public.delete_my_shift_definition_v13_3(bigint) to authenticated;

-- ============================================================
-- 6) CIRCLE CREATE/EDIT WITH DISCOVERABILITY
-- ============================================================
create or replace function public.create_shared_circle_v13_3(p_name text,p_icon text default '◎',p_description text default null,p_discoverability text default 'searchable')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_group uuid:=public.current_group_id();v_me uuid:=public.current_member_id();v_name text:=trim(coalesce(p_name,''));v_icon text:=trim(coalesce(p_icon,'◎'));v_desc text:=nullif(trim(coalesce(p_description,'')),'');v_disc text:=lower(coalesce(p_discoverability,'searchable'));v_circle uuid;begin
  if v_group is null or v_me is null then raise exception 'Account not found.'; end if;
  if char_length(v_name)<1 or char_length(v_name)>40 then raise exception 'Circle name must be 1–40 characters.'; end if;
  if v_disc not in ('searchable','invite_only') then raise exception 'Invalid discoverability.'; end if;
  insert into public.shared_circles(group_id,name,icon,description,discoverability,created_by_member_id,is_default)
  values(v_group,v_name,coalesce(nullif(v_icon,''),'◎'),v_desc,v_disc,v_me,false) returning id into v_circle;
  insert into public.shared_circle_memberships(circle_id,member_id,role,member_type) values(v_circle,v_me,'admin','working');
  update public.members set role=case when role='pending' then 'member' else role end where id=v_me;
  perform public.v13_2_log_app_activity(v_group,'circle_created',v_me,v_me,jsonb_build_object('circle_id',v_circle,'circle_name',v_name));
  return v_circle;
end;$$;
revoke all on function public.create_shared_circle_v13_3(text,text,text,text) from public;
grant execute on function public.create_shared_circle_v13_3(text,text,text,text) to authenticated;

create or replace function public.edit_shared_circle_v13_3(p_circle_id uuid,p_name text,p_icon text,p_description text default null,p_discoverability text default 'searchable')
returns void language plpgsql security definer set search_path=public as $$
declare v_name text:=trim(coalesce(p_name,''));v_disc text:=lower(coalesce(p_discoverability,'searchable'));v_old text;begin
  if not public.v13_can_manage_circle(p_circle_id) then raise exception 'Circle admin access required.'; end if;
  if char_length(v_name)<1 or char_length(v_name)>40 then raise exception 'Circle name must be 1–40 characters.'; end if;
  if v_disc not in ('searchable','invite_only') then raise exception 'Invalid discoverability.'; end if;
  select name into v_old from public.shared_circles where id=p_circle_id;
  update public.shared_circles set name=v_name,icon=coalesce(nullif(trim(p_icon),''),'◎'),description=nullif(trim(coalesce(p_description,'')),''),discoverability=v_disc where id=p_circle_id;
  if v_old is distinct from v_name then perform public.v13_2_log_app_activity(public.current_group_id(),'circle_renamed',null,public.current_member_id(),jsonb_build_object('circle_id',p_circle_id,'old_name',v_old,'new_name',v_name));end if;
end;$$;
revoke all on function public.edit_shared_circle_v13_3(uuid,text,text,text,text) from public;
grant execute on function public.edit_shared_circle_v13_3(uuid,text,text,text,text) to authenticated;

-- ============================================================
-- 7) FIX APP ACTIVITY: SQL FUNCTION AVOIDS PL/pgSQL OUTPUT-COLUMN AMBIGUITY
-- ============================================================
create or replace function public.get_app_activity_owner_v13_3(p_limit integer default 80)
returns table(id bigint,kind text,member_id uuid,member_name text,actor_member_id uuid,actor_name text,meta jsonb,created_at timestamptz)
language sql security definer set search_path=public as $$
  select a.id,a.kind,a.member_id,m.name,a.actor_member_id,actor.name,a.meta,a.created_at
  from public.app_activity_log a
  left join public.members m on m.id=a.member_id
  left join public.members actor on actor.id=a.actor_member_id
  where a.group_id=public.current_group_id()
    and exists(
      select 1 from public.members owner_row
      where owner_row.id=public.current_member_id()
        and owner_row.group_id=public.current_group_id()
        and owner_row.is_owner
    )
  order by a.created_at desc
  limit greatest(1,least(coalesce(p_limit,80),200));
$$;
revoke all on function public.get_app_activity_owner_v13_3(integer) from public;
grant execute on function public.get_app_activity_owner_v13_3(integer) to authenticated;

commit;
