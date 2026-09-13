-- ============================================================
-- 마케팅 정보 수신 동의 실제 저장 (Privacy 배치 #1)
--
-- 배경: app/login/page.tsx의 회원가입 폼에 마케팅 동의 체크박스(agreeMarketing)가
-- 있었지만 그 값을 읽어서 저장하는 코드가 어디에도 없었다(grep으로 확인 — 필수 동의인
-- agreeTerms/agreePrivacy조차 클라이언트 측 제출 게이트로만 쓰이고 DB에 남지 않았음).
-- 즉 어떤 사용자가 언제 마케팅 수신에 동의했는지(또는 철회했는지) 증빙할 방법이 전혀
-- 없었다. 이번엔 선택 동의인 마케팅만 실제로 저장한다(필수 약관 자체의 버전관리/증빙은
-- 범위 밖 — 별도 논의 필요).
--
-- marketing_consent_at은 "동의한 시각"이 아니라 "마지막으로 값이 바뀐 시각"이다 —
-- 동의(true)와 철회(false) 둘 다 이 한 컬럼으로 기록되므로, 나중에 "언제 동의했는지"뿐
-- 아니라 "언제 철회했는지"도 증빙할 수 있다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table accounts add column if not exists marketing_consent boolean not null default false;
alter table accounts add column if not exists marketing_consent_at timestamptz;

comment on column accounts.marketing_consent is '마케팅 정보 수신 동의(선택). true/false 어느 쪽이든 marketing_consent_at이 그 값으로 바뀐 시각.';
comment on column accounts.marketing_consent_at is 'marketing_consent가 마지막으로 바뀐 시각(동의/철회 공통 — 최초 기본값 false는 시각 없음).';

-- RLS: 기존 "본인 계정 수정" 정책(auth_id = auth.uid())이 컬럼 단위 제한 없이 이미
-- UPDATE를 허용하므로 이 두 컬럼도 자동으로 본인만 수정 가능 — add_pg_checkout_reviewer_override.sql이
-- 남긴 것과 동일한 분석. 그 파일과 달리 이 값은 "운영자만 바꿔야 하는 값"이 아니라 정반대로
-- "본인이 자유롭게 바꿀 수 있어야 하는 값"이라 트리거로 막을 필요가 없다 — 새 정책/트리거
-- 불필요.

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'accounts' and column_name in ('marketing_consent', 'marketing_consent_at');
