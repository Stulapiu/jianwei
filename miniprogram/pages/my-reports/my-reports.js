const { api, STATUS_MAP, TYPE_LABEL, fromNow } = require('../../utils/api');

Page({
  data: {
    tab: 'all',
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'pending', label: '待处理' },
      { key: 'processing', label: '处理中' },
      { key: 'resolved', label: '已解决' },
      { key: 'rejected', label: '被驳回' }
    ],
    list: [],
    total: 0,
    loading: true
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const res = await api.call('myReports', { status: this.data.tab, size: 30 });
      const list = res.list.map((r) => ({
        ...r,
        typeLabel: TYPE_LABEL[r.type] || '设施',
        statusLabel: (STATUS_MAP[r.status] || {}).label || '待处理',
        statusColor: (STATUS_MAP[r.status] || {}).color || '#9AA8A6',
        timeText: fromNow(r.createdAt)
      }));
      this.setData({ list, total: res.total, loading: false });
    } catch (err) {
      console.warn('[my-reports] 加载失败', err.message);
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.key;
    if (tab === this.data.tab) return;
    this.setData({ tab, list: [] });
    this.load();
  },

  preview(e) {
    const { urls, current } = e.currentTarget.dataset;
    if (!urls || !urls.length) return;
    wx.previewImage({ urls, current: current || urls[0] });
  },

  goReport() {
    wx.navigateTo({ url: '/pages/report/report' });
  }
});
