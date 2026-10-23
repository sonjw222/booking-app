-- Local isolated test fixture: production definitions read 2026-10-23; no operational execution.
CREATE OR REPLACE FUNCTION public.has_permission(p_center_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$function$
;
CREATE OR REPLACE FUNCTION public.reply_review(p_review_id uuid, p_reply text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (has_permission(v_center, 'facility.review.reply') or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$function$
;
