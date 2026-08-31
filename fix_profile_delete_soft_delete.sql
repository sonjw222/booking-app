-- ============================================================
-- 프로필(비대표) 삭제가 예약 이력이 있으면 항상 실패하던 버그 수정
--
-- [근본 원인, 실측 확인] lib/profiles.ts의 deleteProfile()이 `delete from profiles`를
-- 그대로 날리는데, reservations.profile_id는 on delete cascade가 없는 일반 FK라서 그
-- 프로필로 만든 예약이 하나라도 있으면(취소된 것 포함) 즉시 FK violation으로 실패한다.
-- 실제로 회원 화면에 이 원본 Postgres 에러 메시지가 그대로 노출됨을 확인:
--   "삭제에 실패했어요: update or delete on table \"profiles\" violates foreign key
--    constraint \"reservations_profile_id_fkey\" on table \"reservations\""
-- 즉 수업을 한 번이라도 예약해본 가족 프로필은 사실상 영원히 삭제할 수 없었다.
--
-- [수정 방향] 계정 탈퇴(supabase/functions/delete-account)가 이미 쓰고 있는 것과 동일한
-- 패턴 — 실제 행을 지우지 않고 개인정보만 익명화 + deleted_at 기록. reservations/
-- memberships/orders 등은 그대로 남아 매니저 쪽 매출·출석 통계, 전자상거래법상 결제·
-- 청약철회 기록 보관 의무를 그대로 만족한다(계정 탈퇴 배치가 남긴 코멘트와 동일한 이유).
-- 계정 탈퇴와 구분하기 위해 익명 이름은 "탈퇴한 회원"이 아니라 "삭제된 프로필"로 다르게 둔다
-- (매니저가 이력을 볼 때 "계정 자체가 탈퇴했다"와 "가족 프로필 하나만 지웠다"를 구분할 수 있게).
--
-- 기존 데이터 영향: profiles.deleted_at 컬럼 추가(기존 행 전부 NULL, 즉 전부 "삭제 안 됨"
-- 상태로 시작 — 이미 삭제 시도가 실패해왔으니 실제로 지워진 프로필 자체가 없음).
-- RLS 영향: 없음(정책 변경 없이 컬럼 추가만) — deleteProfile()이 이제 DELETE 대신 UPDATE를
-- 쓰는데, 기존 "본인 프로필 수정" UPDATE 정책이 이미 이 UPDATE를 허용한다(updateProfile()이
-- 이미 같은 정책으로 동작 중).
--
-- 짝 파일: rollback_fix_profile_delete_soft_delete.sql
-- ============================================================

BEGIN;

alter table profiles add column if not exists deleted_at timestamptz;

comment on column profiles.deleted_at is
    '이 프로필을 회원이 "삭제"한 시각. 실제 행은 지우지 않고 개인정보만 익명화한다
     (계정 탈퇴와 동일한 이유 — reservations 등 이력 보존). null이면 삭제 안 된 상태.
     계정 탈퇴(delete-account Edge Function)와는 별개 — 계정 탈퇴는 이 값을 건드리지 않고
     모든 프로필의 개인정보를 직접 익명화한다.';

COMMIT;

-- 적용 후 확인 (read-only)
-- select column_name from information_schema.columns where table_name = 'profiles' and column_name = 'deleted_at';
