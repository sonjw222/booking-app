const { browser, setup, root, id } = require('./fixture.cjs');
const fs = require('fs'), { spawn } = require('child_process');
const server = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: process.cwd(), stdio: 'ignore' });
process.on('exit', () => server.kill());
(async () => {
    for (let i = 0; i < 60; i++) {
        try {
            await fetch('http://127.0.0.1:3000');
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    const b = await browser(), results = [];
    for (const theme of ['burgundy', 'charcoal'])
        for (const [width, height] of [[390, 844], [820, 1180], [1180, 820], [1440, 1000]]) {
            const c = await b.newContext({ viewport: { width, height } });
            await setup(c, theme);
            await c.route('https://unpkg.com/leaflet@1.9.4/dist/**', r => { const name = new URL(r.request().url()).pathname.split('/').at(-1); return ['leaflet.js', 'leaflet.css'].includes(name) ? r.fulfill({ path: root + '/' + name }) : r.abort(); });
            await c.route('https://*.tile.openstreetmap.org/**', r => r.abort());
            const p = await c.newPage();
            p.setDefaultTimeout(7000);
            const go = async (route) => { await p.goto('http://127.0.0.1:3000' + route); await p.mouse.move(width - 5, height - 5); await p.waitForTimeout(700); };
            const check = async (name, fn) => { if (process.env.QA_CHECKS && !process.env.QA_CHECKS.split(",").includes(name))
                return; try {
                const details = await fn();
                results.push({ name, theme, width, pass: true, ...details });
            }
            catch (e) {
                results.push({ name, theme, width, pass: false, error: e.message.slice(0, 400) });
            } fs.writeFileSync(root + '/' + (process.env.QA_CHECKS ? 'interactions-targeted.json' : 'interactions.json'), JSON.stringify(results, null, 2)); };
            for (const [route, selector] of [['/center/' + id, '.center-bar-btn.buy'], ['/profiles', '.profile-item-tap'], ['/manager/rooms', '.header-action'], ['/manager/goods', '.header-action'], ['/manager/membership-rules', '.header-action'], ['/manager/coupons', '.header-action'], ['/manager/sales', '.header-action']])
                await check(route + ' sheet', async () => { await go(route); await p.locator(selector).first().click(); const d = p.locator('[data-sheet-overlay]').last(); await d.waitFor(); await p.waitForTimeout(200); const before = await d.evaluate(e => ({ label: e.getAttribute('aria-labelledby'), bodyLocked: document.body.style.overflow === 'hidden', within: e.getBoundingClientRect().right <= innerWidth + 1, focusInside: e.contains(document.activeElement) })); if (!before.label || !before.bodyLocked || !before.within || !before.focusInside)
                    throw Error(JSON.stringify(before)); await p.keyboard.press('Shift+Tab'); if (!await d.evaluate(e => e.contains(document.activeElement)))
                    throw Error('focus escaped'); await p.screenshot({ path: root + `/shots/${theme}-${width}-sheet-${route.replaceAll('/', '_')}.png`, fullPage: true }); await p.setViewportSize({ width, height: Math.min(height, 500) }); await p.waitForTimeout(200); const sheet = d.locator('.sheet').first(); const rect = await sheet.boundingBox(); if (rect && rect.y + rect.height > Math.min(height, 500) + 2)
                    throw Error('sheet outside reduced viewport'); await p.keyboard.press('Escape'); await d.waitFor({ state: 'detached' }); await p.setViewportSize({ width, height }); return before; });
            await check('search and navigation', async () => { await go('/search'); await p.locator('.search-input').fill('피겨'); await p.waitForTimeout(600); const button = p.locator('.search-go'); if (await button.isDisabled())
                throw Error('search stayed disabled'); const colors = await button.evaluate(e => ({ background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color })); await button.click(); await p.waitForTimeout(300); await go('/'); if (width < 768 && await p.locator('.cat-grid > *').count() !== 8)
                throw Error('category count'); await p.getByRole('link', { name: '관리자 모드', exact: true }).click(); await p.waitForURL('**/manager'); return colors; });
            await check('alimtalk selection', async () => { await go('/manager/alimtalk/send'); const action = p.locator('.recipient-sticky-action button'); if (!await action.isDisabled())
                throw Error('zero selection enabled'); const noPhone = p.locator('.recipient-row').filter({ hasText: '전화번호 필요' }); if (await noPhone.count() === 0)
                throw Error('no-phone fixture missing'); if (!await noPhone.locator('input').isDisabled())
                throw Error('no-phone recipient selectable'); await p.locator('.recipient-row input:not(:disabled)').first().check(); if (!/1명/.test(await action.innerText()) || await action.isDisabled())
                throw Error('selected action not enabled'); await action.click(); await p.locator('[data-sheet-overlay]').waitFor(); await p.keyboard.press('Escape'); return { noPhoneDisabled: true }; });
            await check('cart bottom clearance', async () => { await go('/cart'); await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(200); const state = await p.evaluate(() => { const r = document.querySelector('.checkout-pay-btn')?.getBoundingClientRect(), n = document.querySelector('.bottom-nav')?.getBoundingClientRect(); return { cta: r ? { top: r.top, bottom: r.bottom } : null, nav: n ? { top: n.top, bottom: n.bottom } : null, overlap: !!(r && n && r.bottom > n.top && r.top < n.bottom) }; }); if (state.overlap)
                throw Error(JSON.stringify(state)); return state; });
            await check('staff permissions', async () => { await go('/manager/staff'); await p.getByRole('button', { name: '역할별 권한', exact: true }).click(); await p.screenshot({ path: root + `/shots/${theme}-${width}-staff-permissions.png`, fullPage: true }); const checkboxes = await p.locator('input[type=checkbox]').count(); if (!checkboxes)
                throw Error('permission rows missing'); return { checkboxes }; });
            await check('signup step', async () => { await go('/login'); await p.getByRole('button', { name: '회원가입', exact: true }).click(); await p.getByPlaceholder('이메일', { exact: true }).fill('qa@example.invalid'); await p.getByPlaceholder('비밀번호 (6자 이상)', { exact: true }).fill('QaFixture123!'); const confirm = p.getByPlaceholder('비밀번호 확인', { exact: true }); if (await confirm.count())
                await confirm.fill('QaFixture123!'); await p.getByRole('button', { name: '다음', exact: true }).click(); await p.getByPlaceholder('이름', { exact: true }).waitFor(); await p.screenshot({ path: root + `/shots/${theme}-${width}-signup-step2.png`, fullPage: true }); });
            await check('map stacking', async () => { await go('/manager/center-info'); await p.locator('.map-preview').scrollIntoViewIfNeeded(); await p.waitForTimeout(800); const state = await p.locator('.map-preview').evaluate(e => { const style = getComputedStyle(e); window.scrollBy(0, e.getBoundingClientRect().top - 20); return { isolation: style.isolation, zIndex: style.zIndex, leaflet: !!window.L }; }); await p.waitForTimeout(150); state.headerClear = await p.evaluate(() => { const h = document.querySelector('.manager-chrome'); if (!h)
                return false; const r = h.getBoundingClientRect(); const hit = document.elementFromPoint(Math.max(r.left + 30, 30), Math.max(r.top + 20, 20)); return !!hit && !hit.closest('.leaflet-container'); }); if (state.isolation !== 'isolate' || !state.leaflet || !state.headerClear)
                throw Error(JSON.stringify(state)); await p.screenshot({ path: root + `/shots/${theme}-${width}-map-scroll.png` }); return state; });
            await c.close();
            console.log(theme, width, results.filter(r => r.theme === theme && r.width === width && !r.pass));
        }
    await b.close();
    server.kill();
    console.log('TOTAL', results.length, 'FAIL', results.filter(r => !r.pass).length);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
