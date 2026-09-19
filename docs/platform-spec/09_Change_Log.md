# Change Log

Status: Active
Version: 1.1.0
Current-State Source: Master Spec document history
Target-State Status: N/A
Last Updated: 2026-07-31

## [Unreleased]

### Changed

- 승인된 후속 사양 변경을 여기에 기록한다.

## [1.1.0] - 2026-07-31

### Changed

- “구현 코드가 없다”는 전제를 제거하고 실제 저장소를 Current-State Source로 지정
- 기술 스택을 Next.js 16.2.10, React 19, TypeScript, Supabase로 교정
- 자체 REST API를 현재 구조에서 제거하고 `lib/*.ts` → Supabase table/RPC 직접 호출로 교정
- 자체 Refresh Token/session/device를 Supabase Auth 관리형 세션과 Future State로 분리
- 고정 역할 모델을 `manager_centers`, custom `center_roles`, permissions, personal overrides로 교정
- 용어를 `reservations`, `classes`, `products`, `profiles`, `accounts`에 맞춤
- `memberships`를 조직 관계가 아닌 수강권/패스로 명확화
- 관리자 직접배치·무료배치·`admin_action_logs` 반영
- 상품·수강권·주문·Mock Payment Adapter와 실제 PG Gap 반영
- 모든 핵심 문서와 Epic에 Current/Target/Gap/Decision/Blocked 구분 추가

### Added

- `11_Terminology_Map.md`

### Reclassified

- Account Linking, 비밀번호 복구, session/device, outbox, REST BFF를 Target/Future State로 이동
- 실제 PG와 외부 알림/Provider 설정을 Target 또는 Blocked로 분류

## [1.0.0] - 2026-07-31

### Added

- 최초 Booking App Master Spec
- 멀티센터, 권한, 초대, 인증, 예약 정합성의 장기 제품 원칙

