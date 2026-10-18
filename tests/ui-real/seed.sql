-- 격리 QA 시드(서울시청 기준 좌표). 평점/후기/좌표가 있는 센터, 후기 없는 센터, 좌표 없는 센터를 섞는다.
insert into centers (id, name, categories, intro, address, latitude, longitude, created_at) values
 ('00000000-0000-4000-8000-000000000001', '하늘 요가 스튜디오', '{요가}', '도심 속 조용한 요가 공간', '서울 중구 세종대로 110', 37.5745, 126.9780, now() - interval '1 day'),
 ('00000000-0000-4000-8000-000000000002', '가람 요가', '{요가,필라테스}', '소규모 그룹 수업', '서울 성북구 보문로 12', 37.6060, 126.9780, now() - interval '2 day'),
 ('00000000-0000-4000-8000-000000000003', '나무 요가 아카데미 — 매우 긴 센터 이름이 들어가도 레이아웃이 깨지지 않아야 합니다 한국어 센터명 테스트', '{요가}', null, '경기 고양시 덕양구 1', 37.6430, 126.9780, now() - interval '3 day'),
 ('00000000-0000-4000-8000-000000000004', '다온 요가', '{요가}', '위치 정보 없는 센터', null, null, null, now() - interval '4 day'),
 ('00000000-0000-4000-8000-000000000005', '필라테스 전용 센터', '{필라테스}', null, '서울 강남구', 37.5, 127.03, now() - interval '5 day');
insert into profiles (id, name, nickname) select ('00000000-0000-4000-8000-1000000000' || lpad(g::text, 2, '0'))::uuid, '회원' || g, null from generate_series(1, 5) g;
insert into center_reviews (center_id, profile_id, rating) values
 ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-100000000001', 5), ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-100000000002', 4), ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-100000000003', 5),
 ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-100000000004', 3), ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-100000000005', 4);
insert into rooms values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'A룸');
insert into products (id, center_id, name, price, total_count) values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', '하타 10회권', 150000, 10), ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001', '기간제 1개월', 120000, null);
insert into classes (id, center_id, title, description, class_format, place, room_id, start_time, end_time, capacity, status, booking_deadline_min, pass_selection_mode) values
 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', '아침 하타 요가', E'호흡과 정렬에 집중하는 기본 하타 요가 수업이에요.\n초보자도 편하게 참여할 수 있어요.', 'group', null, '00000000-0000-4000-8000-0000000000a1', now() + interval '2 day', now() + interval '2 day 1 hour', 10, 'open', 60, 'selected'),
 ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', '아침 하타 요가', null, 'group', null, null, now() + interval '9 day', now() + interval '9 day 1 hour', 10, 'open', null, 'all'),
 ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000001', '저녁 빈야사', null, 'private', '2층 스튜디오', null, now() + interval '3 day', now() + interval '3 day 1 hour', 1, 'open', null, 'all'),
 ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000001', '폐강된 수업', null, 'group', null, null, now() + interval '4 day', now() + interval '4 day 1 hour', 10, 'cancelled', null, 'all'),
 ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-000000000001', '정원 마감 수업', null, 'group', null, null, now() + interval '5 day', now() + interval '5 day 1 hour', 2, 'open', null, 'all');
insert into reservations (class_id, status) select '00000000-0000-4000-8000-0000000000c1', 'confirmed' from generate_series(1,4);
insert into reservations (class_id, status) select '00000000-0000-4000-8000-0000000000c5', 'confirmed' from generate_series(1,2);
insert into class_allowed_products values ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1'), ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b2');
insert into class_trainers values ('00000000-0000-4000-8000-0000000000c1', '김하늘', 1), ('00000000-0000-4000-8000-0000000000c1', '이가람', 2);
-- 후기가 많은 센터: 2,500건(1,000행 페이지 3번에 걸쳐 조회되는지) — 평균 4.6 (5점 1,500 + 4점 1,000)
insert into centers (id, name, categories, address, latitude, longitude, created_at) values ('00000000-0000-4000-8000-000000000006', '후기 많은 요가', '{요가}', '서울 마포구 월드컵로 1', 37.5563, 126.9236, now() - interval '6 day');
insert into profiles (id, name) select ('00000000-0000-4000-8000-2' || lpad(g::text, 11, '0'))::uuid, '대량회원' || g from generate_series(1, 2500) g;
insert into center_reviews (center_id, profile_id, rating) select '00000000-0000-4000-8000-000000000006', ('00000000-0000-4000-8000-2' || lpad(g::text, 11, '0'))::uuid, case when g <= 1500 then 5 else 4 end from generate_series(1, 2500) g;
