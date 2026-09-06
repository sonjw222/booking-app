-- 수강권 대분류 표시용 라벨 (2026-09-06)
-- 배경: 센터에 수강권 종류가 많아지면 회원이 고르기 어렵다는 피드백(지윤이누나) —
-- "요일고정 수강권 / 스케줄링 가능 수강권"처럼 큰 분류로 묶어 보여달라는 요청.
-- 회차(4/8/12회)나 요일·시간 조건은 이미 상품별로 만들거나(products.total_count)
-- 예약조건(membership_schedule_rules)으로 표현 가능하므로, 빠진 건 "묶어서 보여주는
-- 표시용 라벨" 하나뿐 — 새 테이블/관계 없이 products에 nullable 텍스트 컬럼만 추가한다.
-- 센터마다 자유 텍스트로 입력(고정 2종으로 강제하지 않음).
alter table products add column if not exists group_label text;

comment on column products.group_label is
  '수강권 표시용 대분류 라벨(자유 텍스트, 센터가 직접 입력) — 예: 요일고정, 자유이용. null이면 미분류로 표시';
