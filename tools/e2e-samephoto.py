# -*- coding: utf-8 -*-
"""同一张照片反复报 —— 端到端验证。

两件事要证明：
  ① 同一张图，换个地址、换个类型再报一次，会被拦下来（同图规则生效）
  ② 换一张新图，不应该被这条规则误伤（否则规则就是把人堵死）

跑法：
  cd 项目根 && python -m http.server 8811 --directory .
  python tools/e2e-samephoto.py
"""
import asyncio
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8811/h5-web/index.html'
IMG = 'D:/workbuudy/01-项目/见微/tools/fixture-pothole.png'
IMG2 = 'D:/workbuudy/01-项目/见微/tools/fixture-lamp.png'


async def login(pg):
    try:
        await pg.wait_for_selector('#authSchoolId', timeout=4000)
        await pg.fill('#authSchoolId', '2023010203')
        await pg.click('#btnSchoolLogin')
        await pg.wait_for_timeout(1600)
    except Exception as e:
        print('登录跳过:', str(e)[:60])


async def upload(pg, path):
    await pg.click('#btnAddPhoto')
    await pg.wait_for_timeout(500)
    async with pg.expect_file_chooser() as fc:
        await pg.click("[data-way='album']")
    ch = await fc.value
    await ch.set_files(path)
    await pg.wait_for_timeout(2200)


async def goto_report(pg):
    # 先回地图再进上报页：如果 hash 已经是 #report，直接赋值不会触发 hashchange
    await pg.evaluate("location.hash='#map'")
    await pg.wait_for_timeout(300)
    await pg.evaluate("location.hash='#report'")
    await pg.wait_for_timeout(800)


async def get_src(pg):
    return await pg.evaluate("""() => {
        const im = document.querySelector('#photoGrid .photo-cell img');
        return im ? im.src : null;
    }""")


async def where(pg):
    return await pg.evaluate("()=>{const e=document.querySelector('.screen.is-active');return e?e.dataset.screen:'?'}")


async def toasts(pg):
    return await pg.evaluate("""() => {
        const ts = [...document.querySelectorAll('.toast')];
        return ts.map(t => t.textContent.trim()).join(' | ');
    }""")


async def seed(pg, h):
    await pg.evaluate("""(h) => {
        localStorage.setItem('jw.guard.v1', JSON.stringify({
            hits: [{at: Date.now()-120000, type:'trash', lng:116.40, lat:39.90,
                    code:'JW-TEST99', photoHash:h}],
            rejectStreak: 0, coolUntil: 0
        }));
    }""", h)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', headless=True)
        ctx = await b.new_context(
            viewport={'width': 420, 'height': 900},
            geolocation={'latitude': 39.9625, 'longitude': 116.3415},
            permissions=['geolocation'])
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))

        await pg.goto(URL, wait_until='networkidle')
        await pg.evaluate("localStorage.clear()")
        await pg.reload(wait_until='networkidle')
        await login(pg)
        await goto_report(pg)

        # ---------- ① 同图换地址换类型 ----------
        await upload(pg, IMG)
        src = await get_src(pg)
        print('图片已入表:', 'OK' if src and src.startswith('data:image') else '缺图')
        h1 = await pg.evaluate("async (s) => await Guard.hashImage(s)", src)
        print('第一张指纹:', h1, '/ 长度', len(h1 or ''))
        await seed(pg, h1)

        await pg.click("[data-type='safety']")
        await pg.fill('#descInput', '路面井盖缺失，坑口外露')
        await pg.wait_for_timeout(300)
        await pg.click('#btnSubmit')
        await pg.wait_for_timeout(1500)
        t1 = await toasts(pg)
        print('① 结果:', 'PASS 拦住了' if '同一张' in t1 else 'FAIL 放过了')
        print('   提示:', t1[:160])
        print('   当前页面:', await where(pg))

        # ---------- ② 换新图不应误伤 ----------
        await pg.evaluate("localStorage.clear()")
        await pg.reload(wait_until='networkidle')
        await login(pg)
        await goto_report(pg)
        await upload(pg, IMG2)
        src2 = await get_src(pg)
        h2 = await pg.evaluate("async (s) => await Guard.hashImage(s)", src2)
        print('第二张指纹:', h2, '/ 与第一张相同?', h1 == h2)
        await seed(pg, h1)

        await pg.click("[data-type='lighting']")
        await pg.fill('#descInput', '这盏路灯不亮，整条路都是黑的')
        await pg.wait_for_timeout(300)
        await pg.click('#btnSubmit')
        await pg.wait_for_timeout(3000)
        t2 = await toasts(pg)
        print('② 结果:', 'PASS 未被误拦' if '同一张' not in t2 else 'FAIL 误拦了')
        print('   提示:', t2[:160])
        print('   当前页面:', await where(pg))

        if errs:
            print('页面报错:', errs[:3])
        await b.close()


asyncio.run(main())
