-- ============================================================
-- manager_centers 권한 모델 완결(SEC-101 + SEC-112 + SEC-113 + has_permission defense-in-depth)
--
-- 이 파일은 fix_manager_centers_privilege_escalation_draft_proposed.sql(이미 Live 적용됨,
-- SEC-101/112/113 RLS 정책 3종)을 **대체**한다 — RLS 정책 자체(INSERT ×2/UPDATE/DELETE)는
-- 내용 변경 없이 그대로 재선언(멱등, 이미 적용돼 있어도 다시 실행해 안전)하고, 이번에
-- **새로 추가하는 것은 has_permission() defense-in-depth 수정과 role_id/center_id 정합성
-- trigger 2가지뿐** — 이었으나, 아래 [긴급] 항목이 하나 더 추가됐다.
--
-- ============================================================
-- [🚨 긴급, 2026-08-13 CI 실행 중 발견 — 이미 Live에 있는 버그, 이 파일과 무관하게 지금
-- 운영 DB에서 스태프 초대 기능이 깨져 있을 수 있음]
-- ============================================================
--   fix_manager_centers_privilege_escalation_draft_proposed.sql(2026-08-12 Live 적용)이
--   "오너 스태프 초대"/"오너 스태프 수정" 정책에 추가한
--   `role_id in (select id from center_roles cr where cr.center_id = manager_centers.center_id)`
--   검사가 `center_roles`를 조회하는데, `center_roles`의 기존 SELECT 정책("내 센터 역할 조회",
--   reservation_functions.sql:574-575)이:
--     using (center_id in (select center_id from manager_centers where account_id = my_account_id()))
--   로 **`manager_centers`를 security definer 헬퍼 없이 직접(raw) 서브쿼리**한다. 그 결과
--   manager_centers에 INSERT/UPDATE(스태프 초대/역할 변경) 시: manager_centers 정책 평가
--   중 → center_roles 조회 → center_roles 정책 평가 중 → manager_centers 재조회 → **PostgreSQL이
--   "infinite recursion detected in policy for relation manager_centers"로 즉시 차단**한다.
--   CI 통합 테스트에서 실제로 "스태프 추가에 실패했어요: infinite recursion detected in policy
--   for relation manager_centers" 에러로 실증 확인됨(2026-08-13, run 31572982400).
--
--   같은 파일의 "오너 스태프 조회"(manager_centers SELECT) 정책은 이미 올바른 패턴
--   (`center_id in (select my_managed_center_ids())` — my_managed_center_ids()는 security
--   definer라 내부 쿼리가 RLS를 다시 타지 않음, reservation_functions.sql 자체 주석에 이
--   이유가 명시돼 있음)을 쓰고 있다 — `center_roles`의 "내 센터 역할 조회"만 이 패턴을
--   따르지 않아 이번에 새로 추가된 cross-center role_id 검사(SEC-112 방어)와 결합하면서
--   처음으로 순환이 드러났다(이 검사 자체는 fix_manager_centers_privilege_escalation_draft_
--   proposed.sql에 이미 있었으므로, **이 순환은 그 파일이 Live 적용된 2026-08-12부터 이미
--   존재했을 가능성이 높다** — 이 파일의 신규 trigger도 같은 이유로 동일 순환에 걸리므로
--   이 파일만으로는 못 고치고 아래 [7]에서 근본적으로 고친다).
--
--   [수정] "내 센터 역할 조회"를 `my_managed_center_ids()` 기반으로 교체 — "오너 스태프
--   조회"와 동일한, 이미 검증된 패턴. 유일한 의미 차이: 기존은 `status` 무관(pending 포함)
--   이었는데 `my_managed_center_ids()`는 `status='active'`만 포함 — 이 저장소의 부트스트랩/
--   초대 흐름이 항상 즉시 `status='active'`로 insert하므로(lib/centers.ts, lib/roles.ts
--   확인) 실사용 영향 없음, 오히려 다른 모든 곳과 일관성이 맞춰짐.
--
-- ============================================================
-- [보안 invariant — 이 파일이 보장해야 하는 것]
-- ============================================================
--   A. 기존 center의 최초 manager 관계를 일반 사용자가 임의로 만들 수 없다.
--   B. 정상 신규 center 생성자만 최초 owner bootstrap 가능하다.
--   C. 새 staff 추가는 facility.staff.create 권한을 가진 caller만 가능하다.
--   D. staff role 변경은 facility.staff.update 권한을 가진 caller만 가능하다.
--   E. 일반 staff는 자신의 role/status를 권한 상승 방향으로 변경할 수 없다.
--   F. manager_centers.role_id는 반드시 manager_centers.center_id와 동일한
--      center_roles.center_id 소속이어야 한다(RLS + trigger 이중 방어).
--   G. 마지막 owner/관리 관계를 삭제해 center를 orphan 상태로 만드는 행위는 DB 레벨에서
--      차단된다.
--   H. 한 account가 여러 center에서 서로 다른 role(회원/오너/스태프/매니저)을 갖는 것은
--      정상이며 이 파일의 어떤 정책도 이를 제한하지 않는다.
--
-- ============================================================
-- [PART 1 — SEC-113 확정 조사 결과]
-- ============================================================
--   1) "오너 스태프 삭제" 정책의 원본(add_staff_permissions.sql) 정의:
--        using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
--      → self 분기에 "마지막 행인가" 제약이 전혀 없었다(CONFIRMED, 코드 확인).
--   2) self-delete 분기는 오너/일반 staff 구분 없이 "자기 행"이면 전부 허용 — is_owner
--      여부를 별도로 확인하지 않는다. 즉 오너든 저권한 스태프든 자기 자신을 지우는 것
--      자체는 원래 정상 기능(스태프 탈퇴)이라 이 자체를 막으면 안 된다 — "마지막 남은
--      한 명인가"만 막아야 한다(요구사항 G).
--   3) "센터당 owner 최소 1명" 같은 명시적 규칙은 스키마/코드 어디에도 없었다(NEEDS
--      PRODUCT DECISION으로 남아있던 것 — 이번 트리거로 사실상 "최소 1명(누구든)"
--      규칙로 대체함 — is_owner 여부와 무관하게 "이 센터에 manager_centers 행이 최소
--      1개"만 강제한다. "owner가 반드시 있어야 한다"는 더 강한 규칙은 이번 배치
--      범위 밖(PART 3 "장기 권장" 참고).
--   4) UI가 막아도 REST/PostgREST로 직접 DELETE하면 RLS만이 유일한 방어선이다(코드
--      레벨 검증 없음, RLS 우회 불가 — Supabase는 항상 PostgREST 경유이므로 RLS가
--      실질적 유일 게이트) — 이미 기존 파일에서 이 방어를 추가했음.
--   5) centers 행은 남아있는데 manager_centers가 0건인 상태(= orphan)는 스키마상
--      아무 제약 없이 가능했다(FK 등으로 자동 방지되지 않음, CONFIRMED) — DELETE
--      정책 수정 없이는 이 상태에 도달 가능했다.
--   6) Live에 이미 orphan center가 존재하는지는 이 세션에서 직접 조회할 수 없다
--      (service_role/Supabase CLI 없음) — PART 7의 READ-ONLY 진단 SQL을 사용자가
--      직접 실행해 확인할 것.
--
-- ============================================================
-- [PART 3 — 설계안 비교(A/B/C/D), 최종 A안 채택]
-- ============================================================
--   A) [채택, 최소 수정] 기존 RLS patch(0건일 때만 self-insert) + last-owner DELETE
--      guard(그 center_id에 자기 행 말고 다른 행이 없으면 삭제 거부, self/권한삭제
--      공통) — SQL만으로 완결, 코드 변경 없음, 이미 Live 적용 완료.
--      + 장점: 코드 변경 0, 즉시 적용 가능, race condition 외에는 완전.
--      + 단점: "0건=신규"라는 판정 기준이 여전히 간접적(진짜 신규인지 orphan인지
--        DB가 직접 구분하지 못함 — 다만 G 트리거로 orphan 자체가 봉쇄되므로 실질
--        위험은 없음).
--   B) center.created_by_account_id 같은 명시적 provenance 필드로 "신규 센터"를
--      직접 판정. **현재 schema.sql에 이런 필드가 없음(확인함)** — 새 컬럼 추가(스키마
--      변경, migration 필요) + lib/centers.ts가 그 값을 채우도록 코드 변경 필요.
--      + 장점: "신규"와 "orphan"을 구조적으로 명확히 구분(가장 명시적).
--      + 단점: 스키마 변경 + 코드 변경 필요, 이번 SQL-only 범위를 넘어섬, 기존
--        센터들은 이 필드가 소급 채워지지 않아(누가 최초 생성자였는지 이력 없음)
--        마이그레이션 자체가 불완전할 수 있음.
--   C) 센터 생성 + owner bootstrap을 SECURITY DEFINER atomic RPC로 통합하고 self
--      INSERT/UPDATE 정책 자체를 제거.
--      + 장점: 가장 근본적 — "센터 생성"과 "오너 지정"이 원자적 트랜잭션이 되어 중간
--        실패로 반쪽 상태가 생기는 것도 함께 막음(P0-2 계열 문제까지 해결). self
--        분기가 아예 없어지므로 SEC-112류 문제의 재발 가능성 자체가 구조적으로 사라짐.
--      + 단점: lib/centers.ts(registerCenterForAccount) 코드 변경 필수(RPC 호출로
--        교체), 회귀 테스트 범위가 커짐, 이번 SQL-only STOP 범위를 넘어섬.
--   D) trigger 기반 owner bootstrap(INSERT INTO centers 시 트리거가 자동으로
--      manager_centers 오너 행까지 생성).
--      + 장점: 코드 변경 없이 원자성 확보 가능(C안의 코드변경 단점 회피).
--      + 단점: "누구를 오너로 할지"(트리거 컨텍스트의 auth.uid())를 트리거 안에서
--        결정해야 해서 SECURITY DEFINER 트리거가 필요 + client가 origin center insert
--        시점의 세션 컨텍스트에 의존 — C안(명시적 RPC)보다 암묵적이라 유지보수성이
--        낮음. self-UPDATE 부트스트랩 전환 로직 자체는 계속 필요할 수도 있어(오너
--        role_id를 나중에 바꾸는 시나리오) 완전한 대체가 안 될 수 있음.
--
--   → **지금 최소 수정(즉시 출시)**: A(이미 적용됨) + 이 파일의 has_permission
--     defense-in-depth + role_id/center_id trigger.
--   → **장기 권장**: C(atomic RPC) — "센터 생성=오너 확정" 원자성까지 확보하고 self
--     RLS 분기 자체를 제거하는 것이 가장 근본적. 별도 코드 변경 배치로 분리 권장
--     (docs/TODO.md에 후속 항목으로 기록).
--
-- ============================================================
-- [PART 4 — role_id/center_id invariant 강제 방법 비교]
-- ============================================================
--   RLS만으로는 불충분하다 — RLS는 "그 client role(anon/authenticated)이 이 쓰기를
--   할 수 있는가"만 governs한다. service_role이나 향후 추가될 SECURITY DEFINER RPC가
--   manager_centers에 직접 INSERT/UPDATE한다면 RLS를 완전히 우회한다(RLS는 특정
--   role에 대해서만 활성화되고, service_role은 기본적으로 RLS를 우회하는 것이 Supabase
--   표준 동작). 코드 감사 결과 **현재는 manager_centers에 직접 쓰는 RPC/트리거가
--   RLS 정책 외에 없음(cleanup 스크립트 3개는 테스트 정리 전용, 실사용 무관)** —
--   즉 지금 당장 이 gap이 뚫려 있는 건 아니지만, "미래에 실수로 만들어질 RPC 버그"에
--   대한 방어선이 전무한 상태였다.
--
--   CHECK 제약은 PostgreSQL에서 다른 테이블을 참조하는 서브쿼리를 지원하지 않아
--   (center_roles를 조인해야 하는 이 invariant는 표현 불가) 후보에서 제외.
--
--   → **BEFORE INSERT OR UPDATE 트리거 채택**: RLS 정책의 WITH CHECK와 별개로,
--   테이블 레벨에서 role_id/center_id 정합성을 강제한다. 트리거는 role/RLS와 무관하게
--   "그 행에 대한 모든 쓰기"에 항상 적용되므로(service_role 포함, `session_replication_
--   role=replica`로 명시적으로 끄지 않는 한 우회 불가 — 이건 슈퍼유저만 가능하고 이
--   저장소 어디에도 그런 코드 없음), RLS가 실수로 느슨해지거나 새 RPC가 이 테이블에
--   직접 쓰기를 시도해도 이 invariant만은 항상 보장된다. 기존 데이터(전부 RLS를 통해
--   생성됐으므로 이미 이 invariant를 만족 — PART 7에서 실측 확인 권장)에는 영향 없음.
--
-- ============================================================
-- [PART 5 — has_permission() cross-center 검증 감사 결과]
-- ============================================================
--   현재 정의(reservation_functions.sql):
--     with me as (
--         select mc.id as mc_id, r.is_owner, mc.role_id
--         from manager_centers mc
--         join center_roles r on r.id = mc.role_id      -- ← center_id 정합성 미확인!
--         where mc.account_id = my_account_id()
--           and mc.center_id = p_center_id
--           and mc.status = 'active'
--         limit 1
--     )
--   `mc.center_id = p_center_id`로 그 센터의 내 행만 골라내는 것까지는 맞지만,
--   `join center_roles r on r.id = mc.role_id`가 **`r.center_id = mc.center_id`를
--   확인하지 않는다** — CONFIRMED. 만약 `mc.role_id`가 (버그·데이터 오염·RLS 우회
--   등 어떤 경로로든) 다른 센터의 owner role을 가리키고 있다면, `r.is_owner`가
--   그대로 true로 읽혀 그 회원이 이 센터의 오너로 인식된다. 이번 배치의 RLS/trigger
--   수정으로 **새로운 이런 행이 생기는 것 자체는 이제 불가능**하지만, has_permission()
--   자체는 여전히 이 가정에 의존한 채로 남아있어 단일 실패점(single point of
--   failure)이다.
--
--   → **defense-in-depth로 `r.center_id = mc.center_id`를 join 조건에 추가한다.**
--   이 조건은 이제 RLS/trigger로 보장되는 모든 정상 데이터에 대해 항상 참이므로
--   **기존 정상 기능에 영향이 전혀 없다**(정상 데이터는 조건 추가 전후로 결과 동일).
--   방어 효과: 향후 어떤 경로로든(다른 버그, 수동 DB 조작, 마이그레이션 실수 등)
--   mismatch 행이 다시 생기더라도 has_permission()이 그 행을 신뢰하지 않으므로
--   "쓰기 단계 방어(trigger) + 읽기/판정 단계 방어(has_permission)" 이중 방어가
--   완성된다.
--
-- [영향받는 기존 데이터] 없음(함수/트리거 정의 + 정책 재선언만, 테이블 데이터 변경 없음).
-- [위험도] 매우 낮음 — 전부 기존 정상 데이터에 대해 no-op인 defense-in-depth 추가.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] INSERT "매니저센터 생성" — SEC-101 (기존과 동일, 재선언)
-- ------------------------------------------------------------
drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
        )
    );

-- ------------------------------------------------------------
-- [2] INSERT "오너 스태프 초대" — SEC-112(a) (기존과 동일, 재선언)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
    );

-- ------------------------------------------------------------
-- [3] UPDATE "오너 스태프 수정" — SEC-112(b) (기존과 동일, 재선언)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (account_id = my_account_id() and role_id is null)
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
        and (
            (
                account_id = my_account_id()
                and status = 'active'
                and role_id in (
                    select id from center_roles cr
                    where cr.center_id = manager_centers.center_id and cr.is_owner = true
                )
            )
            or has_permission(center_id, 'facility.staff.update')
        )
    );

-- ------------------------------------------------------------
-- [4] DELETE "오너 스태프 삭제" — SEC-113 (기존과 동일, 재선언)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
              and mc2.id <> manager_centers.id
        )
    );

-- ------------------------------------------------------------
-- [5] 신규 — role_id/center_id 정합성 trigger (PART 4)
--     RLS와 독립적인 테이블 레벨 방어선. service_role/미래 RPC의 직접 쓰기까지 방어.
-- ------------------------------------------------------------
create or replace function manager_centers_enforce_role_center_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.role_id is not null and not exists (
        select 1 from center_roles cr
        where cr.id = new.role_id and cr.center_id = new.center_id
    ) then
        raise exception 'manager_centers.role_id는 반드시 같은 center_id의 center_roles여야 해요 (center_id=%, role_id=%)',
            new.center_id, new.role_id;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_manager_centers_role_center_match on manager_centers;
create trigger trg_manager_centers_role_center_match
    before insert or update on manager_centers
    for each row
    execute function manager_centers_enforce_role_center_match();

-- ------------------------------------------------------------
-- [6] 신규 — has_permission() defense-in-depth (PART 5)
--     함수 시그니처/반환값/정상 케이스 동작 전부 동일 — join 조건 하나만 추가.
-- ------------------------------------------------------------
create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
as $$
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
$$;

-- ------------------------------------------------------------
-- [7] 🚨 긴급 수정 — center_roles "내 센터 역할 조회" RLS 무한 재귀 버그
--     (파일 상단 [긴급] 섹션 참고). manager_centers에 대한 INSERT/UPDATE([2],[3])와
--     이번 파일의 신규 trigger([5])가 모두 center_roles를 조회하므로, 이 정책이
--     raw하게 manager_centers를 되짚는 한 반드시 순환한다 — my_managed_center_ids()
--     (security definer)로 교체해 순환을 끊는다. "오너 스태프 조회" 정책이 이미 쓰는
--     것과 동일한, 검증된 패턴.
--     의미 차이: status 필터가 암묵적으로 'active'만 남음(부트스트랩/초대 흐름이 항상
--     즉시 active로 insert하므로 실사용 영향 없음, 확인함).
-- ------------------------------------------------------------
drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select my_managed_center_ids()));

COMMIT;

-- ============================================================
-- 완료.
--   - manager_centers INSERT/UPDATE/DELETE 정책 3종: 기존과 동일(변경 없음, 재선언만).
--   - 신규 trigger: role_id/center_id mismatch를 어떤 쓰기 경로로도(RLS 우회 포함)
--     차단.
--   - 신규 has_permission(): center_roles 조인에 center_id 일치 조건 추가 — 혹시
--     mismatch 행이 존재해도(과거 데이터 등) 권한 판정에서 무효화.
--   - 🚨 center_roles "내 센터 역할 조회" 정책: raw manager_centers 서브쿼리를
--     my_managed_center_ids()로 교체해 RLS 무한 재귀 버그 해소(스태프 초대 기능
--     복구). 이 버그는 이 파일과 무관하게 이미 Live에 존재하므로 이 파일을 적용하지
--     않더라도(또는 [1]~[6]만 적용하고 [7]을 빠뜨리면) 스태프 초대는 계속 깨진 채로
--     남는다 — 반드시 [7]까지 함께 적용할 것.
-- ============================================================
