import { expect, it, vi } from 'vitest';
vi.mock('../../lib/supabaseClient',()=>({supabase:{}}));
import { cancellationNotice, type CancelNoticePolicy } from '../../lib/cancelPreview';
const now=Date.parse('2026-10-12T04:00:00Z');
const policy:CancelNoticePolicy={startsAt:'2026-10-12T05:00:00Z',createdAt:'2026-10-12T03:40:00Z',deadline:'2026-10-12T03:00:00Z',allowCancel:true,deductLate:true,sameDayHours:0,sameDayMinutes:0};
it('distinguishes late deduction and forbidden late cancellation',()=>{
 expect(cancellationNotice(policy,now)).toContain('차감');expect(cancellationNotice({...policy,deductLate:false},now)).toContain('취소할 수 없');
});
it('grace includes exactly ten minutes and never extends past class start',()=>{
 const p={...policy,createdAt:'2026-10-12T03:50:00Z'};expect(cancellationNotice(p,now)).toContain('무료');expect(cancellationNotice(p,now+1)).toContain('차감');expect(cancellationNotice(p,Date.parse(p.startsAt))).toContain('시작');
});
it('applies same-day extension only when ordinary deadline is before today in KST',()=>{
 const p={...policy,deadline:'2026-10-11T03:00:00Z',sameDayHours:0,sameDayMinutes:30};expect(cancellationNotice(p,now)).toContain('무료');expect(cancellationNotice({...p,createdAt:'2026-10-11T03:40:00Z'},now)).toContain('차감');
});
it('honors allowCancel=false outside grace and rejects unknown timestamps',()=>{
 expect(cancellationNotice({...policy,allowCancel:false},now)).toContain('불가능');expect(()=>cancellationNotice({...policy,createdAt:'invalid'},now)).toThrow('확인하지 못');
});
