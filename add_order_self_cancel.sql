-- P1-2: 미발급 주문 취소 정책.
--
-- 지금까지 회원이 아직 발급(fulfill_order)되지 않은 주문을 취소할 방법이 앱 어디에도
-- 없었다 — app/purchases/page.tsx가 "센터에 문의해주세요" 안내만 보여주고 끝났다
-- (매니저가 아직 아무 작업도 안 한 주문인데도 회원이 직접 취소할 수 없었음).
--
-- 정책: 아직 발급 전(status가 'pending' 또는 'paid', 즉 'done'이 아닌) 본인 주문은
-- 회원이 직접 'cancelled'로 바꿀 수 있다. 시간 제한은 두지 않는다 — 매니저가 실제로
-- 처리(fulfill_order)하기 전까지는 아무 비용도 발생하지 않은 상태이므로 굳이 제한할
-- 이유가 없다(실제 PG 연동 전이라 이 시점엔 실제로 결제가 캡처된 상태도 아님, P0-1
-- 참고). 이미 발급된 뒤의 환불(24시간 이내·미사용)은 기존 정책(lib/mypage.ts의
-- refundEligibility/requestRefund) 그대로 유지 — 이 SQL은 그 경로를 전혀 건드리지 않는다.
--
-- 매니저의 기존 취소 방식(lib/orders.ts의 updateOrderStatus → orders 테이블 직접
-- UPDATE, "주문 매니저 수정" 정책)과 완전히 같은 코드 경로를 그대로 재사용한다 —
-- RLS 정책만 추가해서 회원도 "본인 소유 + 아직 미발급" 조건 안에서 같은 UPDATE를
-- 쓸 수 있게 한다(완료 조건이 요구하는 "회원·매니저 화면과 RPC가 같은 규칙을 사용").

drop policy if exists "주문 본인 취소" on orders;
create policy "주문 본인 취소"
    on orders for update
    using (profile_id in (select my_profile_ids()) and status in ('pending', 'paid'))
    with check (profile_id in (select my_profile_ids()) and status = 'cancelled');
