# -*- coding: utf-8 -*-
"""「本地准入 → AI 判定」这条路 —— 端到端验证。

要证明四件事：
  ① 糊图在本地就被拦下，不会送去模型（不需要 AI 也能拦）
  ② 清晰的图本地放行，并且真的把原图送进了模型（sawImage=true）
  ③ AI 在线时，摘要来自模型；结果页有内容
  ④ AI 断线时，提交被挡下、不落库、不生成任何"分析文本"

跑法：
  cd 项目根 && python -m http.server 8811 --directory .
  python tools/mock-llm.py          # 另开一个终端，模拟 8787
  python tools/e2e-ai-path.py
"""
import asyncio
import json
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8811/h5-web/index.html'
IMG = 'D:/workbuudy/01-项目/见微/tools/fixture-pothole.png'


async def login(pg):
    try:
        await pg.wait_for_selector('#authSchoolId', timeout=4000)
        await pg.fill('#authSchoolId', '2023010203')
        await pg.click('#btnSchoolLogin')
        await pg.wait_for_timeout(1600)
    except Exception:
        pass


async def goto_report(pg):
    await pg.evaluate("location.hash='#map'")
    await pg.wait_for_timeout(300)
    await pg.evaluate("location.hash='#report'")
    await pg.wait_for_timeout(800)


async def upload(pg, path):
    await pg.click('#btnAddPhoto')
    await pg.wait_for_timeout(500)
    async with pg.expect_file_chooser() as fc:
        await pg.click("[data-way='album']")
    ch = await fc.value
    await ch.set_files(path)
    await pg.wait_for_timeout(2600)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', headless=True)
        ctx = await b.new_context(
            viewport={'width': 390, 'height': 844},
            geolocation={'latitude': 34.8152, 'longitude': 113.5336},
            permissions=['geolocation'])
        pg = await ctx.new_page()
        await pg.goto(URL)
        await pg.wait_for_timeout(1200)
        await pg.evaluate("localStorage.clear()")
        await pg.reload()
        await pg.wait_for_timeout(1200)
        await login(pg)

        # ---------- ① 本地准入：糊图拦下、清晰图放行 ----------
        gate = await pg.evaluate("""async () => {
            const ag = SentinelAgent.create({ mode: 'auto' });
            const blur = await ag.check(DATA.photoDataURI('blur'));
            const good = await ag.check(DATA.photoDataURI('trash'));
            return {
              blur: { ok: blur.ok, reason: blur.reason },
              good: { ok: good.ok, reason: good.reason }
            };
        }""")
        print('① 本地准入:', gate)
        assert gate['blur']['ok'] is False and gate['blur']['reason'] == 'blur', '糊图应在本地被拦'
        assert gate['good']['ok'] is True, '清晰的图应本地放行'

        # ---------- ②③ AI 在线：原图进模型，摘要来自模型 ----------
        await goto_report(pg)
        await upload(pg, IMG)
        await pg.wait_for_timeout(1500)

        suggest = await pg.evaluate("()=>document.querySelector('#typeSuggest')?.innerText||''")
        print('② 即时预判:', suggest.replace('\\n', ' / ')[:60])
        assert 'AI' in suggest, 'AI 在线时应有即时识别结果'

        # 选类型 + 补一句描述
        await pg.click("[data-type='road']")
        await pg.fill('#descInput', '路面有个坑，骑车容易颠')
        await pg.wait_for_timeout(300)
        await pg.click('#btnSubmit')
        await pg.wait_for_timeout(6000)

        result = await pg.evaluate("()=>document.querySelector('#resultBody')?.innerText||''")
        print('③ 结果页:', result.replace('\\n', ' / ')[:120])
        assert '已经收到' in result, 'AI 在线时应正常出结果页'

        rec = await pg.evaluate("""() => {
            const all = JSON.parse(localStorage.getItem('jw.codes.v2') || '{}');
            const k = Object.keys(all)[0];
            return k ? { code: k, analysis: all[k].analysis } : null;
        }""")
        print('③ 落库判定:', json.dumps(rec, ensure_ascii=False)[:260])
        assert rec and rec['analysis']['source'] == 'deepseek', '判定来源应是 deepseek'
        assert rec['analysis']['sawImage'] is True, '原图应真的送进模型'

        # ---------- ④ AI 断线：挡下、不落库、不编文本 ----------
        await goto_report(pg)
        await pg.evaluate("localStorage.removeItem('jw.codes.v2'); localStorage.removeItem('jw.guard.v1')")
        # 不关 mock，直接把浏览器到 8787 的请求全部掐掉 —— 等价于代理挂了
        await pg.route("http://localhost:8787/**", lambda route: route.abort())
        await pg.reload()
        await pg.wait_for_timeout(1200)
        await login(pg)
        await goto_report(pg)
        await upload(pg, IMG)
        await pg.wait_for_timeout(1200)
        await pg.click("[data-type='road']")
        await pg.fill('#descInput', '路面有个坑，骑车容易颠')
        await pg.click('#btnSubmit')
        await pg.wait_for_timeout(4000)

        down = await pg.evaluate("()=>document.querySelector('#resultBody')?.innerText||''")
        print('④ 断线结果:', down.replace('\\n', ' / ')[:120])
        assert 'AI 没连上' in down, 'AI 断线时应明确提示，而不是降级'
        left = await pg.evaluate("()=>Object.keys(JSON.parse(localStorage.getItem('jw.codes.v2')||'{}')).length")
        assert left == 0, '断线时不应落库'

        print('\n全部通过')
        await b.close()


asyncio.run(main())
