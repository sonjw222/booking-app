-- READ-ONLY (SELECT만)
-- 1) 적용 "전"에 실행: 버킷별 기존 객체 크기 분포 — 제안 한도를 정하는 근거. 최대값이 제안 한도 안에 들어오는지 확인한다.
select bucket_id,
       count(*)                                                        as objects,
       pg_size_pretty(max((metadata->>'size')::bigint))                as largest,
       pg_size_pretty(percentile_cont(0.99) within group (order by (metadata->>'size')::bigint)::bigint) as p99,
       pg_size_pretty(sum((metadata->>'size')::bigint))                as total
from storage.objects
where bucket_id in ('avatars', 'alimtalk-images', 'business-licenses') and metadata ? 'size'
group by bucket_id order by bucket_id;

-- 2) 적용 "후" 확인: file_size_limit 값(bytes)
select id, public, file_size_limit, pg_size_pretty(file_size_limit) as limit_pretty, allowed_mime_types
from storage.buckets where id in ('avatars', 'alimtalk-images', 'business-licenses') order by id;
