/**
 * 小程序入口
 * ------------------------------------------------------------
 * 上线前需要做的一件事：把 cloudEnv 换成你自己的云开发环境 ID。
 * 留空时使用当前默认环境，本地开发一般也能直接用。
 */
App({
  globalData: {
    /** 云开发环境 ID，例如 'qing-shao-bing-3g8xxxxx' */
    cloudEnv: '',
    /** 上一页跳转过来时携带的结果，用于结果页展示（避免 URL 传复杂对象） */
    lastResult: null,
    /** 用户当前定位缓存，首页和上报页共用，避免重复授权 */
    location: null
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 以上版本');
      return;
    }
    wx.cloud.init({
      ...(this.globalData.cloudEnv ? { env: this.globalData.cloudEnv } : {}),
      traceUser: true
    });
  },

  /**
   * 统一的定位获取。首页与上报页都会调用，抽出来避免各写一遍。
   * 失败时不抛错，返回 null，由调用方决定降级方案。
   */
  getLocation() {
    return new Promise((resolve) => {
      wx.getLocation({
        type: 'gcj02',
        success: (res) => {
          this.globalData.location = {
            lat: res.latitude,
            lng: res.longitude
          };
          resolve(this.globalData.location);
        },
        fail: () => resolve(null)
      });
    });
  }
});
