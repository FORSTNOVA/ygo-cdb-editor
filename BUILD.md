# Android 构建与资源更新

本项目已有 Capacitor 6 的 `android/` 工程。网页资源位于 `www/`，Android Studio 实际打包的是同步到 `android/app/src/main/assets/public/` 的副本。修改 `www/` 后，先同步资源，再重新运行或构建 App。功能与文件说明见 [README.md](README.md)。

## 环境准备

- Node.js、npm 和项目锁文件对应的依赖。首次在本目录执行 `npm ci`。
- Android Studio、Android SDK（项目 `compileSdkVersion` / `targetSdkVersion` 为 34）和一台已启用 USB 调试的设备，或模拟器。
- Gradle 使用 JDK 21；在 Android Studio 的 Gradle JDK 设置中选择 21，或在命令行环境中让 `JAVA_HOME` 指向 JDK 21。仓库的 `android/gradle.properties` 也记录了这一要求。
- 网页预览另需 Python（`npm start` 使用 `python -m http.server`）。

仓库已有原生工程，**不要再次运行 `npx cap add android`**。

## 开发与真机运行

在项目根目录执行：

```powershell
npm ci
# 先按下文准备 www/cards.cdb 与需要的系列码名称表
npx cap sync android
npx cap open android
```

也可以直接在 Android Studio 打开本目录的 `android/`。等待 Gradle 同步完成，选择设备和 `app` 运行配置，点击 **Run**。这会构建并安装调试版。

日常只改了 `www/` 中的 HTML、JS、CSS、`cards.cdb` 或 `setnames.js` 时，重新运行前执行：

```powershell
npx cap copy android
```

如果修改了 npm 依赖、Capacitor 配置或原生插件接入，使用 `npx cap sync android`。`copy` 只更新网页资源；`sync` 还会同步原生依赖和配置。`SaveFilePlugin.java` 是本项目自定义的 Android 插件，已在 `MainActivity.java` 注册。

命令行构建调试 APK（Windows PowerShell）：

```powershell
cd android
.\gradlew.bat :app:assembleDebug
```

Gradle 构建的常规输出位置为 `android/app/build/outputs/apk/debug/app-debug.apk`。Android Studio 的 **Run** 流程也可能把本次安装用的 APK 放在 `android/app/build/intermediates/apk/debug/`；以 Android Studio 构建输出或实际生成文件为准。

## 更新内置卡库与系列码名称

`www/cards.cdb` 是随 APK 打包的初始卡库，公开仓库不包含游戏卡库数据。先从自己有权使用的游戏安装目录或卡库来源取得 `.cdb`，复制到该位置。例如本工作区另有卡库目录时，可在项目根目录执行：

```powershell
Copy-Item -LiteralPath '..\游戏王卡片数据\cards.cdb' -Destination '.\www\cards.cdb'
```

系列码中文名来自游戏 `zh-CN/strings.conf` 的 `!setname` 条目。公开仓库不包含生成后的 `www/setnames.js`；首次构建和游戏配置新增或修改自定义编码后（例如用卡密工具写入新系列码），运行：

```powershell
node .\gen-setnames.js 'D:\Game\MDPro3\Data\locales\zh-CN\strings.conf'
npx cap copy android
```

把示例路径改成自己的游戏配置文件路径。在首次构建时，先准备 `www/cards.cdb` 和 `www/setnames.js`，再执行 `npx cap sync android`。

随后在 Android Studio 重新运行或构建。编辑器的系列码数字框使用十进制；检索框支持中文名称、十进制和 `0x` 十六进制代码。游戏的 `strings.conf`、本项目的 `www/setnames.js` 和 APK 内的资源是三个不同位置；修改游戏文件不会自动改变已安装的 App。

如果 Android App 内曾通过「导入官方卡库…」导入 `.cdb`，启动时会优先使用保存在 App 私有目录中的导入版本。只替换 `www/cards.cdb` 并重新打包，不会覆盖那份导入数据；需要在 App 中重新导入目标卡库。

## 文件保存与导出

Android 打开文件、选择库文件夹和保存文件都通过系统文件选择界面进行。`@capawesome/capacitor-file-picker` 用于读取外部文件的回退路径；主要的打开、另存为、文件夹授权和私有卡库操作由本项目的 `SaveFilePlugin` 提供。

| 界面操作 | Android 行为 | 浏览器预览行为 |
| --- | --- | --- |
| 新建文件 | 新建内存中的空 `.cdb` 页签 | 相同 |
| 打开 | 系统文件选择器读取 `.cdb` | HTML 文件选择器读取 `.cdb` |
| 保存cdb | 系统“另存为”写出当前完整卡库 | 下载当前完整卡库 |
| 导出 | 系统“另存为”写出当前已加载列表的 JSON | 下载 JSON |
| 卡片详情 → 导出cdb | 系统“另存为”写出单卡 `.cdb` | 下载单卡 `.cdb` |

当前「保存cdb」不会自动覆盖最初打开的文件。Android 文件授权使用 Storage Access Framework，项目未申请宽泛的外部存储权限。

## 发布构建

需要分发给其他人时，在 Android Studio 使用 **Build → Generate Signed Bundle / APK** 创建签名 APK 或 AAB，并自行保存签名密钥。调试版由开发证书签名，不作为正式发布包。`www/manifest.webmanifest` 引用了 `icon-192.png` 和 `icon-512.png`，当前 `www/` 中没有这两个 PWA 图标；若要发布网页安装版，需先补齐资源。

## 常见问题

- **Android Studio 报 JDK / Gradle 不兼容**：检查 Gradle JDK 是否为 21；不要把 JDK 的本机绝对路径提交到仓库。
- **修改了 `www/`，手机仍显示旧界面或旧系列名**：确认运行了 `npx cap copy android`，并重新构建、安装。可对比 `www/` 与 `android/app/src/main/assets/public/` 中的对应文件。
- **更新 APK 后仍显示旧卡库**：检查是否曾在 App 内导入官方卡库；导入版本会优先于 APK 的 `cards.cdb`。
- **浏览器预览只显示示例卡**：检查是否通过 `npm start` 提供页面，以及 `www/cards.cdb` 和 `www/vendor/sql-wasm.*` 是否存在；直接打开 HTML 文件无法可靠加载这些资源。
