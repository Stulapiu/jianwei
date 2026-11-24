const { api } = require('../../utils/api');

const BADGE_DEFS = [
  { code: 'first_report', name: '初次出勤', icon: '🌱', desc: '完成第一次有效上报', tip: '上报一次就能拿到' },
  { code: 'eagle_eye', name: '火眼金睛', icon: '👁', desc: '识别出一处被忽视的安全隐患', tip: '提交安全隐患类问题，且紧急度达到 4 星' },
  { code: 'gold_sentinel', name: '金牌哨兵', icon: '🛡', desc: '连续 7 天有效上报', tip: '一天至少一次，连续七天' },
  { code: 'night_watch', name: '夜巡者', icon: '🌙', desc: '在 22:00–06:00 之间上报', tip: '晚自习回宿舍路上顺手拍一张' },
  { code: 'crowd', name: '众人拾柴', icon: '🤝', desc: '你的上报与邻居的合并为同一工单', tip: '同一位置 15 米内、24 小时内有人先报过' },
  { code: 'clean_hand', name: '清道夫', icon: '🧹', desc: '累计 10 条卫生类有效上报', tip: '卫生类问题攒够 10 条' }
];

Page({
  data: {
    list: [],
    ownedCount: 0
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '徽章墙' });
    this.load();
  },

  async load() {
    let owned = [];
    try {
      const p = await api.call('myProfile');
      owned = p.badgeList || [];
    } catch (e) {
      console.warn('[badges] 加载失败', e.message);
    }

    const list = BADGE_DEFS.map((b) => ({ ...b, owned: owned.includes(b.code) }));
    this.setData({ list, ownedCount: list.filter((b) => b.owned).length });
  }
});
