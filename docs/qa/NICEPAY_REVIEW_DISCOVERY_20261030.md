# NICEPAY 심사관 센터 미노출 / 홈 20km 기본 필터 수정 (2026-10-30)

## 범위
- 홈 첫 진입 시 GPS를 자동 요청하거나 20km로 센터를 제외하지 않음. `fetchHomeCenters()`는 좌표 없이 호출.
- 검색 화면의 `내 주변 20km` 조건은 기본 OFF, 버튼 눌렀을 때 ON, 다시 누르면 OFF. 기존 `app/search/page.tsx` 제어 로직 재사용.
- `nicepay_review_access=true`인 심사관에게만 홈의 '심사 전용 센터' 바로가기 표시. 센터 ID는 조회 결과를 사용하며, RLS는 그대로 유지.
- 결제 게이트 / 결제 코드 / 다른 센터·상품 데이터 / Production SQL / 로그인 코드를 변경하지 않음.

## Production에서 확인된 독립 원인 (SQL 별도 승인 필요)
- `centers.is_nicepay_review`에는 `authenticated` SELECT 컬럼 권한이 없음.
- `nicepayReviewScope`는 심사관일 때 홈·검색·카테고리 쿼리에 `.eq("is_nicepay_review", true)`를 추가하므로 Production의 로그인 심사관 검색이 **42501 permission denied** 로 실패할 수 있음.
- Production 기존 RLS는 리뷰어에게 심사센터 1개·상품 3개를 허용하고, 실제 authenticated 역할과 JWT 세션값으로 검사 시 DB 필터가 없는 조회는 성공함.
- 최소 적용 제안 (사용자에게 SQL 전문·영향·롤백 보고 및 명시적 승인 후 **별도 실행**):
  ```sql
  GRANT SELECT (is_nicepay_review) ON TABLE public.centers TO authenticated;
  ```
- 이 GRANT는 RLS를 해제하지 않음. `authenticated`가 기존 RLS로 허용된 센터 행의 `is_nicepay_review` 읽기/필터만 허용. `anon`에는 부여하지 않음.
- 롤백: `REVOKE SELECT (is_nicepay_review) ON TABLE public.centers FROM authenticated;` (다른 코드에서 권한을 사용 중이면 영향 확인 후 실행).
- SQL 변경 적용 전에는 심사관의 현재 운영 검색 문제가 해결됐다고 주장하지 말 것.

## QA
1. `tests/unit/nearbyOptIn.test.ts`에서 OFF/ON/OFF 결과 확인.
2. QA 환경에서 일반 회원 홈 진입 시 위치 권한 팝업이 없어야 하며, 검색 내 주변 버튼으로만 위치를 요청함.
3. NICEPAY 심사관 로그인 → 홈 심사 전용 센터 카드 → 수강권 3개 확인.
4. 일반 회원·비로그인에서 심사용 센터와 카드가 보이지 않아야 함.
5. 카드사 결제 테스트는 기존 게이트 OFF 유지. 별도 승인 전 변경 금지.
