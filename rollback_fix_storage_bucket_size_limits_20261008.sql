-- fix_storage_bucket_size_limits_20261008.sql 롤백 — 적용 전(Production export 기준 null = 제한 없음)으로 되돌린다.
update storage.buckets set file_size_limit = null where id in ('avatars', 'alimtalk-images', 'business-licenses');
