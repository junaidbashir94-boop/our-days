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
