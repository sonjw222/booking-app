-- ============================================================
-- P2-31 (Category C) — customer.member.phone 실제 서버측 마스킹
--
-- 배경: schema.sql:179 customer.member.phone("회원의 휴대폰 번호 보기") 권한 키가
-- 카탈로그에 있었지만, 지금까지 회원 목록/상세 화면은 이 권한과 무관하게 항상
-- 전화번호를 클라이언트로 그대로 내려보냈다(lib/members.ts의 fetchMembers/
-- fetchMemberDetail이 accounts.phone/profiles.phone을 직접 select). 이 앱에는 전화번호가
-- 두 곳에 따로 있다 — accounts.phone(로그인 계정 전화, 목록 화면에서 씀)과
-- profiles.phone(프로필별 개별 전화, add_profile_fields.sql로 추가, 상세 화면
-- "회원이 마이페이지에서 입력한 정보"에서 씀) — 둘 다 같은 권한으로 가린다.
--
-- 이 권한은 열/행 혼합이라 평범한 RLS(행 단위)로는 못 막는다(같은 행의 다른 컬럼은
-- 보여주면서 전화번호만 null로 바꿔야 함) — RPC로 처리한다. 화면단에서 안 보이게만
-- 하는 게 아니라 응답 자체에 전화번호가 안 담기게 하는 게 목표(네트워크 탭으로 봐도
-- 못 봄).
--
-- 여러 번 실행해도 안전.
-- ============================================================

create or replace function fetch_member_phones_safe(p_profile_ids uuid[], p_center_id uuid)
returns table(profile_id uuid, account_phone text, profile_phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_can boolean;
begin
    v_can := has_permission(p_center_id, 'customer.member.phone') or is_platform_admin();

    return query
        select p.id,
               case when v_can then a.phone else null end,
               case when v_can then p.phone else null end
        from profiles p
        left join accounts a on a.id = p.account_id
        where p.id = any(p_profile_ids);
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname = 'fetch_member_phones_safe';
