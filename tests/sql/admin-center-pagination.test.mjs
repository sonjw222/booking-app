import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
test('admin pagination: guard, input validation, literal search, bounded pages, stable tied timestamps and rollback', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      grant usage on schema public to anon, authenticated;
      create function public.is_platform_admin() returns boolean language sql stable as $$ select nullif(current_setting('app.admin',true),'')::boolean $$;
      create table public.centers(id uuid primary key, name text, address text, phone text, business_number text, business_license_url text, status text, reject_reason text, created_at timestamptz not null);
      create table public.accounts(id uuid primary key, name text, phone text);
      create table public.manager_centers(id uuid primary key, center_id uuid, account_id uuid, created_at timestamptz);
      insert into centers select ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid, '센터 '||i,'서울','010-1234-5678','123-45-67890','private/license','pending',null,'2026-10-01'::timestamptz from generate_series(1,1000) i;
      update centers set name='Literal %_ Center' where id='00000000-0000-0000-0000-000000000001';
      insert into accounts values ('10000000-0000-0000-0000-000000000001','대표자 Alice','010-5555-0000');
      insert into manager_centers values ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now());`);
    const sql=readFileSync(new URL('../../supabase/migrations/20261011113106_admin_center_page_draft.sql',import.meta.url),'utf8');
    await db.exec(sql); await db.exec(sql);
    await db.exec('set role anon');
    await assert.rejects(db.query("select * from public.admin_list_centers_page('pending')"),e=>e.code==='42501');
    await db.exec('reset role; set role authenticated');
    for(const flag of ['','false']) {
      await db.query("select set_config('app.admin',$1,false)",[flag]);
      await assert.rejects(db.query("select * from public.admin_list_centers_page('pending')"),e=>e.code==='42501');
    }
    await db.exec("select set_config('app.admin','true',false)");
    for(const args of ["null","'other'","'pending','',0","'pending','',101","'pending',null","'pending','',30,now(),null"]) {
      await assert.rejects(db.query(`select * from public.admin_list_centers_page(${args})`),e=>e.code==='22023');
    }
    const first=(await db.query("select * from public.admin_list_centers_page('pending')")).rows;
    assert.equal(first.length,31); assert.equal(first[0].id,'00000000-0000-0000-0000-000000001000');
    let cursor=null; const ids=[]; let queries=0;
    do {
      const args=cursor ? ['pending','',30,cursor.created_at,cursor.id] : ['pending','',30,null,null];
      const rows=(await db.query('select * from public.admin_list_centers_page($1,$2,$3,$4,$5)',args)).rows;
      assert.ok(rows.length<=31); queries++; ids.push(...rows.slice(0,30).map(c=>c.id));
      cursor=rows.length>30?rows[29]:null;
    } while(cursor);
    assert.equal(ids.length,1000); assert.equal(new Set(ids).size,1000); assert.equal(queries,34);
    for(const keyword of ['%_', ' ALICE ', '55550000','1234567890']) {
      const rows=(await db.query("select * from public.admin_list_centers_page('pending',$1)",[keyword])).rows;
      assert.equal(rows.length,keyword==='1234567890'?31:1);
    }
    assert.equal((await db.query("select * from public.admin_list_centers_page('approved')")).rows.length,0);
    await db.exec('reset role; drop function public.admin_list_centers_page(text,text,integer,timestamptz,uuid)');
    assert.equal((await db.query('select count(*)::int n from centers')).rows[0].n,1000);
  } finally { await db.close(); }
});
