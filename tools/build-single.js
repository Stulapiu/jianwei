#!/usr/bin/env node
/* ==========================================================================
 * 单文件打包
 * --------------------------------------------------------------------------
 * 把 HTML 引用的 CSS 和 JS 全部内联，产出可以直接双击打开、也可以直接
 * 丢进微信发出去的单文件页面。
 *
 * 为什么需要：在 file:// 协议下打开页面时，iOS Safari 和微信内置浏览器
 * 会拒绝加载子目录里的 css/js。样式和脚本全丢，页面就变成一坨裸 HTML。
 * GitHub Pages 走 http 没这问题，但「本地双击」「微信转发」这两种最常用的
 * 分享方式都会踩到，所以两个版本都留一份。
 *
 * 用法：node tools/build-single.js
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const TARGETS = [
  { src: 'h5-web/index.html',   out: '见微-用户端.html',   title: '用户端' },
  { src: 'admin-web/index.html', out: '见微-管理后台.html', title: '管理后台' }
];

/** 内联时必须转义，否则提前闭合标签会截断脚本 */
function safeScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}
function safeStyle(code) {
  return code.replace(/<\/style/gi, '<\\/style');
}

function readAsset(htmlFile, ref) {
  // ref 可能是 ../shared/x.js 或 assets/x.css，按引用它的 html 所在目录解析
  const base = path.dirname(path.join(ROOT, htmlFile));
  const abs = path.resolve(base, ref);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

function build(target) {
  const htmlPath = path.join(ROOT, target.src);
  let html = fs.readFileSync(htmlPath, 'utf8');

  const inlined = { css: [], js: [] };
  const missing = [];

  // <link rel="stylesheet" href="...">
  html = html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (m, href) => {
      if (/^https?:|^\/\//.test(href)) {
        missing.push(href + '（外链，已保留）');
        return m;
      }
      const code = readAsset(target.src, href);
      if (code == null) { missing.push(href); return m; }
      inlined.css.push(href);
      return '<style data-from="' + href + '">\n' + safeStyle(code) + '\n</style>';
    }
  );

  // <script src="..."></script>
  html = html.replace(
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (m, src) => {
      if (/^https?:|^\/\//.test(src)) {
        missing.push(src + '（外链，已保留）');
        return m;
      }
      const code = readAsset(target.src, src);
      if (code == null) { missing.push(src); return m; }
      inlined.js.push(src);
      return '<script data-from="' + src + '">\n' + safeScript(code) + '\n</script>';
    }
  );

  // 加一行构建标记，方便确认看到的是单文件版
  html = html.replace('</head>',
    '<!-- 单文件构建 · ' + new Date().toISOString().slice(0, 19).replace('T', ' ') +
    ' · CSS×' + inlined.css.length + ' JS×' + inlined.js.length + ' -->\n</head>');

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, target.out);
  fs.writeFileSync(outPath, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`\n  ${target.title}`);
  console.log(`  输出  dist/${target.out}  (${kb} KB)`);
  console.log(`  内联  CSS ${inlined.css.length} 个 · JS ${inlined.js.length} 个`);
  if (missing.length) console.log(`  警告  ${missing.join(' , ')}`);

  return outPath;
}

console.log('─'.repeat(54));
console.log('  见微 · 单文件构建');
console.log('─'.repeat(54));

for (const t of TARGETS) build(t);

console.log('\n' + '─'.repeat(54));
console.log('  完成。这两个文件可以直接双击打开，也可以单独发出去。');
console.log('─'.repeat(54) + '\n');
