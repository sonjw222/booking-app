# P0-4 RLS 전수 스냅샷 (2026-08-14)

`docs/TODO.md` P0-4("RLS 회귀 테스트와 운영 정책 확인")의 완료 조건 중 "현재 `pg_policies`
결과를 기록함" 부분을 다룬다. `supabase db query --linked`(Supabase Management API 경유,
DB 비밀번호 불필요 — CLI 로그인 토큰만 사용)로 라이브 `public` 스키마 전체를 조회했다.

> 이 문서는 스냅샷 시점(2026-08-14)의 read-only 조회 결과다. 이후 새 테이블/정책이 추가되면
> 갱신이 필요하다.

## 1. RLS 활성화 여부 (전체 65개 테이블)

**65개 전부 RLS 활성화됨. 비활성화 테이블 0개.**

## 2. RLS는 켜져 있지만 정책이 0개인 테이블 (15개)

Postgres에서 RLS가 켜져 있고 매칭되는 정책이 없으면 결과는 "전체 공개"가 아니라 정반대인
"완전 차단"이다(service_role은 RLS를 우회하므로 예외). 아래 15개가 여기 해당한다:

`change_logs`, `chat_messages`, `class_types`, `community_comments`, `competitions`,
`contract_templates`, `contracts`, `locker_assignments`, `lockers`, `membership_transfers`,
`notification_logs`, `popup_notices`, `schedule_memos`, `staff_schedules`, `terms`

**app/lib 코드 전체에서 이 15개 테이블 이름을 참조하는 곳이 0건** (`grep -rl` 확인) — 즉
지금 이 15개가 완전 차단 상태인 것 때문에 깨지는 실사용 기능은 없다. `docs/TODO.md` P3
섹션(`change_logs`=P3-8, `chat_messages`=P3-9 등)이 이미 이들 중 일부를 "용도·존속 여부
불명확"으로 다루고 있는 것과 일치한다. `contracts`/`notification_logs`는
`docs/21_RLS_Gap_Analysis.md`에서도 이미 "완전 차단 상태, 실사용 기능 없음"으로 확인된
적이 있다(SEC-009 조사) — 이번 스냅샷도 같은 결론을 재확인했다.

**결론**: 이 15개는 P0(출시 블로커)가 아니다. 실제로 쓰기 시작할 때(예: `lockers`/
`contracts` 기능을 실제로 켤 때) 그 시점에 정책을 채우면 된다.

## 3. 정책 상세 — 위험 신호 점검 (실사용 50개 테이블, 총 152개 정책)

- **모든 정책이 `roles = {public}`** (기본값 — `TO` 절 생략). 실제 접근 제한은 `TO` 절이
  아니라 각 정책의 `USING`/`WITH CHECK` 표현식 안의 `auth.uid()`/`my_account_id()` 등으로
  이뤄진다(이 프로젝트 전역의 일관된 패턴, `schema.sql` RLS 섹션과 동일).
- **`USING (true)`(무조건 허용) 정책은 정확히 4개, 전부 SELECT 전용**:
  - `center_reviews` "센터후기 공개 조회"
  - `home_banners` "배너 공개 조회"
  - `rooms` "룸 공개 조회"
  - `service_categories` "종목 공개 조회"

  넷 다 로그인 전 홈 화면/센터 상세에서 공개적으로 보여야 하는 마케팅성 콘텐츠라 의도된
  설계다. **INSERT/UPDATE/DELETE에 `true`(무조건 허용)인 정책은 0건** — 위험한 전면 쓰기
  허용 정책은 발견되지 않았다.

## 4. 역할별 read/write 테스트 (업데이트: 완료)

이번 스냅샷 자체는 "정책이 존재하는가/과도하게 열려 있지 않은가"까지만 확인했지만, P0-4의
완료 조건이 요구하는 **"비로그인·회원·스태프·매니저·오너·플랫폼 운영자별 핵심 테이블
read/write 테스트"**는 `tests/integration/`의 기존 통합 테스트 스위트(27개 파일, 161개
테스트)를 실제로 전부 재실행해 충족했다 — `acl-003-permission-read.test.ts`,
`admin-assignment-security.test.ts` 등 다수가 정확히 이 역할 경계를 검증하도록 이미
설계돼 있었다. 2026-08-14 재실행 결과 140 통과/5 실패/16 스킵 — 실패 5건은 전부 조사 결과
P0-4(이 앱의 RLS/권한 자체) 범위 밖으로 확인됨(테스트 스위트 자체가 의도적으로 fail하도록
만들어둔 미적용 SQL 1건, 다른 세션이 진행 중인 별도 보안 배치 전용 테스트 파일 2개 — 자세한
내용은 `docs/TODO.md` P0-4 참고). 완전히 처음부터 새 테스트를 만들 필요는 없었다.

## 5. 조회에 사용한 쿼리 (재현용)

```sql
-- RLS 활성화 + 정책 개수
select
    t.tablename,
    t.rowsecurity as rls_enabled,
    count(p.policyname) as policy_count,
    coalesce(array_agg(p.policyname order by p.cmd, p.policyname) filter (where p.policyname is not null), '{}') as policies
from pg_tables t
left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
where t.schemaname = 'public'
group by t.tablename, t.rowsecurity
order by t.tablename;

-- 정책 상세(USING/WITH CHECK 표현식 포함)
select schemaname, tablename, policyname, cmd, roles, qual as using_expr, with_check as with_check_expr
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;
```
