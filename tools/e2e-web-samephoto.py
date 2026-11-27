# -*- coding: utf-8 -*-
"""网页版同一张图反复报 —— 与手机端共用 jw.guard.v1，验证两边口径一致。"""
import asyncio
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8811/web/index.html'
IMG = 'D:/workbuudy/01-项目/竞赛/见微/tools/fixture-pothole.png'


async def toasts(pg):
    return await pg.evaluate("""() => [...document.querySelectorAll('.toast, .toast--warn')]
        .map(t => t.textContent.trim()).join(' | ')""")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', headless=True)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900},
            geolocation={'latitude': 39.9625, 'longitude': 116.3415},
            permissions=['geolocation'])
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until='networkidle')
        await pg.evaluate("localStorage.clear()")
        await pg.reload(wait_until='networkidle')
        await pg.wait_for_timeout(1200)

        # 网页版有登录门，先过门再切视图
        try:
            await pg.wait_for_selector('#gSchoolId', timeout=4000)
            await pg.fill('#gSchoolId', '2023010203')
            await pg.click('#gSchoolBtn')
            await pg.wait_for_timeout(1600)
        except Exception as e:
            print('登录跳过:', str(e)[:60])
        # 网页版不会自动定位，得先在地图视图点一下定位，否则提交按钮永远是灰的
        await pg.click("#btnLocate")
        await pg.wait_for_timeout(1500)
        await pg.click(".rail-btn[data-view='report']")
        await pg.wait_for_timeout(600)
        await pg.set_input_files('#fileInput', IMG)
        await pg.wait_for_timeout(2000)
        src = await pg.evaluate("""()=>{const im=document.querySelector('.shot img, #shotList img, .card-pic img');return im?im.src:null}""")
        h1 = await pg.evaluate("async (s)=>await Guard.hashImage(s)", src)
        print('网页版指纹:', h1, '/ 长度', len(h1 or ''))

        await pg.evaluate("""(h)=>{localStorage.setItem('jw.guard.v1', JSON.stringify({
            hits:[{at:Date.now()-120000,type:'trash',lng:116.40,lat:39.90,code:'JW-WEB01',photoHash:h}],
            rejectStreak:0,coolUntil:0}))}""", h1)

        await pg.click("[data-type='safety']")
        await pg.fill('#descInput', '路面井盖缺失，坑口外露')
        await pg.wait_for_timeout(400)
        await pg.click('#btnSubmit')
        await pg.wait_for_timeout(1800)
        t = await toasts(pg)
        print('结果:', 'PASS 拦住了' if '同一张' in t else 'FAIL 放过了')
        print('提示:', t[:150])
        if errs:
            print('页面报错:', errs[:3])
        await b.close()


asyncio.run(main())
