-- READ-ONLY 진단(단일 SELECT, 자동 보정 UPDATE 없음): reservations.membership_consumed와 status의 모순 건수. 사용자(MEMBER/USER)와 관리자(ADMIN) 예약을 구분해 출력한다.
-- 기대(정상): inconsistent_* 건수가 모두 0. 0이 아니면 건수/영향 범위만 확인하고 보정 여부는 별도 승인을 받는다(이 파일은 데이터를 바꾸지 않는다).
select
    coalesce(reservation_source, '(null)') as reservation_source,
    coalesce(reservation_type, '(null)')   as reservation_type,
    status,
    membership_consumed,
    count(*)                               as reservations,
    -- 모순: 대기인데 차감됨 표시 / 확정·출석인데 차감 안 됨 표시
    case when status = 'waitlisted' and membership_consumed then 'INCONSISTENT: waitlisted + consumed=true'
         when status in ('confirmed', 'attended') and not membership_consumed
              and reservation_type is distinct from 'ADMIN_FREE' then 'INCONSISTENT: ' || status || ' + consumed=false'
         else 'ok' end                     as assessment
from public.reservations
group by 1, 2, 3, 4, 6
order by 6 desc, 1, 2, 3, 4;
