/* 提交闸门的单元测试。只跑逻辑，不需要浏览器（hashImage 需要 DOM，这里不测）。 */
var path = require('path');
var store = {};
global.localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
var Guard = require(path.join(__dirname, '..', 'shared', 'guard.js'));

function seed(hits) {
  store['jw.guard.v1'] = JSON.stringify({ hits: hits, rejectStreak: 0, coolUntil: 0 });
}
var now = Date.now();
var H = 'a1b2c3d4e5f60718';
var base = { at: now - 60000, type: 'trash', lng: 116.3, lat: 39.9, code: 'JW-0001', photoHash: H };
var pass = 0, fail = 0;
function t(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

seed([base]);
var r1 = Guard.check({ type: 'lighting', lng: 116.35, lat: 39.95, photoHash: H });
t('同图换地址换类型被拦', !r1.ok && r1.reason === 'same-photo');
console.log('     文案:', r1.message);

// 重新压缩后指纹漂 3 个 bit（a1b2 → a1b3 之类）
seed([base]);
var near = 'a1b3c3d4e5f60718';
var r2 = Guard.check({ type: 'trash', lng: 116.35, lat: 39.95, photoHash: near });
t('指纹轻微漂移仍认作同一张', !r2.ok && r2.reason === 'same-photo');

// 完全不同的图
seed([base]);
var r3 = Guard.check({ type: 'trash', lng: 116.35, lat: 39.95, photoHash: 'ffeeddccbbaa9988' });
t('不同的图放行', r3.ok);

// 超过 24 小时
seed([Object.assign({}, base, { at: now - 25 * 3600 * 1000 })]);
var r4 = Guard.check({ type: 'trash', lng: 116.35, lat: 39.95, photoHash: H });
t('隔了一天不再拦', r4.ok);

// 无图上报
seed([base]);
var r5 = Guard.check({ type: 'network', lng: 116.35, lat: 39.95 });
t('无图上报不被误伤', r5.ok);

// 旧记录没有指纹字段
seed([{ at: now - 60000, type: 'trash', lng: 116.3, lat: 39.9, code: 'JW-0002' }]);
var r6 = Guard.check({ type: 'trash', lng: 116.35, lat: 39.95, photoHash: H });
t('旧记录无指纹不崩', r6.ok);

// 写入
Guard.reset();
Guard.record({ type: 'trash', lng: 116.3, lat: 39.9, code: 'JW-0003', photoHash: H });
var saved = JSON.parse(store['jw.guard.v1']);
t('record 落盘带指纹', saved.hits[0].photoHash === H);
t('只存指纹不存原图', JSON.stringify(saved).length < 200, JSON.stringify(saved).length + ' 字节');

// 原有的三道规则没被改坏
Guard.reset();
Guard.record({ type: 'trash', lng: 116.3, lat: 39.9, code: 'A' });
var g1 = Guard.check({ type: 'trash', lng: 116.3, lat: 39.9 });
t('间隔不足 25 秒被拦', !g1.ok && g1.reason === 'gap');

Guard.reset();
seed([{ at: now - 60000, type: 'trash', lng: 116.32, lat: 39.9, code: 'B' }]);
var g2 = Guard.check({ type: 'trash', lng: 116.32, lat: 39.9 });
t('同处同类 10 分钟内被拦', !g2.ok && g2.reason === 'dup');

Guard.reset();
var many = [];
for (var i = 0; i < 4; i++) many.push({ at: now - 200000 + i * 1000, type: 'trash', lng: 116 + i / 10, lat: 39.9, code: 'C' + i });
seed(many);
var g3 = Guard.check({ type: 'safety', lng: 117.5, lat: 40.5 });
t('10 分钟 4 条到顶', !g3.ok && g3.reason === 'quota');

Guard.reset();
Guard.noteReject(); Guard.noteReject(); Guard.noteReject();
var g4 = Guard.check({ type: 'trash', lng: 117.5, lat: 40.5 });
t('连败 3 次进冷静期', !g4.ok && g4.reason === 'cool');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
