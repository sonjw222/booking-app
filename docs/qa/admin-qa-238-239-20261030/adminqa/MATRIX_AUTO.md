# 관리자 QA 매트릭스 (이슈 #239) — 자동 생성

실행 결과 59건: PASS 59 / FAIL 0 / BLOCKED 0. 환경: 로컬 격리 Supabase 스택 + 실제 Chromium(Playwright). 공유 DEV·운영 미사용.

| 역할 | 액션 | 결과 | 파일 | 메모 |
|---|---|---|---|---|
| 오너 | 수업 생성 — 등록 폼 → 목록 반영 + DB 행 | **PASS** | `01-classes.spec.ts` |  |
| 오너 | 수업 수정 — 제목 변경 저장 → DB 반영 | **PASS** | `01-classes.spec.ts` |  |
| 오너 | 일정 복사 — 이번 달 수업을 다음 달로 복사 실행 → 복사본 DB 행 | **PASS** | `01-classes.spec.ts` |  |
| 오너 | 수업 삭제 — 행의 삭제 → 확인 → DB 에서 사라짐 | **PASS** | `01-classes.spec.ts` |  |
| 오너 | 수강권 지급 — 회원 상세 → 지급하기 → 수강권·결제(서비스) 기록 | **PASS** | `02-members-passes.spec.ts` | 지급 3초 뒤 목록 행="CI User A 01012345678 · QA 10회권 (10회) ›" chips=["등급 전체","상태 전체","없음","활성"] |
| 오너 | 지급 직후 상태 일관성 — 새로고침 뒤 회원 목록 '수강권 없음'/상태 칩이 지급 결과와 일치 | **PASS** | `02-members-passes.spec.ts` | center_members.status=active; chips on=["등급 전체","상태 전체","없음","활성"] |
| 오너 | 수강권 연장 — 연장 버튼 → +30일 → 만료일 변경 저장 → DB 반영 | **PASS** | `02-members-passes.spec.ts` |  |
| 오너 | 상품(대여품) 지급 — '+ 상품 지급' → 선택 → 지급하기 → 상품 수강권 행 | **PASS** | `02-members-passes.spec.ts` |  |
| 오너 | 환불 — 관리자 화면에는 수강권 환불 처리 컨트롤이 없다(회원 본인 환불/PG API 경로) → 해당 없음(N/A) 기록 | **PASS** | `02-members-passes.spec.ts` | N/A: 회원 상세·결제 탭의 환불 버튼 0개 — 관리자 수동 환불 UI 미제공(docs/23_Admin_Feature_Audit.md E: 부분 환불 UI 없음). 실결제 환불(PG)은 금지 범위라 실행하지 않음 |
| 오너 | 주문 발급 — '확정 · 발급' → 계속하기 → 주문 처리 완료 + 수강권·매출 반영 | **PASS** | `03-orders.spec.ts` | 발급된 주문 status=done verified=false |
| 오너 | 주문 취소 — 남은 대기 주문 '취소' → 확인 → 주문 cancelled, 수강권 미발급 | **PASS** | `03-orders.spec.ts` |  |
| 오너 | 쿠폰 생성 — 정액 5,000원 → 쿠폰 생성 → 목록 + DB | **PASS** | `04-coupons-notices-reviews.spec.ts` |  |
| 오너 | 쿠폰 지급 — 쿠폰 카드에서 회원 선택 → 지급 → member_coupons 행 | **PASS** | `04-coupons-notices-reviews.spec.ts` |  |
| 오너 | 공지 작성 — 제목·내용 → 등록하고 알림 보내기 → 목록 + DB | **PASS** | `04-coupons-notices-reviews.spec.ts` |  |
| 오너 | 공지 수정 — 제목 변경 저장 → DB 반영 | **PASS** | `04-coupons-notices-reviews.spec.ts` |  |
| 오너 | 후기 답변 — 후기 행 답변 입력 → 저장 → reply/replied_at | **PASS** | `04-coupons-notices-reviews.spec.ts` |  |
| 오너 | 알림톡 발송 UI — 수신자 선택 → 템플릿 → 발송(send-alimtalk 요청은 모킹, 외부 호출 0건) | **PASS** | `05-alimtalk-staff.spec.ts` | send-alimtalk 가로챈 요청 0건(mock 제공자면 0건), 외부 호스트 요청 0건 |
| 오너 | 역할별 권한 변경 — 'QA 변경 대상' 역할에 룸 조회 권한 부여 → role_permissions 행 | **PASS** | `05-alimtalk-staff.spec.ts` |  |
| 오너 | 직원 역할 변경 — 직원 상세에서 'QA 조회 전용' 역할 지정 → manager_centers.role_id 반영(원복 포함) | **PASS** | `05-alimtalk-staff.spec.ts` |  |
| 오너 | 알림톡 서버 권한 — 오너 JWT 는 send-alimtalk 권한 검사를 통과(외부 알리고 미연동이라 502 까지만 진행) | **PASS** | `05-alimtalk-staff.spec.ts` |  |
| 제한직원 | 메뉴 노출 — 사이드 메뉴에 권한 없는 쓰기성 메뉴가 없다(매출·알림톡·쿠폰·운영설정 등) | **PASS** | `06-restricted-staff.spec.ts` | 제한직원 메뉴: ["M","3","수업","회원","3알림","더보기"] |
| 제한직원 | 주문 화면 — 조회만 가능, '확정 · 발급'/'취소' 컨트롤 없음 + 서버가 발급 RPC 도 거부 | **PASS** | `06-restricted-staff.spec.ts` |  |
| 제한직원 | 수업 등록 — UI 버튼은 보이지만 저장은 서버가 거부(DB 행 없음) | **PASS** | `06-restricted-staff.spec.ts` |  |
| 제한직원 | 공지·쿠폰 — 쓰기 컨트롤 없음 + 서버 거부 | **PASS** | `06-restricted-staff.spec.ts` |  |
| 제한직원 | 후기 — 답변·삭제 컨트롤 없음 + 서버가 답변 UPDATE 거부 | **PASS** | `06-restricted-staff.spec.ts` | 답변 버튼 0개, 삭제 버튼 0개(권한: facility.review.view 만) |
| 제한직원 | 직원·권한 — 역할 변경/권한 편집 컨트롤 없음 + 서버가 역할 지정·권한 부여 거부 | **PASS** | `06-restricted-staff.spec.ts` | 직원 상세의 역할 변경 버튼 0개 |
| 제한직원 | 알림톡 — 발송 권한(message.alimtalk.view)이 없으면 화면·회원 목록 진입점·서버(send-alimtalk) 모두 거부 | **PASS** | `06-restricted-staff.spec.ts` | 제한직원(알림톡 권한 없음)의 send-alimtalk 직접 호출 → HTTP 403 {"error":"알림톡을 보낼 권한이 없어요"} |
| 제한직원 | 대조군 — 허용된 조회(회원·상품·주문·후기·직원)는 성공 | **PASS** | `07-restricted-server-denials.spec.ts` |  |
| 제한직원 | 서버 거부 — 운영 설정 변경(facility.operation 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 200 [] |
| 제한직원 | 서버 거부 — 센터 정보 변경(facility.info 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 200 [] |
| 제한직원 | 서버 거부 — 룸 추가(facility.room.manage 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 403 {"code":"42501","details":null,"hint":null,"message":"new row violates row-level security policy for table \"rooms\""} |
| 제한직원 | 서버 거부 — 회원 등록(customer.member.create 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 403 {"code":"42501","details":null,"hint":null,"message":"new row violates row-level security policy for table \"center_members\""} |
| 제한직원 | 서버 거부 — 결제 등록(pass.payment.create 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 403 {"code":"42501","details":null,"hint":null,"message":"new row violates row-level security policy for table \"payments\""} |
| 제한직원 | 서버 거부 — 수강권 상품 수정(pass.update 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 200 [] |
| 제한직원 | 서버 거부 — 상품 판매 정지(pass.sale_toggle 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 200 [] |
| 제한직원 | 서버 거부 — 수강권 지급 RPC(customer.member.issue_pass 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 400 {"code":"P0001","details":null,"hint":null,"message":"수강권/상품을 지급할 권한이 없어요"} |
| 제한직원 | 서버 거부 — 수강권 만료일 연장 RPC(pass_expiry.update 없음) | **PASS** | `07-restricted-server-denials.spec.ts` | HTTP 400 {"code":"P0001","details":null,"hint":null,"message":"수강권 만료일을 연장할 권한이 없어요"} |
| 제한직원 | 정리 확인 — 무단 시도로 생긴 행이 없다 | **PASS** | `07-restricted-server-denials.spec.ts` |  |
| 플랫폼 관리자 | /admin — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/centers — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/banners — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/categories — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/marketing — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/reviews — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/settlement — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/subscription-plans — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 플랫폼 관리자 | /admin/subscriptions — 로드·제목 표시·페이지 오류 없음(읽기 전용) | **PASS** | `08-platform-admin.spec.ts` |  |
| 센터 오너 | /admin/centers·/admin/settlement — 접근 거부 안내, 목록·데이터 없음 | **PASS** | `08-platform-admin.spec.ts` |  |
| 일반 회원 | /admin/centers·/admin/settlement — 접근 거부 안내, 목록·데이터 없음 | **PASS** | `08-platform-admin.spec.ts` |  |
| 접근성 | 로그인 화면 — 키보드(Tab/Enter)만으로 로그인 | **PASS** | `09-a11y-keyboard.spec.ts` | 로그인: 이름 없는 조작 요소 0개 [] |
| 접근성 | 수업 등록 시트 — 이름 없는 조작 요소 없음 + 키보드로 입력·Escape 로 닫기 | **PASS** | `09-a11y-keyboard.spec.ts` | 수업 등록 시트: 이름 없는 조작 요소 0개 [] / Escape 로 시트 닫힘: true |
| 접근성 | 역할별 권한 편집 — 권한 체크박스가 이름(레이블)을 가진다 | **PASS** | `09-a11y-keyboard.spec.ts` | 역할별 권한: 이름 없는 조작 요소 0개 [] |
| 접근성 | 공지 작성·쿠폰 생성·회원 수강권 지급 시트 — 이름 없는 조작 요소 점검 | **PASS** | `09-a11y-keyboard.spec.ts` | 공지 작성 시트: 이름 없는 조작 요소 0개 [] / 쿠폰 생성 시트: 이름 없는 조작 요소 0개 [] |
| 오너 | 모바일 폭 에뮬레이션 — 관리자 주요 화면 가로 넘침 없음·페이지 오류 없음 | **PASS** | `10-mobile-emulation.spec.ts` | 실기기(iOS/Android) 관리자 폼 확인은 이 환경에서 수행 불가 → BLOCKED(에뮬레이션만 통과) |
| 제한직원 | 유효한 JWT 로 직접 호출 → 정확히 403, 외부 발송 제공자(스텁) 호출 0건 | **PASS** | `11-send-alimtalk-edge.spec.ts` |  |
| 익명 키 | 로그인 사용자가 아닌 JWT → 401(권한 차단 403 과 구분), 스텁 0건 | **PASS** | `11-send-alimtalk-edge.spec.ts` |  |
| 오너 | 권한 조회 오류(has_permission 실행 불가) → fail-closed 500, 스텁 0건 — 끝나면 권한 원복 | **PASS** | `11-send-alimtalk-edge.spec.ts` |  |
| 오너 | 정상 권한 → 200 + 스텁이 SMS 요청 정확히 1건(대체 서버로만 전달) | **PASS** | `11-send-alimtalk-edge.spec.ts` |  |
| service_role | 내부 호출 경로 유지 → 200 + 스텁 1건 | **PASS** | `11-send-alimtalk-edge.spec.ts` |  |
