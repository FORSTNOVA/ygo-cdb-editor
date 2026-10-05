/*
 * Capacitor 桥接层：把「打开外部 .cdb / 建立 .cdb / 保存 .cdb」抽象成统一接口
 * - 打开（读）：@capawesome/capacitor-file-picker 的 pickFiles（SAF，readData）
 *   · 插件句柄必须从 window.Capacitor.Plugins.FilePicker 取——现代 Capacitor 不创建
 *     window.FilePicker 全局（这是之前"点保存没反应"的根因）
 * - 保存（写）：自定义 SaveFile 插件（android/.../SaveFilePlugin.java，已注册进 MainActivity）
 *   · file-picker 插件是只读的，没有 writeFile——之前调 FP.writeFile 抛
 *     "FP.writeFile is not a function" 就是这个原因
 *   · SaveFile 弹系统「另存为」对话框（ACTION_CREATE_DOCUMENT），写入用户所选位置，
 *     无需存储权限；用户取消时返回 { cancelled:true }，前端静默
 * - Web 回退：<input type=file> 打开 / 锚点下载
 */
(function () {
  'use strict';

  // 取原生插件句柄；不在原生环境或插件缺失时返回 null
  function getPlugin(name) {
    const C = window.Capacitor;
    if (!(C && C.isNativePlatform && C.isNativePlatform())) return null;
    return (C.Plugins && C.Plugins[name]) || null;
  }
  const getPicker = () => getPlugin('FilePicker');
  const getSaver  = () => getPlugin('SaveFile');

  function downloadBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  const Bridge = {
    isNative() {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    },

    // 原生 + 文件选择插件可用（app.js 据此决定走 SAF 还是 web 兜底）
    hasPicker() {
      return !!getPicker();
    },

    bytesToBase64(bytes) {
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    },

    base64ToBytes(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    },

    textToBase64(str) {
      return this.bytesToBase64(new TextEncoder().encode(str));
    },

    // 当前库文件夹（localStorage 持久保存的 SAF tree uri）
    libFolder() {
      try { return localStorage.getItem('ygo.libFolder') || ''; } catch (e) { return ''; }
    },
    setLibFolder(uri) {
      try {
        if (uri) localStorage.setItem('ygo.libFolder', uri);
        else localStorage.removeItem('ygo.libFolder');
      } catch (e) { /* ignore */ }
    },

    // 选库文件夹（SAF 目录授权，重启仍有效）；返回 uri 或 null（取消/不可用）
    async pickLibraryFolder() {
      const Saver = getSaver();
      if (!Saver || !Saver.pickFolder) return null;
      const r = await Saver.pickFolder();
      return (r && r.uri) || null;
    },

    // 列举库文件夹里的 .cdb，返回 [{name, uri}]
    async listLibraryCdb(folderUri) {
      const Saver = getSaver();
      if (!Saver || !Saver.listCdb) return [];
      const r = await Saver.listCdb({ uri: folderUri });
      return (r && r.files) || [];
    },

    // 读 SAF 文档内容，返回 base64（id 查重用）
    async readFileNative(uri) {
      const Saver = getSaver();
      if (!Saver || !Saver.readFile) return null;
      const r = await Saver.readFile({ uri });
      return (r && r.data) || null;
    },

    // ---- 内部存储（导入的官方卡库） ----
    // 写入 App 私有目录；返回 {path}。旧包没有该方法会 throw
    saveInternal(name, b64) {
      const Saver = getSaver();
      if (!Saver || !Saver.saveInternal) throw new Error('App 版本过旧，请重新打包后再试');
      return Saver.saveInternal({ name, data: b64 });
    },
    // 读取；不存在返回 null
    async readInternal(name) {
      const Saver = getSaver();
      if (!Saver || !Saver.readInternal) return null;
      const r = await Saver.readInternal({ name });
      return (r && r.data) || null;
    },

    // 打开外部 .cdb：返回 { bytes:Uint8Array, name }
    // 原生优先走自家 openFile（可默认打开库文件夹）；旧包回退 FilePicker.pickFiles；
    // web 返回 null（交给 DOM <input> 处理）
    async openExternalCdb() {
      const Saver = getSaver();
      if (Saver && Saver.openFile) {
        const r = await Saver.openFile({ initialUri: this.libFolder() });
        if (!r || r.cancelled) throw new Error('未选择文件');
        if (!r.name || !/\.cdb$/i.test(r.name)) throw new Error('请选择 .cdb 文件');
        if (!r.data) throw new Error('读取文件数据失败');
        return { bytes: this.base64ToBytes(r.data), name: r.name };
      }
      const FP = getPicker();
      if (FP) {
        const result = await FP.pickFiles({ readData: true });
        const file = result && result.files && result.files[0];
        if (!file) throw new Error('未选择文件');
        if (!/\.cdb$/i.test(file.name || '')) throw new Error('请选择 .cdb 文件');
        if (!file.data) throw new Error('读取文件数据失败');
        return { bytes: this.base64ToBytes(file.data), name: file.name };
      }
      return null;
    },

    // 建立新的空 .cdb：只在内存里建（不落盘），之后由「保存cdb」走另存为落盘
    // 返回 { bytes, name, uri:null }；web 端也不下载，保持两端行为一致
    async createCdb() {
      if (!window.DBClient) throw new Error('数据库尚未就绪');
      const bytes = window.DBClient.createEmpty();
      return { bytes, name: 'new.cards.cdb', uri: null };
    },

    // 保存字节为文件：原生弹「另存为」（默认打开库文件夹）返回 uri；取消返回 null；web 触发下载
    async saveCdb(bytes, suggestName) {
      const name = (suggestName && /\.cdb$/i.test(suggestName)) ? suggestName : 'cards-modified.cdb';
      const Saver = getSaver();
      if (Saver) {
        const res = await Saver.saveFile({
          filename: name,
          data: this.bytesToBase64(bytes),
          mime: 'application/octet-stream',
          initialUri: this.libFolder()
        });
        return (res && res.uri) || null;
      }
      downloadBytes(bytes, name);
      return null;
    },

    // 保存文本（JSON 导出用）：返回 uri 或 null
    async saveText(text, name, mime) {
      const Saver = getSaver();
      if (Saver) {
        const res = await Saver.saveFile({
          filename: name,
          data: this.textToBase64(text),
          mime: mime || 'application/json',
          initialUri: this.libFolder()
        });
        return (res && res.uri) || null;
      }
      const blob = new Blob([text], { type: mime || 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      return null;
    }
  };

  window.YGOBridge = Bridge;
})();
