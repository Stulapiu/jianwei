const { api, toast, TYPE_LABEL } = require('../../utils/api');
const app = getApp();

/** 拦截原因 → 具体一点的解释，让用户知道下一步该怎么做 */
const REASON_HINT = {
  blur: '光线不足或手抖都容易糊。靠近一点，等画面稳定再按快门。',
  not_facility: '我们只受理公共设施相关的问题，比如路灯、井盖、垃圾桶、护栏。',
  type_mismatch: '你选的类型和描述说的好像不是同一件事，确认一下再提交？',
  no_image: '需要至少一张现场照片才能生成工单。'
};

Page({
  data: {
    r: null,
    typeLabel: '',
    reasonHint: '',
    forcing: false
  },

  onLoad() {
    const r = app.globalData.lastResult;
    if (!r) {
      // 直接进入（比如热重载）时给个兜底，别白屏
      wx.redirectTo({ url: '/pages/index/index' });
      return;
    }
    const severity =
      (r.verdict && r.verdict.severity) || r.severity || 3;

    this.setData({
      r,
      severity,
      typeLabel: TYPE_LABEL[r.type] || '设施',
      reasonHint: REASON_HINT[r.verdict && r.verdict.reason] || ''
    });
  },

  /** 重新拍一张 */
  redo() {
    wx.redirectTo({ url: '/pages/report/report' });
  },

  /**
   * 仍然提交：不把用户的判断完全否掉。
   * 走人工复核池，管理员会在工单列表里看到 review 状态的单子。
   */
  async forceSubmit() {
    const { r, forcing } = this.data;
    if (forcing) return;
    this.setData({ forcing: true });
    wx.showLoading({ title: '提交中', mask: true });

    try {
      const res = await api.submit({
        fileIDs: r.fileIDs,
        type: r.type,
        desc: r.desc,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        verdict: r.verdict,
        force: true
      });
      const next = { ok: true, ...res, verdict: r.verdict, type: r.type, address: r.address };
      app.globalData.lastResult = next;
      this.setData({ r: next });
    } catch (err) {
      toast(err.message || '提交失败');
    } finally {
      wx.hideLoading();
      this.setData({ forcing: false });
    }
  },

  goMine() {
    wx.switchTab({ url: '/pages/my-reports/my-reports' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
