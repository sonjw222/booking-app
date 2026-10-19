-- 관리자 회원 화면(UX-14) 브라우저 검증용 추가 시드(테스트 전용). run.sh ui-seed 로 적용한다.
update accounts set is_manager = true where id = 'c0000000-0000-0000-0000-00000000000c';
update accounts set phone = '01022223333' where id = 'b0000000-0000-0000-0000-00000000000b';
-- 앱 계정에 연결된 회원인데 전화번호가 없고(app_linked 저장 플래그는 false), 같은 계정의 가족 프로필, 번호가 있는 다른 계정 회원
insert into center_members(center_id, profile_id, app_linked) values
  ('c0a00000-0000-0000-0000-00000000c0a0','a1000000-0000-0000-0000-0000000000a1', false),
  ('c0a00000-0000-0000-0000-00000000c0a0','a2000000-0000-0000-0000-0000000000a2', false),
  ('c0a00000-0000-0000-0000-00000000c0a0','b1000000-0000-0000-0000-0000000000b1', true)
on conflict do nothing;
