# 병합 순서 · stacked branch 연결 · branch protection 권고 (2026-10-07)

## 1. branch 충돌 매트릭스 (`git merge-tree`로 실제 3-way 병합 시뮬레이션, 워킹트리 변경 없음)
브랜치(origin/main `0be4808` 대비): `#170`(15 files), `boot`(bootstrap, #170 포함 +16), `docs`(9), `ctr`(manager-center, 31), `#167`(1), `maint`(67), `mgr`(4), `safe`(8).

파일이 겹치지만 **실제 충돌이 없는 쌍**: `ctr×maint`(26개 파일 겹침, 줄이 달라 자동 병합), `maint×mgr`, `#170×boot`(boot가 #170을 포함).
**실제 충돌 4건**:
| 쌍 | 충돌 파일 | 위험 | 해결 |
|---|---|---|---|
| ctr × mgr | `app/manager/settings/page.tsx` | MEDIUM | 나중에 병합되는 쪽이 `git merge origin/main` 후 수동 해결(mgr의 unsaved-changes 가드 + ctr의 pickInitialCenterId 둘 다 유지) |
| maint × safe | `app/mypage/page.tsx` | MEDIUM | 같은 방식(KST 날짜 수정과 maint 변경 병합) |
| docs × ctr | `docs/CHANGELOG.md` | LOW | 둘 다 항목 유지 |
| boot × docs | `docs/TODO.md` | LOW | 둘 다 항목 유지 |
나머지 쌍은 충돌 없음. 고위험(HIGH)은 없음.

## 2. 병합 순서 (권장)
1. **#170** — CI(Production guard + preflight). 단, **dev Secrets 교체 후 CI가 초록이 된 다음** 병합(그 전엔 live 잡이 의도대로 막혀 있음).
2. **bootstrap** — #170 병합 후 `git merge origin/main`(§3). 고유 변경은 scripts/ci-dev, docs, 테스트.
3. **maint**(67 files, 가장 큼) → 4. **safe**(mypage 충돌 해결) → 5. **mgr**(충돌 없음) → 6. **ctr**(settings 충돌 해결) → 7. **#167**(1 file) → 8. **docs**(TODO/CHANGELOG 충돌 해결, 최종 상태 반영).
원칙: 먼저 병합된 쪽은 그대로, 뒤에 병합되는 브랜치가 `git fetch && git merge origin/main`으로 최신 main을 포함하고 충돌을 해결한 뒤 PR/병합. rebase/force-push 금지.

## 3. stacked bootstrap 연결 절차 (#170 병합 후)
bootstrap은 #170 브랜치 위에 쌓여 있다(#170 HEAD를 이미 포함).
1. `git fetch origin && git checkout chore/ci-dev-supabase-bootstrap-20261007 && git merge origin/main` — #170이 squash/merge 어느 방식으로 들어가도 같은 내용이라 충돌 없음(새 커밋이 #170에 더 생기면 먼저 그것을 bootstrap에 merge).
2. 검증: `git diff --name-only origin/main...HEAD` 가 bootstrap 고유 파일만 보이는지(현재 기준 16개: `.gitignore`, `docs/CI_DEV_*`, `docs/STATIC_AUDIT_20261007.md`, `docs/TODO.md`, `package.json`, `scripts/ci-dev/*`, `tests/integration/sync-test-payment-center-member.test.ts`, `tests/unit/ciDev*.test.ts`).
3. `npm test`, placeholder env build 후 push, PR 생성(base=main).

## 4. branch protection 권고 (이번에는 설정하지 않음 — GitHub UI에서 사용자가)
현재 main에는 보호 규칙/ruleset이 없다.
**함정**: GitHub은 조건(`if`)이나 `needs` 실패로 **skipped된 job을 required check에서 "통과"로 취급**한다. E2E만 required로 걸고 `live-env-preflight`를 빼면, preflight가 실패해 E2E가 skipped여도 병합이 허용된다. 따라서 live 잡을 required로 쓸 때는 **preflight를 반드시 함께** required로 지정한다.

| check | 권장 | 이유 |
|---|---|---|
| Unit tests | **required** | 외부 의존 없음, 빠름 |
| Build | **required** | 타입체크 포함, placeholder env |
| live-env-preflight | dev 프로젝트가 안정화된 뒤 **required** | 비밀 교체 오류(Production 가리킴)를 병합 전에 잡음. **지금 켜면 #170 자신이 막힌다** |
| E2E 1~4 | 초기에는 **required 아님**(안정화 2주 후 1번만 required 검토) | 외부 dev Supabase 장애/플레이크로 긴급 hotfix가 막히는 것을 피함. 결과는 병합 전 소유자가 확인 |
| Integration | 초기에는 **required 아님** | 위와 동일 + 공유 DB 직렬화로 오래 걸림 |
**긴급 hotfix 경로**: required는 Unit+Build만 → live CI가 죽어도 hotfix 병합 가능. 필요하면 관리자 우회(bypass)를 소유자에게만 허용.

**GitHub UI 한 단계 가이드**: Settings → Rules → Rulesets → New branch ruleset → Target: `main` → "Require a pull request before merging" 체크 + "Require status checks to pass" 체크 → "Add checks"에서 `Unit tests …`와 `Build …`(job 이름은 워크플로의 name 그대로) 선택 → "Block force pushes" 체크 → Create. (dev 프로젝트 준비 전에는 live 관련 check를 추가하지 않는다.)
