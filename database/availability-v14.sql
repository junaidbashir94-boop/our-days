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
