import asyncio
from playwright.async_api import async_playwright
URL='http://127.0.0.1:8811/web/index.html'
IMG='D:/workbuudy/01-项目/竞赛/见微/tools/fixture-lamp.png'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(channel='chrome', headless=True)
        ctx=await b.new_context(viewport={'width':1440,'height':900},
            geolocation={'latitude':39.9625,'longitude':116.3415}, permissions=['geolocation'])
        pg=await ctx.new_page()
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until='networkidle')
        await pg.evaluate("localStorage.clear()")
        await pg.reload(wait_until='networkidle')
        try:
            await pg.wait_for_selector('#gSchoolId', timeout=4000)
            await pg.fill('#gSchoolId','2023010203'); await pg.click('#gSchoolBtn'); await pg.wait_for_timeout(1600)
        except Exception as e: print('login skip', str(e)[:50])
        await pg.click('#btnLocate'); await pg.wait_for_timeout(1500)
        await pg.click(".rail-btn[data-view='report']"); await pg.wait_for_timeout(500)
        await pg.set_input_files('#fileInput', IMG); await pg.wait_for_timeout(2200)
        await pg.click("[data-type='lighting']")
        await pg.fill('#descInput','这盏路灯不亮，整条路都是黑的')
        await pg.wait_for_timeout(400)
        print('按钮 disabled?', await pg.get_attribute('#btnSubmit','aria-disabled'))
        await pg.click('#btnSubmit'); await pg.wait_for_timeout(3000)
        t=await pg.evaluate("()=>[...document.querySelectorAll('.toast')].map(x=>x.textContent.trim()).join(' | ')")
        view=await pg.evaluate("()=>{const e=document.querySelector('.view.is-on');return e?e.dataset.view:'?'}")
        print('toast:', t[:120]); print('view:', view)
        print('页面报错:', errs[:2] if errs else '无')
        await b.close()
asyncio.run(main())
