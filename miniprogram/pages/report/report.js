const { TYPES, api, toast } = require('../../utils/api');
const app = getApp();

/** AI 分析时轮播的阶段文案，让等待有「进度感」而不是干等 */
const ANALYZE_STEPS = ['正在检查照片清晰度', '正在确认设施类型', '正在匹配语义描述', '正在生成处置建议'];

Page({
  data: {
    files: [], // 本地临时路径，用于预览
    fileIDs: [], // 云存储 ID，用于提交
    types: TYPES,
    type: '',
    desc: '',
    address: '',
    lat: null,
    lng: null,
    canSubmit: false,
    analyzing: false,
    stepText: ANALYZE_STEPS[0],
    maxPhotos: 3
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '上报问题' });
    this.autoLocate();
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
  },

  /** 进入页面就自动定位，用户只需要拍照和选类型 */
  async autoLocate() {
    const loc = app.globalData.location || (await app.getLocation());
    if (!loc) {
      this.setData({ address: '' });
      return;
    }
    this.setData({
      lat: loc.lat,
      lng: loc.lng,
      address: this.data.address || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} 附近`
    });
    this.refresh();
  },

  /** 手动修正位置：调用微信内置选点，比让用户手打经纬度友好得多 */
  fixLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          lat: res.latitude,
          lng: res.longitude,
          address: res.name || res.address || '已选择位置'
        });
        this.refresh();
      },
      fail: () => {
        toast('已保留当前定位，可直接编辑上方地址');
      }
    });
  },

  onAddressInput(e) {
    this.setData({ address: e.detail.value });
  },

  pickType(e) {
    this.setData({ type: e.currentTarget.dataset.key });
    this.refresh();
  },

  onDescInput(e) {
    this.setData({ desc: e.detail.value.slice(0, 100) });
  },

  refresh() {
    const { fileIDs, type, lat } = this.data;
    this.setData({ canSubmit: fileIDs.length > 0 && !!type && lat != null });
  },

  /** 选图：压缩后立刻上传，提交时只传 fileID，用户感知更快 */
  chooseImage() {
    const remain = this.data.maxPhotos - this.data.files.length;
    if (remain <= 0) return;

    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['camera', 'album'],
      success: async (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({
          files: [...this.data.files, ...paths],
          uploading: true
        });
        wx.showLoading({ title: '上传中', mask: true });

        try {
          const ids = [];
          for (const p of paths) {
            const ext = (p.match(/\.(\w+)$/) || [, 'jpg'])[1];
            const cloudPath = `reports/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const r = await wx.cloud.uploadFile({ cloudPath, filePath: p });
            ids.push(r.fileID);
          }
          this.setData({ fileIDs: [...this.data.fileIDs, ...ids] });
          this.refresh();
        } catch (err) {
          toast('上传失败，检查网络后重试');
          this.setData({ files: this.data.files.slice(0, this.data.files.length - paths.length) });
        } finally {
          wx.hideLoading();
          this.setData({ uploading: false });
        }
      }
    });
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.index;
    const files = [...this.data.files];
    const fileIDs = [...this.data.fileIDs];
    files.splice(i, 1);
    fileIDs.splice(i, 1);
    this.setData({ files, fileIDs });
    this.refresh();
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.files
    });
  },

  /** 提交主流程：AI 判定 → 通过则入库，不通过则温和拦截 */
  async submit() {
    const { fileIDs, type, desc, address, lat, lng, canSubmit, analyzing } = this.data;
    if (!canSubmit || analyzing) {
      if (!fileIDs.length) toast('先拍一张现场照片吧');
      else if (!type) toast('选一下问题类型');
      else if (lat == null) toast('还没有获取到位置');
      return;
    }

    this.startAnalyzing();

    try {
      // 第一道：AI 双闸门
      const verdict = await api.verdict({ fileIDs, type, desc, lat, lng });

      if (!verdict.pass) {
        // 拦截：记一次无效提交，然后展示温和提示
        await api.call('markInvalid').catch(() => {});
        app.globalData.lastResult = {
          ok: false,
          verdict,
          type,
          address,
          desc,
          // 保留原始材料，结果页的「仍然提交」还要用
          fileIDs,
          lat,
          lng
        };
        this.stopAnalyzing();
        wx.redirectTo({ url: '/pages/result/result' });
        return;
      }

      // 第二道：入库 + 去重合并
      const r = await api.submit({
        fileIDs,
        type,
        desc,
        address,
        lat,
        lng,
        verdict
      });

      app.globalData.lastResult = { ok: true, ...r, verdict, type, address };
      this.stopAnalyzing();
      wx.redirectTo({ url: '/pages/result/result' });
    } catch (err) {
      this.stopAnalyzing();
      console.error('[report] 提交失败', err);
      toast(err.message || '提交失败，请稍后重试');
    }
  },

  startAnalyzing() {
    let i = 0;
    this.setData({ analyzing: true, stepText: ANALYZE_STEPS[0] });
    this._timer = setInterval(() => {
      i = (i + 1) % ANALYZE_STEPS.length;
      this.setData({ stepText: ANALYZE_STEPS[i] });
    }, 1500);
  },

  stopAnalyzing() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.setData({ analyzing: false });
  }
});
