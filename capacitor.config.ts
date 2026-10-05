import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ygo.cdbeditor',
  appName: 'YGO CDB 编辑器',
  // 静态 web 资源目录（含 index.html / cards.cdb / vendor/sql-wasm.*）
  webDir: 'www',
  server: {
    // Android webview 用 https scheme，避免 wasm / fetch 相对路径受限
    androidScheme: 'https'
  },
  // 默认随包内置 cards.cdb；App 内「打开外部 .cdb / 建立 .cdb / 保存 .cdb」由
  // @capawesome/capacitor-file-picker（基于 Storage Access Framework）实现，
  // 由 www/capacitor-bridge.js 封装，web 端自动回退到 <input type=file> / 下载。
};

export default config;
