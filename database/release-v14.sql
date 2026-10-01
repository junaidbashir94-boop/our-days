-- v14 coordinated release candidate. Apply in staging before production approval.
BEGIN;
ALTER POLICY "v13 visible schedules" ON public.days_off USING (member_id=public.current_member_id() AND group_id=public.current_group_id());
ALTER POLICY "v13 visible meal overrides" ON public.meal_availability_overrides USING (member_id=public.current_member_id() AND group_id=public.current_group_id());
CREATE OR REPLACE FUNCTION public.get_group_schedule_visible()
 RETURNS TABLE(id bigint, member_id uuid, day date, availability_type text, note text, source text, import_file_name text, imported_at timestamp with time zone, entry_type text, shift_start_min integer, shift_end_min integer, raw_value text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ctx as (
    select public.current_group_id() as group_id, public.current_member_id() as member_id
  )
  select
    d.id,d.member_id,d.day,case when m.id=ctx.member_id or m.schedule_visibility in ('details','shifts') then d.availability_type::text else 'partial' end,
    case when m.id=ctx.member_id or m.schedule_visibility='details' then d.note else null end,
    case when m.id=ctx.member_id or m.schedule_visibility='details' then d.source::text else null end,
    case when m.id=ctx.member_id or m.schedule_visibility='details' then d.import_file_name else null end,
    case when m.id=ctx.member_id or m.schedule_visibility='details' then d.imported_at else null end,
    case when m.id=ctx.member_id or m.schedule_visibility in ('details','shifts') then d.entry_type::text else 'partial' end,
    case when m.id=ctx.member_id or m.schedule_visibility in ('details','shifts') then d.shift_start_min end,
case when m.id=ctx.member_id or m.schedule_visibility in ('details','shifts') then d.shift_end_min end,
    case
      when m.id=ctx.member_id or m.schedule_visibility='details' then d.raw_value
      when m.schedule_visibility='shifts' then
        case
          when d.entry_type='off' then 'OFF'
          when d.entry_type='shift' and d.shift_start_min is not null and d.shift_end_min is not null
            then lpad((d.shift_start_min/60)::text,2,'0')||lpad((d.shift_start_min%60)::text,2,'0')||'-'||lpad((d.shift_end_min/60)::text,2,'0')||lpad((d.shift_end_min%60)::text,2,'0')
          else upper(coalesce(d.entry_type::text,'busy'))
        end
      else 'PRIVATE'
    end
  from public.days_off d
  join public.members m on m.id=d.member_id
  cross join ctx
  where d.group_id=ctx.group_id
    and (
      d.member_id=ctx.member_id
      or public.v13_members_share_circle(ctx.member_id,d.member_id)
    );
$function$;


CREATE OR REPLACE FUNCTION public.get_group_polls()
 RETURNS TABLE(poll_id uuid, title text, poll_created_at timestamp with time zone, closed boolean, created_by_member_id uuid, creator_name text, option_id uuid, option_day date, option_start_min integer, option_label text, option_sort_order integer, vote_member_id uuid, vote_member_name text, vote_status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.id,
    p.title,
    p.created_at,
    p.closed,
    p.created_by_member_id,
    creator.name,
    o.id,
    o.day,
    o.start_min,
    o.label,
    o.sort_order,
    v.member_id,
    voter.name,
    v.status
  from public.group_polls p
  join public.members creator on creator.id=p.created_by_member_id
  left join public.group_poll_options o on o.poll_id=p.id
  left join public.group_poll_votes v on v.option_id=o.id
  left join public.members voter on voter.id=v.member_id
  where p.group_id=public.current_group_id() and public.v13_can_access_circle(p.circle_id) is true
  order by p.created_at desc,o.sort_order asc,voter.name asc;
$function$;


CREATE OR REPLACE FUNCTION public.get_group_feed(p_limit integer DEFAULT 20)
 RETURNS TABLE(id bigint, kind text, actor_member_id uuid, actor_name text, meta jsonb, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select f.id,f.kind,f.actor_member_id,coalesce(m.name,'Someone') as actor_name,f.meta,f.created_at
  from public.group_activity_feed f
  left join public.members m on m.id=f.actor_member_id
  where f.group_id=public.current_group_id() and public.v13_can_access_circle(f.circle_id) is true
  order by f.created_at desc
  limit greatest(1,least(coalesce(p_limit,20),50));
$function$;


CREATE OR REPLACE FUNCTION public.remove_person_from_circle_v13(p_circle_id uuid, p_target_member_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or public.current_member_id() is null or p_target_member_id is null then raise exception 'Not linked to an account.'; end if;
  if public.v13_can_manage_circle(p_circle_id) is not true and p_target_member_id is distinct from public.current_member_id() then raise exception 'Circle admin access required.'; end if;
  if exists(select 1 from public.shared_circle_memberships where circle_id=p_circle_id and member_id=p_target_member_id and role='admin')
     and (select count(*) from public.shared_circle_memberships where circle_id=p_circle_id and role='admin')<=1 then
    raise exception 'A circle must keep at least one admin.';
  end if;
  delete from public.shared_circle_memberships where circle_id=p_circle_id and member_id=p_target_member_id;
end;
$function$;


CREATE OR REPLACE FUNCTION public.delete_group_poll_v13_2(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid:=public.current_member_id();v_creator uuid;v_circle uuid;begin
 if auth.uid() is null or v_me is null then raise exception 'Not linked to an account.'; end if;
  select created_by_member_id,circle_id into v_creator,v_circle from public.group_polls where id=p_poll_id;
  if v_creator is null or public.v13_can_access_circle(v_circle) is not true or (v_me is distinct from v_creator and public.v13_can_manage_circle(v_circle) is not true) then raise exception 'Only the poll creator or circle admin can delete this poll.';end if;
  delete from public.group_polls where id=p_poll_id;
end;$function$;


CREATE OR REPLACE FUNCTION public.delete_group_poll_option_v13_2(p_poll_id uuid, p_option_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid:=public.current_member_id();v_creator uuid;v_circle uuid;begin
 if auth.uid() is null or v_me is null then raise exception 'Not linked to an account.'; end if;
  select created_by_member_id,circle_id into v_creator,v_circle from public.group_polls where id=p_poll_id and not closed;
  if v_creator is null or public.v13_can_access_circle(v_circle) is not true or (v_me is distinct from v_creator and public.v13_can_manage_circle(v_circle) is not true) then raise exception 'Only the poll creator or circle admin can remove options.';end if;
  if (select count(*) from public.group_poll_options where poll_id=p_poll_id)<=2 then raise exception 'A poll must keep at least 2 options.';end if;
  delete from public.group_poll_options where id=p_option_id and poll_id=p_poll_id;
end;$function$;


REVOKE EXECUTE ON FUNCTION public.v13_2_log_app_activity(uuid,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.remove_person_from_circle_v13(uuid,uuid), public.delete_group_poll_v13_2(uuid), public.delete_group_poll_option_v13_2(uuid,uuid) FROM PUBLIC,anon;
CREATE OR REPLACE FUNCTION public.apply_full_rota_import(p_entries jsonb, p_member_ids uuid[], p_from_date date, p_to_date date, p_file_name text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid := public.current_member_id();
  v_group uuid := public.current_group_id();
  v_owner boolean;
  v_my_role text;
  v_item jsonb;
  v_member uuid;
  v_day date;
  v_type text;
  v_start integer;
  v_end integer;
  v_raw text;
  v_saved integer := 0;
  v_file text := nullif(trim(coalesce(p_file_name,'')), '');
begin
  if v_me is null or v_group is null then
    raise exception 'This device is not linked to a group.';
  end if;

  select is_owner, role into v_owner, v_my_role
  from public.members
  where id = v_me;

  if v_my_role <> 'member' and not v_owner then
    raise exception 'Viewers cannot import a rota.';
  end if;

  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then
    raise exception 'Invalid rota date range.';
  end if;

  if (p_to_date - p_from_date) > 730 then
    raise exception 'Rota date range is too large.';
  end if;

  if v_file is not null and char_length(v_file) > 200 then
    raise exception 'File name is too long.';
  end if;

  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Invalid rota import data.';
  end if;

  if jsonb_array_length(p_entries) > 10000 then
    raise exception 'Too many rota entries in one import.';
  end if;

  if coalesce(array_length(p_member_ids, 1), 0) = 0 then
    raise exception 'No members were selected for import.';
  end if;

  -- Validate all target members.
  if exists (
    select 1
    from unnest(p_member_ids) target_id
    left join public.members m
      on m.id = target_id
      and m.group_id = v_group
      and m.role = 'member'
    where m.id is null
  ) then
    raise exception 'One or more selected members are invalid.';
  end if;

  if not v_owner and exists (
    select 1 from unnest(p_member_ids) x where x <> v_me
  ) then
    raise exception 'You can import only your own rota.';
  end if;

  -- v14: preserve unselected dates; upsert below still preserves manual rows.
  if exists (select 1 from jsonb_array_elements(p_entries) e group by e->>'member_id',e->>'day' having count(*)>1) then
    raise exception 'Duplicate person/date entries. Review the import mapping.';
  end if;
  for v_item in select value from jsonb_array_elements(p_entries)
  loop
    v_member := nullif(v_item->>'member_id','')::uuid;
    v_day := nullif(v_item->>'day','')::date;
    v_type := lower(trim(coalesce(v_item->>'entry_type','')));
    v_start := nullif(v_item->>'start_min','')::integer;
    v_end := nullif(v_item->>'end_min','')::integer;
    v_raw := nullif(left(trim(coalesce(v_item->>'raw_value','')), 120), '');

    if v_member is null or not (v_member = any(p_member_ids)) then
      raise exception 'An imported entry is mapped to an invalid member.';
    end if;

    if v_day is null or v_day < p_from_date or v_day > p_to_date then
      raise exception 'An imported date falls outside the rota date range.';
    end if;

    if v_type not in ('off', 'shift', 'busy') then
      raise exception 'Invalid imported rota type: %', v_type;
    end if;

    if v_type = 'shift' then
      if v_start is null or v_end is null
        or v_start < 0 or v_start > 1439
        or v_end < 0 or v_end > 1439 then
        raise exception 'Invalid imported shift time.';
      end if;
    else
      v_start := null;
      v_end := null;
    end if;

    -- Non-owner safety.
    if not v_owner and v_member <> v_me then
      raise exception 'You can import only your own rota.';
    end if;

    insert into public.days_off(
      group_id, member_id, day, availability_type, note,
      source, import_file_name, imported_at,
      entry_type, shift_start_min, shift_end_min, raw_value
    )
    values (
      v_group, v_member, v_day,
      case when v_type = 'off' then 'off' else 'partial' end,
      null,
      'pdf', v_file, now(),
      v_type, v_start, v_end, v_raw
    )
    on conflict (member_id, day)
    do update set
      availability_type = excluded.availability_type,
      note = null,
      source = 'pdf',
      import_file_name = excluded.import_file_name,
      imported_at = excluded.imported_at,
      entry_type = excluded.entry_type,
      shift_start_min = excluded.shift_start_min,
      shift_end_min = excluded.shift_end_min,
      raw_value = excluded.raw_value
    where public.days_off.source = 'pdf';

    if exists (
      select 1
      from public.days_off
      where member_id = v_member
        and day = v_day
        and source = 'pdf'
    ) then
      v_saved := v_saved + 1;
    end if;
  end loop;

  return v_saved;
end;
$function$;


CREATE TABLE IF NOT EXISTS public.member_availability_preferences (
  member_id uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_availability_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_availability_preferences FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_my_preferences_v14() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid:=public.current_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  RETURN (SELECT preferences FROM public.member_availability_preferences WHERE member_id=v_me);
END; $$;

CREATE OR REPLACE FUNCTION public.save_my_preferences_v14(p_preferences jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid:=public.current_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  IF jsonb_typeof(p_preferences) IS DISTINCT FROM 'object'
    OR (p_preferences->>'commuteBefore')::integer NOT IN (0,30,45,60)
    OR (p_preferences->>'commuteAfter')::integer NOT IN (0,30,45,60)
    OR (p_preferences->>'postNightUntil')::integer NOT BETWEEN 0 AND 1439
    OR (p_preferences->>'minWindow')::integer NOT IN (45,60,90,120)
    OR (p_preferences->>'preferredPeriod') NOT IN ('any','breakfast','dinner')
    OR NOT p_preferences ?& ARRAY['commuteBefore','commuteAfter','postNightUntil','minWindow','preferredPeriod']
    OR EXISTS(SELECT 1 FROM jsonb_each(p_preferences) x WHERE x.value='null'::jsonb)
  THEN RAISE EXCEPTION 'Invalid availability preferences.'; END IF;
  INSERT INTO public.member_availability_preferences(member_id,preferences) VALUES(v_me,jsonb_build_object(
    'commuteBefore',(p_preferences->>'commuteBefore')::integer,'commuteAfter',(p_preferences->>'commuteAfter')::integer,
    'postNightUntil',(p_preferences->>'postNightUntil')::integer,'minWindow',(p_preferences->>'minWindow')::integer,
    'preferredPeriod',p_preferences->>'preferredPeriod'))
  ON CONFLICT(member_id) DO UPDATE SET preferences=excluded.preferences,updated_at=now();
END; $$;

-- Derived availability is the shared boundary. Raw preferences never leave this function.
CREATE OR REPLACE FUNCTION public.get_availability_v14(p_from date,p_to date)
RETURNS TABLE(member_id uuid,day date,intervals jsonb,full_day_off boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_me uuid:=public.current_member_id(); m record; d date; c public.days_off%rowtype;
  prev public.days_off%rowtype; nxt public.days_off%rowtype;
  prefs jsonb; before_min integer; after_min integer; recovery integer;
  points integer[]; start_min integer; end_min integer; idx integer;
  b_override text; l_override text; d_override text; override_status text; status text; result jsonb; is_full boolean;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>180 THEN RAISE EXCEPTION 'Choose a range of at most 181 days.'; END IF;
  FOR m IN SELECT x.id FROM public.members x
    WHERE x.group_id=public.current_group_id() AND (x.id=v_me OR public.v13_members_share_circle(v_me,x.id))
    AND (x.id=v_me OR EXISTS(SELECT 1 FROM public.shared_circle_memberships s
      WHERE s.member_id=x.id AND s.member_type='working' AND public.v13_can_access_circle(s.circle_id)))
  LOOP
    SELECT p.preferences INTO prefs FROM public.member_availability_preferences p WHERE p.member_id=m.id;
    before_min:=coalesce((prefs->>'commuteBefore')::integer,0);
    after_min:=coalesce((prefs->>'commuteAfter')::integer,0);
    recovery:=coalesce((prefs->>'postNightUntil')::integer,960);
    FOR d IN SELECT generate_series(p_from,p_to,interval '1 day')::date LOOP
      SELECT * INTO c FROM public.days_off x WHERE x.member_id=m.id AND x.day=d;
      SELECT * INTO prev FROM public.days_off x WHERE x.member_id=m.id AND x.day=d-1;
      SELECT * INTO nxt FROM public.days_off x WHERE x.member_id=m.id AND x.day=d+1;
      SELECT x.status INTO b_override FROM public.meal_availability_overrides x WHERE x.member_id=m.id AND x.day=d AND x.meal='breakfast';
      SELECT x.status INTO l_override FROM public.meal_availability_overrides x WHERE x.member_id=m.id AND x.day=d AND x.meal='lunch';
      SELECT x.status INTO d_override FROM public.meal_availability_overrides x WHERE x.member_id=m.id AND x.day=d AND x.meal='dinner';
      points:=ARRAY[0,480,720,960,1440];
      IF c.entry_type='shift' THEN
        points:=array_append(points,c.shift_start_min-before_min);
        IF c.shift_end_min>c.shift_start_min THEN points:=array_append(points,c.shift_end_min+after_min); END IF;
      END IF;
      IF prev.entry_type='shift' THEN
        points:=array_append(points,CASE WHEN prev.shift_end_min<=prev.shift_start_min
          THEN greatest(prev.shift_end_min+after_min,recovery) ELSE prev.shift_end_min+after_min-1440 END);
      END IF;
      IF nxt.entry_type='shift' THEN points:=array_append(points,1440+nxt.shift_start_min-before_min); END IF;
      SELECT array_agg(t.n ORDER BY t.n) INTO points FROM
        (SELECT DISTINCT greatest(0,least(1440,x)) n FROM unnest(points) x WHERE x IS NOT NULL) t;
      result:='[]'::jsonb;is_full:=true;
      FOR idx IN 1..array_length(points,1)-1 LOOP
        start_min:=points[idx];end_min:=points[idx+1];
        override_status:=CASE WHEN start_min<720 THEN b_override WHEN start_min<960 THEN l_override ELSE d_override END;
        status:=CASE
          WHEN override_status='available' THEN 'free'
          WHEN override_status='unavailable' THEN 'busy'
          WHEN prev.entry_type='shift' AND prev.shift_start_min IS NOT NULL AND prev.shift_end_min IS NOT NULL AND
            start_min<CASE WHEN prev.shift_end_min<=prev.shift_start_min THEN greatest(prev.shift_end_min+after_min,recovery) ELSE prev.shift_end_min+after_min-1440 END THEN 'busy'
          WHEN nxt.entry_type='shift' AND nxt.shift_start_min IS NOT NULL AND start_min>=1440+nxt.shift_start_min-before_min THEN 'busy'
          WHEN c.id IS NULL THEN 'unknown'
          WHEN c.entry_type='off' THEN 'free'
          WHEN c.entry_type='busy' THEN 'busy'
          WHEN c.entry_type IS DISTINCT FROM 'shift' OR c.shift_start_min IS NULL OR c.shift_end_min IS NULL THEN 'unknown'
          WHEN start_min>=c.shift_start_min-before_min AND (c.shift_end_min<=c.shift_start_min OR start_min<c.shift_end_min+after_min) THEN 'busy'
          ELSE 'free' END;
        is_full:=is_full AND status='free';
        -- Merge adjacent states so hidden shift boundaries are not returned unnecessarily.
        IF jsonb_array_length(result)>0 AND result->-1->>'status'=status THEN
          result:=jsonb_set(result,ARRAY[(jsonb_array_length(result)-1)::text,'end'],to_jsonb(end_min));
        ELSE result:=result||jsonb_build_array(jsonb_build_object('start',start_min,'end',end_min,'status',status)); END IF;
      END LOOP;
      member_id:=m.id;day:=d;intervals:=result;full_day_off:=is_full;RETURN NEXT;
    END LOOP;
  END LOOP;
END; $$;
REVOKE EXECUTE ON FUNCTION public.get_my_preferences_v14(),public.save_my_preferences_v14(jsonb),public.get_availability_v14(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_preferences_v14(),public.save_my_preferences_v14(jsonb),public.get_availability_v14(date,date) TO authenticated;

ALTER TABLE public.group_events ADD COLUMN IF NOT EXISTS end_min integer;
ALTER TABLE public.group_events ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Europe/London';
CREATE OR REPLACE FUNCTION public.save_circle_event_v14(p_event_id bigint, p_circle_id uuid, p_day date, p_title text, p_start_min integer DEFAULT NULL::integer, p_location text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_category text DEFAULT 'other'::text, p_end_min integer DEFAULT NULL, p_time_zone text DEFAULT 'Europe/London')
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid:=public.current_member_id();
  v_group uuid:=public.current_group_id();
  v_id bigint;
  v_creator uuid;
  v_circle uuid;
  v_title text:=trim(coalesce(p_title,''));
  v_location text:=nullif(trim(coalesce(p_location,'')),'');
  v_note text:=nullif(trim(coalesce(p_note,'')),'');
  v_category text:=lower(trim(coalesce(p_category,'other')));
begin
  if v_me is null or v_group is null then raise exception 'Not linked to an account.'; end if;
  if (select role from public.members where id=v_me)='pending' then raise exception 'Join a circle before making plans.'; end if;
  if v_title='' or char_length(v_title)>100 then raise exception 'Plan title must be 1–100 characters.'; end if;
  if p_day is null then raise exception 'Choose a plan date.'; end if;
  if p_start_min is not null and (p_start_min<0 or p_start_min>1439) then raise exception 'Invalid time.'; end if;
  if v_location is not null and char_length(v_location)>160 then raise exception 'Location is too long.'; end if;
  if v_note is not null and char_length(v_note)>400 then raise exception 'Plan details are too long.'; end if;
  if v_category not in ('dinner','home','coffee','breakfast','party','trip','dayout','other') then v_category:='other'; end if;

  if not exists(select 1 from pg_timezone_names where name=p_time_zone) then raise exception 'Invalid time zone.'; end if;
  if p_end_min is not null and (p_start_min is null or p_end_min<=p_start_min or p_end_min>p_start_min+1440) then raise exception 'End time must be after the start and within 24 hours.'; end if;
  if p_event_id is null then
    if not public.v13_can_access_circle(p_circle_id) then raise exception 'You do not have access to that circle.'; end if;
    insert into public.group_events(group_id,circle_id,title,day,start_min,end_min,time_zone,location,note,category,created_by_member_id)
    values(v_group,p_circle_id,v_title,p_day,p_start_min,p_end_min,p_time_zone,v_location,v_note,v_category,v_me)
    returning id into v_id;
    return v_id;
  end if;

  select created_by_member_id,circle_id into v_creator,v_circle
  from public.group_events where id=p_event_id and group_id=v_group;
  if v_creator is null then raise exception 'Plan not found.'; end if;
  if not public.v13_can_access_circle(v_circle) then raise exception 'Plan not available.'; end if;
  if v_creator<>v_me and not public.v13_can_manage_circle(v_circle) then raise exception 'Only the creator or a circle admin can edit this plan.'; end if;
  if p_circle_id<>v_circle and not public.v13_can_manage_circle(v_circle) then raise exception 'Only a circle admin can move a plan.'; end if;
  if not public.v13_can_access_circle(p_circle_id) then raise exception 'You do not have access to the destination circle.'; end if;

  update public.group_events set circle_id=p_circle_id,title=v_title,day=p_day,start_min=p_start_min,end_min=p_end_min,time_zone=p_time_zone,location=v_location,note=v_note,category=v_category,updated_at=now()
  where id=p_event_id;
  return p_event_id;
end;
$function$;


REVOKE EXECUTE ON FUNCTION public.save_circle_event_v14(bigint,uuid,date,text,integer,text,text,text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_circle_event_v14(bigint,uuid,date,text,integer,text,text,text,integer,text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.account_recovery_keys (
  member_id uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 year'
);
ALTER TABLE public.account_recovery_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_recovery_keys FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.set_recovery_key_v14(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid:=public.current_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid recovery key.'; END IF;
  INSERT INTO public.account_recovery_keys(member_id,token_hash) VALUES(v_me,sha256(decode(p_key,'hex')))
  ON CONFLICT(member_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=now()+interval '1 year';
END; $$;
CREATE OR REPLACE FUNCTION public.recover_account_v14(p_key text,p_device_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid;v_uid uuid:=auth.uid();v_group uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in before recovering an account.'; END IF;
  IF EXISTS(SELECT 1 FROM public.member_devices WHERE user_id=v_uid) THEN RAISE EXCEPTION 'This device already has an account.'; END IF;
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid or expired recovery key.'; END IF;
  SELECT member_id INTO v_me FROM public.account_recovery_keys
    WHERE token_hash=sha256(decode(p_key,'hex')) AND expires_at>now() FOR UPDATE;
  IF v_me IS NULL THEN RAISE EXCEPTION 'Invalid or expired recovery key.'; END IF;
  INSERT INTO public.member_devices(member_id,user_id,device_name,last_seen_at)
    VALUES(v_me,v_uid,left(nullif(trim(coalesce(p_device_name,'')),''),80),now());
  DELETE FROM public.account_recovery_keys WHERE member_id=v_me;
  SELECT group_id INTO v_group FROM public.members WHERE id=v_me;
  PERFORM public.v13_2_log_app_activity(v_group,'account_recovered',v_me,v_me,'{}'::jsonb);
  RETURN v_me;
END; $$;
REVOKE EXECUTE ON FUNCTION public.set_recovery_key_v14(text),public.recover_account_v14(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_recovery_key_v14(text),public.recover_account_v14(text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_group_schedule_visible_v14(p_from date,p_to date)
RETURNS TABLE(id bigint,member_id uuid,day date,availability_type text,note text,source text,import_file_name text,imported_at timestamptz,entry_type text,shift_start_min integer,shift_end_min integer,raw_value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL OR public.current_member_id() IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>180 THEN RAISE EXCEPTION 'Choose a range of at most 181 days.'; END IF;
  RETURN QUERY SELECT r.* FROM public.get_group_schedule_visible() r WHERE r.day BETWEEN p_from AND p_to;
END; $$;
REVOKE EXECUTE ON FUNCTION public.get_group_schedule_visible_v14(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_group_schedule_visible_v14(date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_rota_import_v14(p_entries jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid:=public.current_member_id();v_group uuid:=public.current_group_id();v_owner boolean;v_role text;result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL OR v_group IS NULL THEN RAISE EXCEPTION 'Not linked to an account.'; END IF;
  SELECT is_owner,role INTO v_owner,v_role FROM public.members WHERE id=v_me;
  IF v_role IS DISTINCT FROM 'member' AND v_owner IS NOT TRUE THEN RAISE EXCEPTION 'Viewers cannot import a rota.'; END IF;
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid import.'; END IF;
  IF jsonb_array_length(p_entries) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Choose 1–10000 entries.'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_entries) e LEFT JOIN public.members m ON m.id=(e->>'member_id')::uuid
    WHERE m.id IS NULL OR m.group_id IS DISTINCT FROM v_group OR m.role IS DISTINCT FROM 'member' OR (v_owner IS NOT TRUE AND m.id IS DISTINCT FROM v_me))
    THEN RAISE EXCEPTION 'You cannot import for these members.'; END IF;
  SELECT jsonb_build_object('added',count(*) FILTER(WHERE d.id IS NULL),
    'replaced',count(*) FILTER(WHERE d.source='pdf'),'preserved',count(*) FILTER(WHERE d.source='manual')) INTO result
    FROM jsonb_array_elements(p_entries) e LEFT JOIN public.days_off d ON d.member_id=(e->>'member_id')::uuid AND d.day=(e->>'day')::date;
  RETURN result;
END; $$;
REVOKE EXECUTE ON FUNCTION public.preview_rota_import_v14(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_rota_import_v14(jsonb) TO authenticated;

COMMIT;