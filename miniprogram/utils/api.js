/**
 * 统一请求层 & 常量
 * ------------------------------------------------------------
 * 所有页面只从这里调云函数，好处是：
 *   - 错误提示统一，不会每个页面各写一套 toast
 *   - 以后接 H5 / App，只要换掉这个文件里的实现
 */

/** 问题类型：顺序即用户看到的顺序，按上报频率排的 */
const TYPES = [
  { key: 'lighting', label: '照明' },
  { key: 'sanitation', label: '卫生' },
  { key: 'facility', label: '设施损坏' },
  { key: 'safety', label: '安全隐患' },
  { key: 'other', label: '其他' }
];

const TYPE_LABEL = TYPES.reduce((m, t) => ({ ...m, [t.key]: t.label }), {});

/** 上报/工单状态 → 展示文案与颜色 */
const STATUS_MAP = {
  pending: { label: '待处理', color: '#E24B4A' },
  processing: { label: '处理中', color: '#EF9F27' },
  review: { label: '人工复核', color: '#8A8F98' },
  resolved: { label: '已解决', color: '#4C9A6A' },
  rejected: { label: '被驳回', color: '#9AA8A6' }
};

/** 底层调用 */
function callFn(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => resolve(res.result),
      fail: (err) => reject(new Error((err && err.errMsg) || '网络异常，请稍后再试'))
    });
  });
}

const api = {
  /** 走统一数据接口（读操作 + 后台操作） */
  call(action, payload = {}) {
    return callFn('api', { action, ...payload }).then((r) => {
      if (!r || r.ok === false) throw new Error((r && r.error) || '请求失败');
      return r.data;
    });
  },

  /** AI 判定，单独一个云函数，方便配置更长超时 */
  verdict(payload) {
    return callFn('aiSentinel', payload).then((r) => {
      if (!r) throw new Error('AI 无响应');
      return r;
    });
  },

  /** 提交入库 */
  submit(payload) {
    return callFn('submitReport', payload).then((r) => {
      if (!r || !r.ok) throw new Error((r && r.error) || '提交失败');
      return r;
    });
  },

  /** 生成类（周报/巡逻/合并建议） */
  gen(action) {
    return callFn('genReport', { action }).then((r) => {
      if (!r || r.ok === false) throw new Error((r && r.error) || '生成失败');
      return r.data;
    });
  }
};

/** 轻提示 */
function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 2000 });
}

/** 相对时间：刚刚 / 12 分钟前 / 3 天前 */
function fromNow(date) {
  if (!date) return '';
  const t = new Date(date).getTime();
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  const d = Math.floor(diff / 86400000);
  return d + ' 天前';
}

module.exports = { TYPES, TYPE_LABEL, STATUS_MAP, api, toast, fromNow };
