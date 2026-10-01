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
