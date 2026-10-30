# NICEPAY 카드사 심사관 전용 카드결제 — 승인 전 준비 브랜치 (2026-10-30)

## 승인/배포 경계

- 이 브랜치는 `NICEPAY_CHECKOUT_ACTIVATED=true` 로 코드 수준 **준비**만 한다. **main 병합/Production 배포/환경변수 변경/게이트 SQL 실행은 절대 포함하지 않음.**
- 코드 상수 하나로 실결제가 열리지 않음. 서버 스위치, NICEPAY v3 MID·MerchantKey, Return URL, DB 게이트, 주문 소유자·대상 센터 검증이 각각 모두 필요.
- 일반 회원은 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false` (정확히 문자열 `false`) 유지. 심사관 `accounts.nicepay_review_access=true` 이며 심사용 센터/상품에 한해서만 카드 결제 UI 허용.
- 실물 서비스가 없는 '심사용' 수강권이므로 NICEPAY 승인 방식(테스트 카드/테스트 MID/심사 방식) 확인 전 실제 승인·청구 절대 금지. 결제창을 열기만 할지 여부도 NICEPAY 기술 답장 후 별도 승인.

## 현재 운영 상태 (확인 기준: 2026-10-30, 읽기 전용)

- NICEPAY 심사용 센터 1, 수강권 3, 심사관 1, NICEPAY 주문 0.
- `nicepay_checkout_gate.mode='off'`, 일반회원 온라인 결제 표시 OFF.
- Vercel Production: `NEXT_PUBLIC_PAYMENT_PROVIDER=toss`, `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false`.
- 키 이름 `NICEPAY_MID`, `NICEPAY_MERCHANT_KEY`, `PAYMENT_RETURN_TOKEN_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` 는 Production 에 등록됨(값을 조회하거나 로그로 남기지 않음; 유효성 미검증).
- 환경변수 `NICEPAY_CHECKOUT_ENABLED`, `NICEPAY_API_FAMILY`, `NICEPAY_ENV`, `NICEPAY_RETURN_BASE_URL` 은 미등록(단순 존재 여부만 확인).
- NICEPAY 외부 승인/카드결제창 실제 호출 미검증.

## 출시/전용 심사 전 전제 작업 (각 단계 별도 승인)

1. CI의 Unit/Lint/Build/통합/E2E와 격리 NICEPAY v3 Chromium QA 완료. 실제 NICEPAY 서버는 요청하지 않는다.
2. NICEPAY 담당자가 `mwhabit01m` 키 계열(`v3_mid` 확인), 심사용 거래 허용 범위 및 테스트 결제 방법을 답변했는지 확인.
3. Vercel Production에 **민감 값은 복사하지 말고 설정 화면에서만** `NICEPAY_CHECKOUT_ENABLED`, `NICEPAY_API_FAMILY=v3_mid`, `NICEPAY_ENV` (MID가 지원하는 환경 확인), `NICEPAY_RETURN_BASE_URL=https://mwhabit.com` 를 준비. `NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay` (다음 배포부터 인라인), `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false` 유지. **실제 활성화 전까지 NICEPAY_CHECKOUT_ENABLED=false**.
4. 기능 활성화 단계가 승인되면 DB Gate 1건만 `reviewer` 로 변경 (아래 SQL 사전검토 → 개별 승인 → 적용 → 검증). `public` 모드 사용 금지.
5. 이후 코드 PR 병합/빌드·배포 범위와 server `NICEPAY_CHECKOUT_ENABLED=true` 전환을 개별 승인. 순서가 바뀌더라도 server 및 DB 한쪽이 OFF이면 결제는 열리지 않아야 함.
6. 실기기 카드 결제수단 표시 → 카드 결제창 호출 직전 취소 테스트(외부 승인 API 호출/실결제 없이), NICEPAY 정식 심사 검증 방법 확인 후 별도 승인.
7. 심사 종료 때 반드시 DB gate `off`, 서버 스위치 `false`, 심사관 권한·심사용 센터 비공개 종료 절차를 적용(각 항목 별도 승인).

## 제안 Production SQL (작성만. 실행 안 됨.)

**사용자에게 SQL 전문·대상·영향·롤백을 먼저 설명하고 이 SQL 1건만 개별 승인받을 것.**

```sql
BEGIN;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.nicepay_checkout_gate WHERE id = true AND mode = 'off') <> 1
    OR (SELECT count(*) FROM public.nicepay_checkout_gate) <> 1
    OR (SELECT count(*) FROM public.accounts WHERE nicepay_review_access) <> 1
    OR (SELECT count(*) FROM public.centers WHERE is_nicepay_review AND status = 'approved' AND is_internal = false) <> 1
    OR (SELECT count(*) FROM public.products p JOIN public.centers c ON c.id = p.center_id WHERE c.is_nicepay_review AND p.is_active AND p.is_on_sale) <> 3
  THEN
    RAISE EXCEPTION 'NICEPAY 심사 전용 게이트 사전 조건 불충족. 변경 중단';
  END IF;
END $$;
UPDATE public.nicepay_checkout_gate
SET mode = 'reviewer', updated_at = now(), updated_by = 'NICEPAY reviewer-only rollout'
WHERE id = true AND mode = 'off';
DO $$
BEGIN
  IF (SELECT mode FROM public.nicepay_checkout_gate WHERE id = true) <> 'reviewer' THEN
    RAISE EXCEPTION 'NICEPAY 게이트 변경 검증 실패';
  END IF;
END $$;
COMMIT;
```

**영향:** NICEPAY 주문에 한해 reviewer 모드가 적용됨. 일반 결제 허용(public) 없음. 기존 주문/수강권/센터는 변경하지 않음. audit 트리거가 모드 변경 이력을 추가.
**롤백** (별도 승인 및 적용):
```sql
BEGIN;
UPDATE public.nicepay_checkout_gate
SET mode = 'off', updated_at = now(), updated_by = 'NICEPAY reviewer-only rollback'
WHERE id = true AND mode = 'reviewer';
COMMIT;
```
**검증(읽기 전용)**:
```sql
SELECT mode FROM public.nicepay_checkout_gate WHERE id = true;
SELECT count(*) FROM public.accounts WHERE nicepay_review_access = true;
SELECT count(*) FROM public.products p JOIN public.centers c ON c.id=p.center_id WHERE c.is_nicepay_review AND p.is_active AND p.is_on_sale;
```

## 보고 항목
1. 변경 파일: `lib/payments/PaymentProviderFactory.ts`, 관련 단위 테스트 6개, 이 문서.
2. SQL 실행 필요 여부: 심사 활성화 시 YES, **이번 코드 준비 작업은 NO**.
3. SQL 파일 경로: 이 문서의 '제안 Production SQL' (자동 실행하는 마이그레이션 파일 생성 안 함).
4. 순서: 앱 격리 QA → NICEPAY 서면 확인 → 운영 환경 준비(OFF) → 별도 승인 DB reviewer SQL → 별도 승인 코드 병합/서버 활성화 → 실기기 QA.
5. Supabase 직접 실행 SQL 전문: 위 승인 전 초안.
6. 실행 후 확인: gate mode, 심사관·심사상품 1/3, 일반회원 구매 UI 직접결제만, NICEPAY 카드 시연 중 외부 실승인 0.
