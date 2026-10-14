// DEV-only fixture. Ledger is written BEFORE mutations so an always() cleanup can recover partial setup.
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkLiveEnv } from './liveEnvPreflight.mjs';
const env = process.env;
if (!checkLiveEnv(env).ok || new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'jdglfvwdnkjnraqdxuuj.supabase.co') throw Error('Only the approved CI DEV project is allowed');
const required = name => { if (!env[name]) throw Error(`Missing ${name}`); return env[name]; };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const ledger = '.admin-pagination-fixture.json';
const check = result => { if (result.error) throw Error(result.error.message); return result.data; };
if (process.argv[2] === 'prepare') {
  if (existsSync(ledger)) throw Error('Unclean fixture ledger; cleanup required first');
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, required('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const login = check(await client.auth.signInWithPassword({ email: required('TEST_MANAGER_B_EMAIL'), password: required('TEST_MANAGER_B_PASSWORD') }));
  const account = check(await admin.from('accounts').select('id,is_platform_admin').eq('auth_id', login.user.id).single());
  const rows = ['pending', 'approved', 'rejected'].flatMap(status => Array.from({ length: 31 }, (_, i) => ({ id: randomUUID(), name: `QA-pagination-${status}-${i}`, status, created_at: new Date(Date.now() + i * 1000).toISOString() })));
  writeFileSync(ledger, JSON.stringify({ account, ids: rows.map(r => r.id) }), { mode: 0o600 });
  check(await admin.from('accounts').update({ is_platform_admin: true }).eq('id', account.id).select('id').single());
  check(await admin.from('centers').insert(rows));
  console.log('DEV fixture prepared: manager B elevated, 93 isolated centers');
} else if (process.argv[2] === 'cleanup') {
  if (existsSync(ledger)) {
    const { account, ids } = JSON.parse(readFileSync(ledger, 'utf8'));
    const failures = [];
    try {
      check(await admin.from('accounts').update({ is_platform_admin: account.is_platform_admin }).eq('id', account.id).select('id').single());
      const restored = check(await admin.from('accounts').select('is_platform_admin').eq('id', account.id).single());
      if (restored.is_platform_admin !== account.is_platform_admin) throw Error('Privilege restoration mismatch');
    } catch (e) { failures.push(e); }
    try {
      check(await admin.from('center_roles').delete().in('center_id', ids));
      check(await admin.from('center_subscriptions').delete().in('center_id', ids));
      check(await admin.from('centers').delete().in('id', ids));
      const remaining = check(await admin.from('centers').select('id').in('id', ids));
      if (remaining.length) throw Error('Fixture center cleanup incomplete');
    } catch (e) { failures.push(e); }
    if (failures.length) throw new AggregateError(failures, 'DEV fixture cleanup failed');
    unlinkSync(ledger);
    console.log('DEV fixture cleanup verified: original privilege restored, 93 centers absent');
  }
} else throw Error('Use prepare or cleanup');
