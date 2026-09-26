// Synthetic UI fixtures only. No production credentials or live writes.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.env.QA_OUTPUT_DIR || '.qa-ui-polish');
fs.mkdirSync(root + '/shots', { recursive: true });
const id = '00000000-0000-4000-8000-000000000001';
const center = { id, name: '어텐션 피겨팀', status: 'approved', address: '서울 송파구 올림픽로 25', phone: '02-1234-5678', intro: '함께 움직이는 즐거움. 처음 시작하는 분도 환영합니다.', intro_blocks: [{ type: 'text', value: '함께 움직이는 즐거움. 처음 시작하는 분도 환영합니다.' }], categories: ['피겨스케이팅', '발레'], latitude: 37.515, longitude: 127.075, photo_url: null, sns: 'https://example.com', pay_methods: ['card', 'cash'], review_point: 1000 };
const account = { id, name: '테스트 회원', phone: '01012345678', is_member: true, is_manager: true, marketing_consent: false, address: '서울', auth_id: id };
const profile = { id, account_id: id, name: '테스트 회원', is_primary: true, label: '본인', created_at: '2026-01-01', accounts: account };
const product = { id, center_id: id, name: '피겨 그룹 10회', price: 470000, total_count: 10, product_kind: 'pass', pass_type: 'count', is_active: true, is_on_sale: true, unlimited: false, description: '기초부터 함께 배우는 그룹 클래스', sizes: [], visibility: 'all', coupon_eligible: true };
const role = { id, name: '스튜디오 오너', is_owner: true, is_system: true };
const today = new Date().toISOString().slice(0, 10);
const cls = { id, center_id: id, title: '성인 피겨 기초 클래스', start_time: today + 'T10:00:00Z', end_time: today + 'T11:00:00Z', capacity: 8, status: 'open', class_type: 'group', centers: center, rooms: { name: '메인 룸' }, trainer_id: id, manager_centers: { accounts: account } };
const membership = { id, profile_id: id, center_id: id, product_id: id, product_name: product.name, remaining_count: 7, total_count: 10, expires_at: '2027-12-31', starts_at: '2026-01-01', status: 'active', pass_type: 'count', centers: center, products: product, profiles: profile };
const tables = { accounts: [account], profiles: [profile], centers: [center], manager_centers: [{ id, account_id: id, center_id: id, role_id: id, status: 'active', centers: center, center_roles: role, accounts: account }], center_roles: [role, { id: 'role-2', name: '매니저', is_owner: false }, { id: 'role-3', name: '강사', is_owner: false }], classes: [cls], class_reservation_counts: [{ class_id: id, confirmed_count: 3, waitlisted_count: 0 }], memberships: [membership, { ...membership, id: "membership-2", profile_id: "profile-2", profiles: { name: "연락처 없는 회원" } }], products: [product, { ...product, id: 'goods-1', name: '트레이닝 의류', product_kind: 'goods', sizes: ['S', 'M', 'L'], price: 30000 }], center_members: [{ id, profile_id: id, grade_id: id, status: 'active', profiles: profile, member_grades: { name: 'VIP', color: null }, registered_at: '2026-01-01', app_linked: true }, { id: 'member-2', profile_id: 'profile-2', grade_id: id, status: 'active', profiles: { name: '연락처 없는 회원' }, member_grades: { name: '일반', color: null }, registered_at: '2026-01-02' }], member_grades: [{ id, name: 'VIP', color: null }, { id: 'grade-2', name: '아주 긴 이름을 가진 프리미엄 회원 등급', color: null }], cart_items: [{ id, center_id: id, product_id: id, product_name: product.name, price: 470000, products: product }], center_settings: [], rooms: [{ id, name: '메인 룸', description: '기초 수업 공간', address: center.address, latitude: center.latitude, longitude: center.longitude }], service_categories: ['피겨스케이팅', '필라테스', '발레', '리듬체조', '요가', '복싱', '수영', '골프', '테니스'].map((label, i) => ({ id: 'cat-' + i, label, sort_order: i, is_active: true })), home_banners: [{ id, title: '가까운 곳에서 시작해요', subtitle: '내게 맞는 클래스를 만나보세요', link_url: '/search', is_active: true }], permissions: [{ key: 'facility.info', label: '센터 정보 수정', category: 'facility', description: '센터 소개와 위치 정보를 관리합니다.', sort_order: 1, parent_key: null }, { key: 'facility.operation', label: '운영 정보 설정', category: 'facility', description: '예약 운영 설정을 관리합니다.', sort_order: 2, parent_key: null }], center_subscriptions: [{ id, center_id: id, status: 'active', alimtalk_addon: true }], notifications: [{ id, title: '예약이 확정되었어요', body: '성인 피겨 기초 클래스 예약 내용을 확인해주세요.', is_read: false, created_at: new Date().toISOString(), kind: 'reservation', account_id: id }], manager_notifications: [{ id, title: '새 예약이 접수됐어요', body: '테스트 회원 · 성인 피겨 기초 클래스', is_read: false, created_at: new Date().toISOString() }] };
async function setup(context, theme = 'burgundy') {
    await context.route('**/*', r => { const u = new URL(r.request().url()); return ['127.0.0.1', 'qa-placeholder.supabase.co', 'unpkg.com'].includes(u.hostname) ? r.continue() : r.abort(); });
    const user = { id, aud: 'authenticated', role: 'authenticated', email: 'qa@example.invalid', phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: account.name }, created_at: '2026-01-01T00:00:00Z' };
    const token = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: id, exp: 4102444800, role: 'authenticated' })).toString('base64url') + '.fixture';
    await context.addInitScript(({ theme, user, token }) => { localStorage.setItem('app_theme', theme); localStorage.setItem('sb-qa-placeholder-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture', expires_at: 4102444800, expires_in: 360000, token_type: 'bearer', user })); }, { theme, user, token });
    await context.route('https://qa-placeholder.supabase.co/**', async (route) => {
        const req = route.request(), u = new URL(req.url());
        const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': '0-0/1' };
        let data = [];
        if (u.pathname.includes('/auth/v1/user'))
            data = user;
        else if (u.pathname.includes('/functions/'))
            data = u.pathname.endsWith('send-alimtalk') ? { connected: false } : {};
        else if (u.pathname.includes('/rpc/')) {
            const name = u.pathname.split('/').at(-1);
            if (name === 'my_account_id')
                data = id;
            else if (name === 'fetch_member_phones_safe')
                data = [{ profile_id: id, account_phone: '01012345678' }];
            else if (name === 'manager_dashboard_summary')
                data = { todayRevenue: 470000, monthRevenue: 940000, periodRevenue: 470000, periodPaymentCount: 1, periodMembershipRevenue: 470000, periodGoodsRevenue: 0, unpaidTotal: 0, byMethod: { card: 470000, cash: 0, transfer: 0, point: 0 }, daily: [] };
            else if (name === 'fetch_purchasable_products')
                data = [product];
            else if (/has_permission|is_owner/.test(name))
                data = true;
            else
                data = [];
        }
        else {
            const name = u.pathname.split('/').at(-1);
            data = tables[name] ?? [];
            if (u.searchParams.has('product_kind'))
                data = data.filter(x => x.product_kind === u.searchParams.get('product_kind').replace('eq.', ''));
            if (req.headers().accept?.includes('vnd.pgrst.object'))
                data = data[0] ?? null;
        }
        await route.fulfill({ status: 200, headers, body: req.method() === 'HEAD' ? '' : JSON.stringify(data) });
    });
}
async function browser() { return chromium.launch({ executablePath: process.env.QA_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'], env: { ...process.env, ...(process.env.QA_FONTCONFIG_FILE ? { FONTCONFIG_FILE: process.env.QA_FONTCONFIG_FILE } : {}) }, headless: true }); }
module.exports = { browser, setup, root, id };
