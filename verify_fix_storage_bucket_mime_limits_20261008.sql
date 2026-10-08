-- READ-ONLY 확인(SELECT만) — 기대: avatars/alimtalk-images = {image/*}, business-licenses = {image/*,application/pdf}, public 값과 file_size_limit은 변경 없음
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('avatars', 'alimtalk-images', 'business-licenses') order by id;

-- 참고: 이미 저장된 객체의 형식 분포(제한 적용 전에 예상 밖 형식이 있는지 확인용)
select bucket_id, coalesce(metadata->>'mimetype', '(없음)') as mimetype, count(*) as objects
from storage.objects where bucket_id in ('avatars', 'alimtalk-images', 'business-licenses')
group by 1, 2 order by 1, 3 desc;
