# 최종 점검 격리 브라우저 QA (2026-11-09)
제안 SQL(`add_orders_selected_size_validation_20261109_proposed.sql`)을 격리 DB 에 적용한 상태에서 재실행 — `sheetCheckout` 41 PASS · `classPasses` 6 PASS · `backPolicy` 6 PASS/1 BLOCKED(실기기) · `returnFlow` 8 PASS · 심사경로 `browserQa` 27/27 PASS. 스택은 `REVIEWPATH_PORT_OFFSET=300`. 정상 흐름은 트리거의 영향을 받지 않았다(사이즈 선택 후 주문 INSERT 는 SQL 직접 검증으로 성공 확인, 롤백).
