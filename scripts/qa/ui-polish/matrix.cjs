const { browser, setup, root, id } = require('./fixture.cjs');
const fs = require('fs'), { spawn } = require('child_process');
const server = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: process.cwd(), env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'https://qa-placeholder.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'qa-placeholder' }, stdio: 'ignore' });
process.on('exit', () => server.kill());
const routes = ['/', '/search', '/center/' + id, '/reservation', '/my-reservations', '/mypage', '/manager', '/manager/classes', '/manager/members', '/manager/notifications', '/login', '/cart', '/profiles', '/manager/center-info', '/manager/settings', '/manager/membership-rules', '/manager/goods', '/manager/staff', '/manager/alimtalk/send', '/mypage/info', '/settings/notifications', '/inquiries', '/legal', '/manager/sales', '/manager/orders', '/manager/rooms', '/manager/coupons', '/manager/admin-assignments', '/manager/alimtalk', '/manager/alimtalk/rules', '/manager/alimtalk/templates', '/manager/alimtalk/settings'];
const selectedRoutes = process.env.QA_ROUTES ? routes.filter(route => process.env.QA_ROUTES.split(',').includes(route)) : routes;
const sizes = [[390, 844], [430, 932], [820, 1180], [1024, 1366], [1180, 820], [1366, 1024], [1280, 900], [1360, 900], [1440, 1000], [1600, 1000]];
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
    const b = await browser();
    let results = [];
    for (const theme of ['burgundy', 'charcoal']) {
        const c = await b.newContext();
        await setup(c, theme);
        await c.route('https://unpkg.com/leaflet@1.9.4/dist/**', r => { let name = new URL(r.request().url()).pathname.split('/').at(-1); if (['leaflet.js', 'leaflet.css'].includes(name) && fs.existsSync(root + '/' + name))
            return r.fulfill({ path: root + '/' + name, contentType: name.endsWith('js') ? 'application/javascript' : 'text/css' }); return r.abort(); });
        await c.route('https://*.tile.openstreetmap.org/**', r => r.abort());
        for (let offset = 0; offset < selectedRoutes.length; offset += 4) {
            await Promise.all(selectedRoutes.slice(offset, offset + 4).map(async (route) => {
                const p = await c.newPage();
                const errors = [];
                p.on('pageerror', e => errors.push(e.message));
                p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|net::ERR/.test(m.text()))
                    errors.push(m.text()); });
                await p.setViewportSize({ width: 390, height: 844 });
                await p.goto('http://127.0.0.1:3000' + route, { waitUntil: 'domcontentloaded' });
                await p.waitForTimeout(900);
                for (const [width, height] of sizes) {
                    await p.setViewportSize({ width, height });
                    await p.mouse.move(width - 5, height - 5);
                    await p.waitForTimeout(250);
                    await p.evaluate(() => scrollTo(0, 0));
                    const state = await p.evaluate(() => { const nav = document.querySelector('.bottom-nav,.manager-nav'); const nr = nav?.getBoundingClientRect(); const shown = nav && getComputedStyle(nav).display !== 'none'; const ctas = [...document.querySelectorAll('.checkout-pay-btn,.center-bottom-bar,.recipient-sticky-action,.fab-btn')].filter(e => e.getClientRects().length); return { overflow: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, body: document.body.innerText.slice(0, 120), ctaOverlap: ctas.filter(e => { const r = e.getBoundingClientRect(); return shown && nr && r.bottom > nr.top && r.top < nr.bottom && r.right > nr.left && r.left < nr.right; }).map(e => e.className), map: !!window.L }; });
                    const slug = route === '/' ? 'home' : route.replaceAll('/', '_');
                    if ([390, 820, 1180, 1440].includes(width)) {
                        await p.screenshot({ path: `${root}/shots/${theme}-${width}-${slug}.png`, fullPage: true });
                    }
                    results.push({ route, theme, width, height, ...state, errors: [...new Set(errors)] });
                }
                console.log(theme, route, results.filter(r => r.route === route && r.theme === theme && r.overflow).map(r => r.width));
                await p.close();
            }));
            fs.writeFileSync(root + (process.env.QA_ROUTES ? '/matrix-targeted.json' : '/matrix.json'), JSON.stringify(results, null, 2));
        }
        await c.close();
    }
    await b.close();
    server.kill();
    console.log('TOTAL', results.length, 'overflow', results.filter(r => r.overflow).length, 'errors', results.filter(r => r.errors.length).length);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
