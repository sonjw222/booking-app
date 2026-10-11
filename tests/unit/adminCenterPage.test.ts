import { afterEach, expect, it, vi } from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('../../lib/supabaseClient',()=>({supabase:{rpc}}));
vi.mock('../../lib/authAccount',()=>({getMyAccountId:vi.fn()}));
import { fetchCenterPage } from '../../lib/admin';
const rows=Array.from({length:61},(_,i)=>({id:String(100-i).padStart(3,'0'),name:`센터 ${i}`,address:null,phone:'010-1234-5678',business_number:null,business_license_url:null,status:'pending',reject_reason:null,created_at:'2026-10-01T00:00:00Z',owner_name:null,owner_phone:null}));
afterEach(()=>{vi.unstubAllEnvs();rpc.mockReset();});
it('defaults to compatible RPC, searches before paging and preserves cursor',async()=>{
  vi.stubEnv('NEXT_PUBLIC_ADMIN_CENTER_PAGINATION','false');rpc.mockResolvedValue({data:rows,error:null});
  const first=await fetchCenterPage('pending');expect(first.centers).toHaveLength(30);expect(rpc).toHaveBeenCalledWith('admin_list_centers',{p_status:'pending'});
  const second=await fetchCenterPage('pending','',first.nextCursor);expect(second.centers).toHaveLength(30);expect(second.centers[0].id).not.toBe(first.centers[0].id);
  const end=await fetchCenterPage('pending','',second.nextCursor);expect(end.centers).toHaveLength(1);expect(end.nextCursor).toBeNull();
  expect((await fetchCenterPage('pending','센터 60')).centers).toHaveLength(1);
});
it('opt-in sends bounded server query and consumes sentinel without rendering it',async()=>{
  vi.stubEnv('NEXT_PUBLIC_ADMIN_CENTER_PAGINATION','true');rpc.mockResolvedValue({data:rows.slice(0,31),error:null});
  const page=await fetchCenterPage('approved','1234');expect(page.centers).toHaveLength(30);expect(page.nextCursor?.id).toBe(rows[29].id);
  await fetchCenterPage('approved','1234',page.nextCursor);
  expect(rpc).toHaveBeenLastCalledWith('admin_list_centers_page',{p_status:'approved',p_keyword:'1234',p_limit:30,p_before_created_at:rows[29].created_at,p_before_id:rows[29].id});
});
it('does not retry permissions or missing migration through legacy RPC',async()=>{
  vi.stubEnv('NEXT_PUBLIC_ADMIN_CENTER_PAGINATION','true');rpc.mockResolvedValue({data:null,error:{message:'forbidden'}});
  await expect(fetchCenterPage('pending')).rejects.toThrow('forbidden');expect(rpc).toHaveBeenCalledTimes(1);
});
