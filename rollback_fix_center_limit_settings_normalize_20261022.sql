-- fix_center_limit_settings_normalize_20261022.sql 되돌리기 — 트리거와 함수만 제거(데이터 변경 없음).
drop trigger if exists trg_center_settings_limit_guard on center_settings;
drop function if exists center_settings_limit_guard();
