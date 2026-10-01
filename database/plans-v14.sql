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
