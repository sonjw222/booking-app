# UI / UX

Status: Active Current-State Guide
Version: 1.1.0
Current-State Source: `app/**/page.tsx`, `app/layout.tsx`, `app/globals.css`, `lib/**`
Target-State Status: Progressive improvement
Last Updated: 2026-07-31

## 1. Current Information Architecture

하나의 App Router 앱에서 다음 경험이 공존한다.

- **Public/Common:** `/`, `/search`, `/center/[id]`, `/login`
- **Member:** `/reservation`, `/my-reservations`, `/mypage/*`, `/profiles`, `/cart`, `/checkout`, `/purchases`, `/notifications`, `/inquiries`
- **Center Operations:** `/manager/*`
- **Platform Operations:** `/admin/*`

회원은 Account 아래 여러 Profile 중 수강 주체를 선택한다. 매니저는 여러 Center 중 현재 운영 센터를 선택한다.

## 2. Current Flows

### Member reservation

`로그인 → 프로필 선택 → 보유 수강권 센터의 수업 조회 → 수업 선택 → 사용 가능 수강권 선택 → RPC 예약 → 확정/대기`

사용 가능한 수강권이 없으면 구매 가능한 `products`를 안내하고 장바구니/결제 후 예약 맥락으로 복귀한다.

### Commerce

`상품 선택 → 장바구니 → 주문 생성 → Mock 결제 → 테스트 RPC 확인/발급 → 구매 내역`

현재 화면은 Mock임을 표시한다. 실제 PG 결제나 운영 카드 승인으로 표현하면 안 된다.

### Center operations

`/manager`에서 센터를 선택하고 수업, 회원, 상품, 주문, 매출, 설정, 스태프·권한을 관리한다. 직접배치는 수강권을 사용하는 `ADMIN_ASSIGNMENT`와 차감 없는 `ADMIN_FREE`를 구분하며 회원 화면에서는 내부 사유를 노출하지 않는다.

## 3. Current Limitations

- 세부 permission에 따른 메뉴·버튼 사전 숨김이 모든 관리 화면에 일관되게 적용되지 않는다.
- 일부 페이지는 클라이언트 가드보다 RLS/RPC 거부에 의존한다.
- OAuth Provider 설정이 없으면 소셜 로그인은 완료되지 않는다.
- 비밀번호 찾기, Account Linking, 세션·기기 화면은 현재 구현으로 확인되지 않는다.
- 알림 설정은 외부 푸시/알림톡 발송과 동일하지 않다.
- 실제 PG Provider는 미구현이다.

## 4. UX Principles

- 현재 계정 모드, Profile, Center를 항상 구분 가능하게 표시한다.
- 주문 접수, Mock 결제, 운영 결제, 수강권 발급 상태를 같은 말로 표현하지 않는다.
- 권한 없는 동작은 가능하면 UI에서 선제적으로 숨기거나 비활성화하되 서버 검증은 유지한다.
- 센터 전환 시 이전 센터의 목록·선택·Realtime subscription을 정리한다.
- 직접배치와 무료배치는 매니저에게 차감·정원 초과·사유를 명확히 설명한다.
- 회원에게는 내부 운영 사유와 무료 여부를 불필요하게 노출하지 않는다.
- 로딩·빈 상태·오류·재시도·중복 제출 상태를 명확히 제공한다.

## 5. Target State

- permission 기반 navigation/action guard 공통화
- 비밀번호 복구, Account Linking, 인증 수단 관리
- Supabase Auth 범위에서 가능한 세션 종료 및 필요 시 기기 관리 UX
- 실제 PG 결제/취소/실패/비동기 완료 상태
- 센터별 timezone 표시
- WCAG 2.2 AA 수준의 키보드, 포커스, 대비, 오류 연결

## 6. Gap and Decision Required

| Item | Gap | Decision Required |
|---|---|---|
| Permission UI | DB 거부는 있으나 선제 UI가 불균일 | 숨김 vs disabled+설명 정책 |
| Account mode | 회원/매니저 공존 | 기본 진입 및 전환 기억 정책 |
| Multi-profile | 여러 Profile 지원 | 대표/자녀 등 공식 용어 |
| Payment | Mock만 완성 | PG 및 실패/환불 UX |
| Sessions | 별도 기기 UI 없음 | 제품 범위 포함 여부 |
| Timezone | 일부 KST 고정 | 다지역 센터 지원 여부 |

