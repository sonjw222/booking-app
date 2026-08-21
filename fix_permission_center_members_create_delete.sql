-- ============================================================
-- P1-5b (Bucket 2) — center_members 등록/삭제
--
-- 배경: center_members(회원-센터 연결) 수정(등급/메모/상태)은 이미
--   customer.member.update로 좁혀져 있다(fix_member_status.sql, Live 적용됨). 하지만
--   등록(insert, "+회원" 버튼)과 삭제(delete)는 여전히 my_managed_center_ids()만 체크한다
--   (P1-5 4차 조사). 삭제는 현재 UI/lib에 호출하는 곳이 없지만(customer.member.delete에
--   대응하는 기능 미구현), RLS 자체는 이미 존재해 누구나 직접 delete를 호출할 수 있는
--   상태라 함께 좁혀둔다 — 새 기능 추가가 아니라 기존 정책 보강.
--
-- ⚠ 동작 변경 주의: customer.member.create를 아직 역할에 안 준 기존 스태프는
--   "+회원"으로 새 회원을 등록하지 못하게 된다. 오너는 영향 없음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "매니저 센터회원 등록" on center_members;
create policy "매니저 센터회원 등록"
    on center_members for insert
    with check (has_permission(center_id, 'customer.member.create'));

drop policy if exists "매니저 센터회원 삭제" on center_members;
create policy "매니저 센터회원 삭제"
    on center_members for delete
    using (has_permission(center_id, 'customer.member.delete'));

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'center_members' order by cmd;
