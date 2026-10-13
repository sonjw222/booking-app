-- Disable NEXT_PUBLIC_ADMIN_CENTER_PAGINATION and rebuild the app before removing this RPC.
begin;
drop function if exists public.admin_list_centers_page(text, text, integer, timestamptz, uuid);
commit;
