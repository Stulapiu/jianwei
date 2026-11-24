const { api, toast } = require('../../utils/api');

/** 徽章定义。和云函数 submitReport 里的 BADGE_RULES 一一对应，
 *  改徽章时两边都要改（已抽成常量放在这里便于对齐）。 */
const BADGE_DEFS = [
  { code: 'first_report', name: '初次出勤', icon: '🌱', desc: '完成第一次有效上报' },
  { code: 'eagle_eye', name: '火眼金睛', icon: '👁', desc: '识别出一处被忽视的安全隐患' },
  { code: 'gold_sentinel', name: '金牌哨兵', icon: '🛡', desc: '连续 7 天有效上报' },
  { code: 'night_watch', name: '夜巡者', icon: '🌙', desc: '在 22:00–06:00 之间上报' },
  { code: 'crowd', name: '众人拾柴', icon: '🤝', desc: '你的上报与邻居的合并为同一工单' },
  { code: 'clean_hand', name: '清道夫', icon: '🧹', desc: '累计 10 条卫生类有效上报' }
];

Page({
  data: {
    p: { credit: 100, validCnt: 0, resolvedCnt: 0, invalidCnt: 0, streak: 0, badgeList: [] },
    initial: '轻',
    creditLabel: '信用良好',
    ownedBadges: []
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const p = await api.call('myProfile');
      const owned = BADGE_DEFS.filter((b) => (p.badgeList || []).includes(b.code));
      this.setData({
        p,
        ownedBadges: owned,
        initial: (p.nickName || '轻').slice(0, 1),
        creditLabel: p.credit >= 95 ? '信用极好' : p.credit >= 80 ? '信用良好' : '需要加油'
      });
    } catch (err) {
      console.warn('[profile] 加载失败', err.message);
    }
  },

  goMine() {
    wx.switchTab({ url: '/pages/my-reports/my-reports' });
  },

  goBadges() {
    wx.navigateTo({ url: '/pages/badges/badges' });
  },

  exchange() {
    // 初期占位：先把入口和规则讲清楚，比放一个点不动的按钮好
    wx.showModal({
      title: '积分兑换',
      content: '可用信用分兑换校园文创、志愿时长。该功能正在和小伙伴对接中，先攒着分吧。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2B7A78'
    });
  }
});
