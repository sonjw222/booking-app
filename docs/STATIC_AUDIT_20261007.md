# 정적 감사 (2026-10-07) — fixture 격리 / 오류·날짜·접근성 / 죽은 코드·플래그

코드 변경 없이 `origin/main`(0be4808)을 grep으로 점검한 결과. 다른 브랜치(maintenance-refresh, safe-followups d6c098e의 KST 클라이언트 날짜 수정, manager-workflow-refresh)와 겹치지 않도록 수정은 하지 않고 목록만 남긴다. 숫자는 grep 기준 추정치이며 오탐 가능.

## 9. fixture 격리 (tests/integration, tests/e2e)
- 통합 테스트 48개 중 `afterAll/afterEach` 정리가 있는 파일 54건 매칭(파일 수 기준 거의 전부). **정리 훅이 없는 파일: `sync-test-payment-center-member.test.ts`** → 실패 시 잔여 row 가능성(우선 확인 대상).
- 고유 이름은 `Date.now()` 113회, `Math.random()` 19회, `randomUUID()` 12회 사용. `Math.random()`/`Date.now()` 접미사는 충돌 가능성이 낮지만 같은 ms 병렬 생성에선 중복 가능(CI는 workers 1이라 실제 위험 낮음).
- 공유 센터(`TEST_CENTER_ID`)를 여러 파일이 쓰므로 leftover holiday/role/중복 센터가 다른 파일의 원인불명 실패를 만든다(메모리 `shared_fixture_pollution` 패턴). 새 dev 프로젝트에서도 파일 간 정리 보장이 핵심.
- 권고(후속): 정리 훅 없는 파일 보강, 공유 센터 대신 파일별 임시 센터 사용 검토(대규모 리라이트라 이번 범위 밖).

## 11. 원문 `.message` / UTC 날짜 / 타임존
- UI에 `e.message`를 그대로 노출하는 호출 약 223곳(`setError/setMsg/toast/alert(e.message)`). 최다: `manager/classes` 21, `manager/members` 18, `staff`/`sales`/`membership-rules` 각 10. DB/RLS 원문이 사용자에게 보일 수 있음 → 공통 `friendlyError()` 래퍼 도입 후 점진 치환 권장(대규모 변경이라 별도 승인).
- `toISOString().slice(0,10)`(UTC 날짜) 23곳: `lib/reservations.ts:401,561`, `lib/classes.ts:479,968,969,1005,1044`, `app/mypage/page.tsx:38`, `app/manager/members/page.tsx:435`(CSV 파일명), `app/api/billing/{confirm,charge-due}/route.ts`. KST 새벽(00~09시)에 "어제"로 계산되는 위험. 클라이언트 쪽은 safe-followups 브랜치(d6c098e)가 일부 처리 중 — 병합 후 남은 곳만 `todayKstYmd()`(lib/membershipExpiry.ts)로 치환. 서버 라우트(billing)는 서버가 UTC라 별도 판단 필요(과금일 기준 정의 확인).

## 12. 접근성 (소규모)
- `<img>` alt 누락 0, 아이콘 전용 `×` 버튼 aria-label 누락 0(정규식 기준).
- `<div onClick>`에 `role` 없음 67곳 → 키보드/스크린리더 접근 불가. 대부분 오버레이 닫기(backdrop)일 가능성이 높아 우선순위 낮음; 실제 조작 요소는 `<button>`으로 전환 권장.

## 13. 죽은 코드 / 플래그
- `lib/*.ts` 중 어디서도 import되지 않는 모듈: 없음(파일명 기준 grep).
- `NEXT_PUBLIC_*` 플래그 16종 사용 중. 결제 관련(`PG_CHECKOUT_ENABLED`, `BILLING_ENABLED`, `PAYMENT_PROVIDER`, `PAYMENT_SCENARIO`, `PAYOUTS_ENABLED`, `PORTONE_STORE_ID`)은 의도적 OFF/mock 상태이며 PG ON 전까지 유지. `NEXT_PUBLIC_PORTONE_STORE_ID`(1회 사용)는 Toss 전환 후 잔재일 수 있어 확인 필요(삭제 안 함).
