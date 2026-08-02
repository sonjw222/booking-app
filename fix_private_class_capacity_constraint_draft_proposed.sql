-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- CLASS-001 (Track D-2): 프라이빗 수업 정원을 서버(DB)에서 강제
--
-- 배경: classes.class_format='private'는 schema.sql 주석부터 "프라이빗 1:1"로 명시돼
-- 있었지만, 지금까지 이 값을 선택할 수 있는 UI 자체가 없어(감사 결과, D-2 참고) 정원 제약이
-- 실제로 강제된 적이 없다. 이번 배치에서 관리자 UI에 그룹/프라이빗 선택을 추가하면서, UI가
-- capacity=1을 자동 설정/잠그긴 하지만 이것만으로는 "UI 표시만으로 제한하지 않는다"는
-- 요구사항을 満족하지 못한다(Supabase API를 직접 호출하면 capacity=5인 프라이빗 수업도
-- 만들 수 있음). CHECK 제약으로 DB 레벨에서 강제한다.
--
-- 예약 시 정원 초과 차단(reserve_class의 `v_confirmed < v_class.capacity`)은 이미 class_format과
-- 무관하게 동작하는 기존 로직이라 별도 수정이 필요 없다 — capacity가 항상 1로 강제되기만
-- 하면 자연히 "프라이빗은 1명만" 정책이 지켜진다.
--
-- 기존 데이터 영향: class_format='private'인 기존 행이 있다면(감사 결과 지금까지 UI로 만든
-- 적이 없어 0건으로 확인됨 — `select count(*) from classes where class_format='private'`로
-- 실행 전 재확인 권장) capacity가 1이 아니면 이 제약 추가 자체가 실패한다. 0건이 맞다면
-- 안전하게 적용된다.
-- ============================================================

BEGIN;

alter table classes
    add constraint classes_private_capacity_check
    check (class_format <> 'private' or capacity = 1);

COMMIT;
