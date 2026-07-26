-- ============================================================
-- 회원 만료/휴면 처리 권한
--
-- 하는 일:
--   center_members 수정 정책을 권한 기반으로 변경
--   → 회원 정보 수정 권한(customer.member.update)이 있어야 수정 가능
--   → 오너는 항상 통과, 오너가 이 권한을 부여한 매니저만 가능
--   (등급·메모·상태(활성/만료/휴면) 변경 모두 이 권한으로 통제)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "매니저 센터회원 수정" on center_members;
create policy "매니저 센터회원 수정"
    on center_members for update
    using (has_permission(center_id, 'customer.member.update'))
    with check (has_permission(center_id, 'customer.member.update'));


-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies
where tablename = 'center_members' and policyname = '매니저 센터회원 수정';


-- ============================================================
-- 완료!
--   → 회원 관리 → 회원 클릭 → 정보 탭 → "회원 상태"에서 활성/휴면/만료 전환
--   → 다른 매니저에게 맡기려면 [스태프 & 권한]에서
--     '회원 정보 수정'(customer.member.update) 권한을 켜주세요.
-- ============================================================
