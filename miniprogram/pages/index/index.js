const { api, TYPE_LABEL } = require('../../utils/api');
const app = getApp();

Page({
  data: {
    lat: 30.3059,
    lng: 120.0866,
    scale: 16,
    markers: [],
    layer: 'pending',
    counts: { pending: 0, resolved: 0 },
    tip: null,
    tipColor: '#E24B4A',
    loading: true
  },

  /** marker id → 业务数据，点击时反查 */
  _points: [],

  onLoad() {
    this.initLocation();
  },

  /** 每次回到首页都刷新，保证上报完立刻能看到自己的点 */
  onShow() {
    this.loadPoints();
  },

  async initLocation() {
    const loc = app.globalData.location || (await app.getLocation());
    if (loc) {
      this.setData({ lat: loc.lat, lng: loc.lng });
    }
  },

  async loadPoints() {
    this.setData({ loading: true });
    try {
      // 两个图层都拉一次，用于顶部计数；地图只渲染当前层
      const [pending, resolved] = await Promise.all([
        api.call('mapPoints', { layer: 'pending' }),
        api.call('mapPoints', { layer: 'resolved' })
      ]);

      this._pending = pending.points;
      this._resolved = resolved.points;

      this.setData({
        counts: { pending: pending.points.length, resolved: resolved.points.length },
        loading: false
      });
      this.renderMarkers();
    } catch (err) {
      this.setData({ loading: false });
      // 首次进入若没部署云函数，不要用红色报错吓到演示者
      console.warn('[index] 点位加载失败:', err.message);
    }
  },

  renderMarkers() {
    const list = this.data.layer === 'resolved' ? this._resolved : this._pending;
    this._points = list;

    const markers = list.map((p, i) => ({
      id: i,
      latitude: p.lat,
      longitude: p.lng,
      width: 22,
      height: 22,
      iconPath:
        p.status === 'resolved'
          ? '/images/mk-resolved.png'
          : p.status === 'processing'
          ? '/images/mk-processing.png'
          : p.status === 'review'
          ? '/images/mk-review.png'
          : '/images/mk-pending.png'
    }));

    this.setData({ markers });
  },

  switchLayer(e) {
    const layer = e.currentTarget.dataset.layer;
    if (layer === this.data.layer) return;
    this.setData({ layer, tip: null });
    this.renderMarkers();
  },

  onMarkerTap(e) {
    const p = this._points[e.detail.markerId];
    if (!p) return;

    let tip;
    if (p.status === 'resolved') {
      tip = {
        title: `这个问题在 ${p.days || 1} 天前被 ${p.reporter || '一位同学'} 上报并解决`,
        sub: `${TYPE_LABEL[p.type] || '设施'} · 处理已完成`
      };
    } else if (p.multi) {
      tip = {
        title: `${TYPE_LABEL[p.type] || '设施'}问题，多人反馈中`,
        sub: '已有邻居上报过同一位置，正在等待处理'
      };
    } else {
      tip = {
        title: `${TYPE_LABEL[p.type] || '设施'}问题，等待处理`,
        sub: `紧急度 ${p.severity} / 5 · 点击右下角可以补充上报`
      };
    }

    const color = p.status === 'resolved' ? '#4C9A6A' : p.status === 'processing' ? '#EF9F27' : '#E24B4A';
    this.setData({ tip, tipColor: color });
  },

  closeTip() {
    this.setData({ tip: null });
  },

  recenter() {
    const mapCtx = wx.createMapContext('map', this);
    mapCtx.moveToLocation();
  },

  goReport() {
    wx.navigateTo({ url: '/pages/report/report' });
  }
});
