# RLS Gap Batch A2 조사 (`contracts`, `notification_logs`)

> 이 문서는 **조사 산출물**입니다. 아래 SQL은 전부 초안(draft)이며, 이번 배치에서는
> **실행하지 않습니다.** Batch A1(`staff_salaries`/`leads`/`messages`)과 분리된 이유는
> [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) 상단 정정 섹션 및 SEC-009 참고 —
> 이 두 테이블은 fixture 생성/정리를 자동화할 방법이 현재 없어(아래 상세) 통합 테스트
> 커버리지 없이 Batch A1과 함께 적용하면 회귀 시 원인 분리가 어렵다는 지적에 따라 별도로
> 조사한다.

## 요약

| 항목 | contracts | notification_logs |
|---|---|---|
| 1. 앱/RPC/트리거 실사용 여부 | **없음**(app/lib 참조 0건, 관련 트리거 0건) | **없음**(동일) |
| 2. 정상 INSERT 주체 | 미정(기능 미구현 — 아래 참고) | 미정(서버 트리거 전용으로 설계됐으나 그 트리거 자체가 아직 없음) |
| 3. 정상 DELETE 필요 여부 | **불필요**(서명 후 불변 원칙, 의도적 설계) | **불필요**(append-only 감사로그, 의도적 설계) |
| 4. service_role GRANT 필요 여부 | **테스트 목적으로만 필요**(앱 기능엔 불필요) | 좌동 |
| 5. authenticated/anon GRANT 필요 여부 | **불필요 — 이미 있음**(Batch A1 진단에서 3개 테이블 모두 GRANT 정상 확인, contracts/notification_logs도 같은 프로젝트 기본 설정이라 동일할 가능성이 높으나 이 두 테이블은 직접 확인 못함, 아래 "미확인" 참고) | 좌동 |
| 6. GRANT 추가 시 노출면 확대 여부 | **아니오** — service_role 키는 브라우저/클라이언트에 절대 노출되지 않고 서버·테스트 도구 전용이므로, service_role GRANT는 실사용자 접근 경로에 영향 없음 | 좌동 |

## 상세

### 1~2. 실사용 여부 · 정상 INSERT 주체

`grep -rln "contracts\|notification_logs" app/ lib/` 결과 **0건** — SEC-007의 최초 확인과 동일하게
재확인됨. `schema.sql`/`*.sql` 전체에서 이 두 테이블을 참조하는 트리거·함수도 **0건**(즉
"서버 트리거 전용"이라는 설계 의도가 아직 코드로 존재하지 않음 — 설계만 있고 구현 전).

- `contracts`: 회원가입/수강권 등록 시 전자계약서를 발급하는 기능 자체가 아직 없다. 초안 정책은
  "권한 보유 스태프가 직접 INSERT"를 임시로 열어뒀지만, `docs/TODO.md`(P2-12)에 이미 기록된
  대로 서명·계약 발급은 원자적 처리가 필요해 실제 구현 시 RPC(security definer)로 전환하는 것이
  맞다고 판단된다. 지금 정책대로 두면 "권한 보유 스태프가 클라이언트에서 직접 계약서를 만들 수
  있음"이 되는데, 이는 계약 내용 조작 방지 관점에서 RPC보다 약한 보장이다.
- `notification_logs`: `messages`/알림 발송 시 비용을 기록하는 정산 로그로 설계됐지만, 실제
  발송 RPC/트리거 자체가 구현되지 않았다. 구현되면 그 RPC가 `SECURITY DEFINER`로 직접
  INSERT하면 되므로(클라이언트 INSERT 정책이 아예 필요 없음) 현재 "정책 없음" 설계가 맞다.

### 3. DELETE 필요 여부

둘 다 **불필요** — 의도적 설계다.
- `contracts`: 서명된 계약서는 법적 증빙이므로 클라이언트에서 직접 수정/삭제할 수 없어야 한다.
  상태 변경(취소 등)이 필요하면 RPC로 별도 구현해야 한다(이미 SQL 주석에 명시돼 있음).
- `notification_logs`: append-only 감사/정산 로그 — 삭제가 필요한 시나리오가 없다.

### 4~6. GRANT 필요성과 노출면

앱 코드가 이 두 테이블을 전혀 쓰지 않으므로(1번 확인), **service_role GRANT는 실제 사용자
접근 경로·보안과 무관**하다. service_role 키는:
- 브라우저에 내려가는 `NEXT_PUBLIC_SUPABASE_ANON_KEY`와 다른, 서버 전용 비밀키다(`lib/`
  어디에도 service_role 키를 쓰는 코드가 없다 — 이 프로젝트엔 별도 서버가 없어 클라이언트만
  존재하고, 통합 테스트(`tests/integration/setup.ts`)만 진단·fixture 목적으로 사용한다).
- 이미 이 세션에서 `account_center_permissions` 같은 다른 테이블은 service_role GRANT가
  있음을 확인했다 — 즉 이 프로젝트의 표준 설정은 "service_role에 GRANT ALL"이며, 이 17개
  RLS gap 테이블만 그 표준 설정이 누락된 것으로 보인다(테이블 생성 시 GRANT 문을 함께
  실행하지 않은 것으로 추정).

`GRANT ALL ON TABLE contracts, notification_logs TO service_role;`를 추가해도 anon/authenticated
권한에는 아무 영향이 없고(별도 GRANT 문), RLS 정책 자체도 그대로 유지되므로(GRANT는 RLS를
우회하지 않는 service_role 외 다른 role에는 의미가 없다) 실사용자 노출면은 전혀 늘지 않는다.

### 미확인 사항

- `contracts`/`notification_logs`의 anon/authenticated GRANT는 **직접 확인하지 않았다**
  (Batch A1의 3개 테이블만 읽기 전용으로 확인함 — 이 두 테이블은 지금 확인해도 fixture 없이는
  의미 있는 검증이 어려워 A1과 같은 방식(SELECT 시도)만으로 우선 확인 가능. 필요하면 다음
  배치에서 읽기 전용으로 추가 확인할 수 있다).
- 운영(production) Supabase의 실제 GRANT/RLS 상태는 이 세션에서 확인 불가(접근 권한 없음).

## 결론 및 권장

1. **service_role GRANT를 추가하는 것을 권장한다** — 앱 기능/보안에 영향이 전혀 없고, 이
   프로젝트의 다른 테이블들과 설정을 일치시키는 것뿐이며, 이게 있어야 `contracts`/
   `notification_logs`의 자동화된 통합 테스트(fixture 생성·정리)를 안전하게 작성할 수 있다.
2. **`contracts`의 INSERT 정책은 이번에 그대로 적용하지 않는 것을 권장한다** — 실제 계약 발급
   기능이 구현될 때 RPC 기반으로 설계하는 게 맞고(TODO P2-12), 지금은 아무도 이 정책을 쓰지
   않으므로 "정책을 지금 넣어야 할 긴급함"이 없다. Batch A2 SQL 초안에는 SELECT 정책만 포함하고
   INSERT는 RPC 설계가 나올 때까지 보류하는 것을 제안한다(아래 초안 참고, 최종 판단은 사용자
   확인 필요).
3. **`notification_logs`는 SELECT 정책만 있으면 충분하다** — INSERT/UPDATE/DELETE는 계속
   정책 없음(서버 트리거 전용)으로 유지.

## SQL 초안 (⚠️ DO NOT RUN — 조사 산출물, 이번 배치 승인 대상 아님)

```sql
-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- RLS Gap Batch A2 — contracts(SELECT만), notification_logs(SELECT만)
-- 대상: contracts, notification_logs
--
-- proposed_rls_gap_batch_a.sql의 원안과 달리 contracts의 INSERT 정책은 이 초안에
-- 포함하지 않았다 — 실제 계약 발급 기능이 RPC로 설계되기 전까지는 클라이언트 직접 INSERT를
-- 열어둘 필요가 없다는 판단(위 "결론 및 권장" 2번 참고, 최종 확정 아님 — 사용자 검토 필요).
--
-- 이 배치를 적용하려면 아래 GRANT도 함께(또는 먼저) 실행해야 통합 테스트 fixture를
-- 안전하게 만들고 지울 수 있다(앱 기능과는 무관 — 테스트 도구 전용, 위 "4~6" 참고).
-- ============================================================

grant all on table contracts to service_role;
grant all on table notification_logs to service_role;

alter table contracts enable row level security;

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
create policy "본인 또는 권한 보유 스태프 계약서 조회"
    on contracts for select
    using (
        profile_id in (select id from profiles where account_id = my_account_id())
        or has_permission(center_id, 'contract.list.view')
        or is_platform_admin()
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.
-- INSERT(계약 발급)는 실제 기능 구현 시 RPC(security definer)로 설계할 것.
-- 서명 완료된 계약서는 법적 증빙이므로 UPDATE/DELETE는 영구히 클라이언트에 열지 않는다.

alter table notification_logs enable row level security;

drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
create policy "권한 보유 스태프 알림발송기록 조회"
    on notification_logs for select
    using (
        has_permission(center_id, 'message.sms.view')
        or has_permission(center_id, 'message.push.view')
        or is_platform_admin()
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부 (서버 트리거 전용, 아직 미구현)
```

### Rollback 초안

```sql
-- ⚠️ DRAFT — DO NOT RUN unless the above was applied ⚠️
drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
drop policy if exists "권한 보유 스태프 계약서 생성" on contracts; -- 혹시 INSERT 정책도 함께 적용했다면
drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
drop policy if exists "권한 보유 스태프 알림발송기록 조회" on notification_logs;
-- GRANT는 되돌리지 않는다 — service_role GRANT 철회는 이 세션이 만든 진단/테스트 도구
-- 자체를 다시 못 쓰게 만들 뿐 보안 이득이 없다(service_role은 애초에 RLS를 우회하는 권한이라
-- GRANT 유무와 무관하게 이미 신뢰된 키다).
```

## 테스트 설계 (GRANT 승인 후 작성 예정, 지금은 미작성)

GRANT가 승인·적용되면 `tests/integration/setup.ts`의 `getFixtureAdminClient()`로 fixture를
만들고 정리하는 방식(Track A 최초 시도와 동일 패턴, 이번엔 GRANT가 있어 실제로 동작함)으로
아래를 검증한다:
1. `contracts`: 무권한 스태프 차단 / 본인(profile 소유자) 조회 허용 / `contract.list.view`
   보유자 조회 허용 / platform admin 조회 허용 / 타 센터 차단.
2. `notification_logs`: 무권한 스태프 차단 / `message.sms.view`·`message.push.view` 보유자
   조회 허용 / platform admin 조회 허용 / 타 센터 차단.
INSERT/UPDATE/DELETE는 정책이 없으므로(의도적) "항상 거부"만 확인하면 된다 — fixture는
admin client로 만들고 admin client로 지운다(일반 client 경로 테스트 불필요, 애초에 열려있지
않음).
