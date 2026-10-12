import { expect, it, vi } from 'vitest';
import { temporaryOverrides } from '../helpers/temporaryOverrides';
it('restores existing deny/allow and removes only newly inserted overrides', async () => {
  const rows = new Map<string, string>([['deny','deny'], ['allow','allow']]);
  const fixture = temporaryOverrides<string|null>(async id => rows.get(id)??null, async(id,value)=>{if(value===null)rows.delete(id);else rows.set(id,value);});
  for(const id of ['deny','allow','new'])await fixture.set(id,'allow');
  await fixture.set('deny','deny'); // Repeated mutations must keep the original snapshot.
  await fixture.restore();await fixture.restore();
  expect([...rows]).toEqual([['deny','deny'],['allow','allow']]);
});
it('recovers a remote write that mutates data then rejects', async () => {
  let value='deny';let fail=true;
  const fixture=temporaryOverrides(async()=>value,async(_id,v)=>{value=v;if(fail){fail=false;throw new Error('response lost');}});
  await expect(fixture.set('existing','allow')).rejects.toThrow('response lost');
  await fixture.restore();expect(value).toBe('deny');
});
it('read failure prevents mutation',async()=>{
  const write=vi.fn();const fixture=temporaryOverrides(async()=>{throw new Error('read denied');},write);
  await expect(fixture.set('id',null)).rejects.toThrow('read denied');await fixture.restore();expect(write).not.toHaveBeenCalled();
});
it('cleanup failure does not prevent other restores and can be retried',async()=>{
  const rows=new Map([['a','deny'],['b','deny']]);let fail=false;
  const fixture=temporaryOverrides(async id=>rows.get(id)!,async(id,value)=>{if(fail&&id==='b')throw new Error('retry');rows.set(id,value);});
  await fixture.set('a','allow');await fixture.set('b','allow');fail=true;
  await expect(fixture.restore()).rejects.toThrow('restoration');expect(rows.get('a')).toBe('deny');
  fail=false;await fixture.restore();expect(rows.get('b')).toBe('deny');
});
