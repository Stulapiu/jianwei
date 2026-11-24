#!/usr/bin/env node
/* ==========================================================================
 * 见微 · 本地开发服务器
 * --------------------------------------------------------------------------
 * 一条命令解决四件事：
 *
 * 1. 静态托管      —— 用 http:// 打开页面，而不是 file://。
 *                    这是关键：file:// 协议下浏览器会禁用 navigator.geolocation，
 *                    而且加载不了子目录的 CSS/JS。
 * 2. 转发 DeepSeek —— 浏览器直连 api.deepseek.com 会被 CORS 拦死，
 *                    服务端转发没有同源限制。
 * 3. 保管密钥      —— API Key 只存在于这台机器的环境变量里，
 *                    前端代码和 GitHub 仓库里永远看不到。
 * 4. 离线兜底      —— 没配 Key 也能跑，前端自动回落到本地规则引擎。
 *
 * 用法：
 *   set DEEPSEEK_API_KEY=sk-xxxx      （Windows CMD）
 *   $env:DEEPSEEK_API_KEY="sk-xxxx"   （PowerShell）
 *   export DEEPSEEK_API_KEY=sk-xxxx   （bash）
 *   node server/proxy.mjs
 *
 * 然后浏览器打开 http://localhost:8787
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');   // 项目根目录
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

/* 读取 server/.env（若存在）。只是为了省掉每次开新终端都要 export 一遍，
 * 这个文件已在 .gitignore 里，永远不会进仓库。环境变量优先级更高。 */
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf('=');
    if (i < 1) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  });
}
loadDotEnv();

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

/* --------------------------------------------------------------------------
 * MIME
 * ------------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/* --------------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------------ */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const log = (...args) =>
  console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...args);

/* --------------------------------------------------------------------------
 * 静态文件
 * ------------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  // 目录 → index.html
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 根路径给一个入口页，省得记目录名
  if (rel === '/index.html') return serveLanding(res);

  let file = path.join(ROOT, rel);

  // 防目录穿越：解析后必须仍在 ROOT 内
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
      fs.stat(file, (e2) => {
        if (e2) return notFound(res);
        sendFile(res, file);
      });
      return;
    }
    if (err) return notFound(res);
    sendFile(res, file);
  });
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache'
  });
  stream.pipe(res);
  stream.on('error', () => res.end());
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<meta charset="utf-8"><body style="font:16px system-ui;padding:48px">'
    + '<h2>404</h2><p>没有这个文件。回 <a href="/">首页</a> 看看入口在哪。</p>');
}

/** 根路径的导航页 */
function serveLanding(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>见微 · 本地预览</title>
<style>
:root{--b:#2B7A78}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;
  font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  color:#17302E;background:radial-gradient(1200px 600px at 50% -10%,#EAF4F3,#F7F9F9 60%)}
.card{width:min(560px,100%);padding:34px 32px;border-radius:22px;background:#fff;
  box-shadow:0 24px 60px -34px rgba(20,60,56,.45);border:1px solid #E4EDEC}
h1{margin:0 0 4px;font-size:21px;letter-spacing:-.3px}
.sub{color:#6B8380;font-size:13px;margin-bottom:26px}
a.row{display:flex;align-items:center;gap:14px;padding:15px 16px;margin-bottom:10px;
  border-radius:14px;border:1px solid #E9F0EF;text-decoration:none;color:inherit;
  transition:all .18s}
a.row:hover{border-color:var(--b);background:#F5FBFA;transform:translateY(-1px)}
.ico{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  background:rgba(43,122,120,.1);color:var(--b);flex:none}
.t{font-weight:600;font-size:14.5px}
.d{font-size:12px;color:#7C918E}
.badge{margin-top:20px;padding:11px 13px;border-radius:11px;font-size:12px;
  background:#F3F8F7;color:#4A6563;border:1px solid #E6EFEE}
code{background:rgba(43,122,120,.09);padding:1px 5px;border-radius:4px;font-size:11.5px}
</style></head><body>
<div class="card">
  <h1>见微 · 校园微治理</h1>
  <div class="sub">本地预览 · 郑州大学主校区</div>

  <a class="row" href="/h5-web/index.html">
    <span class="ico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg></span>
    <span><div class="t">用户端</div><div class="d">六屏演示 · 定位 · 拍照上报 · AI 拦截</div></span>
  </a>

  <a class="row" href="/admin-web/index.html">
    <span class="ico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>
    <span><div class="t">管理后台</div><div class="d">热力图 · 工单 · 排序 · 部门派单 · 周报</div></span>
  </a>

  <div class="badge">
    AI 判定：${API_KEY ? '<b style="color:#2B7A78">DeepSeek 已连接</b>（' + MODEL + '，密钥在服务端）' : '本地规则引擎运行中。要接 DeepSeek，设置 <code>DEEPSEEK_API_KEY</code> 后重启本服务。'}
  </div>
</div>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/* --------------------------------------------------------------------------
 * DeepSeek 转发
 * ------------------------------------------------------------------------ */

async function forwardChat(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return json(res, 400, { error: { message: '请求体不是合法 JSON：' + e.message } });
  }

  if (!API_KEY) {
    return json(res, 503, {
      error: {
        message: '服务端没有配置 DEEPSEEK_API_KEY',
        type: 'no_api_key'
      }
    });
  }

  const t0 = Date.now();
  try {
    const upstream = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: payload.model || MODEL,
        messages: payload.messages || [],
        temperature: payload.temperature ?? 0.2,
        max_tokens: payload.max_tokens || 600,
        response_format: payload.response_format
      })
    });

    const text = await upstream.text();
    log(`deepseek ${upstream.status} ${Date.now() - t0}ms`);

    if (!upstream.ok) {
      return json(res, upstream.status, {
        error: { message: '上游返回 ' + upstream.status, raw: text.slice(0, 400) }
      });
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(text);
  } catch (e) {
    log('deepseek 失败：', e.message);
    json(res, 502, { error: { message: '转发失败：' + e.message } });
  }
}

/* --------------------------------------------------------------------------
 * 路由
 * ------------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (url === '/health') {
    return json(res, 200, {
      ok: true,
      hasKey: !!API_KEY,
      model: MODEL,
      upstream: API_BASE
    });
  }

  if (url.startsWith('/v1/chat/completions') && method === 'POST') {
    return forwardChat(req, res);
  }

  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(req, res, url);
  }

  json(res, 405, { error: { message: '不支持的方法' } });
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(52);
  console.log('\n' + line);
  console.log('  见微 · 本地服务器已启动');
  console.log(line);
  console.log(`  用户端    http://localhost:${PORT}/h5-web/index.html`);
  console.log(`  管理端    http://localhost:${PORT}/admin-web/index.html`);
  console.log(`  AI 模式   ${API_KEY ? 'DeepSeek · ' + MODEL : '本地规则引擎（未配置 DEEPSEEK_API_KEY）'}`);
  console.log(line);
  console.log('  按 Ctrl+C 停止\n');
});
