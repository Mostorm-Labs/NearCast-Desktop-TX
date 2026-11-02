# NearCast Desktop TX 跨平台支持设计

## 意图

发送端继续复用 Launcher 的 WebCast 配对、WebSocket 信令、WebRTC 屏幕分享和 DataChannel Touchback 流程，同时让打包和运行时行为明确支持 Windows 10/11 与 macOS 13+。

## 目标

- Windows 10/11 使用 WebView2，安装包自动下载 WebView2 Bootstrapper。
- macOS bundle 的最低系统版本为 13.0，并包含屏幕录制用途说明。
- 前端显示当前平台、WebView、屏幕分享权限和 Touchback 能力。
- Windows 保留 Pointer Injection；macOS 使用 CoreGraphics 鼠标反向控制，并提示辅助功能权限，不影响屏幕分享入口。
- GitHub Actions 在 Windows、macOS 14 Intel（部署目标 13.0）和 macOS 14 Apple Silicon runner 上执行测试与 bundle 构建。

## 非目标

- 不在 Rust 中重写 ScreenCaptureKit 或 WebRTC 采集。
- 不把 AirPlay 设备变成 WebCast 接收端，也不把 macOS 输入伪装成 Windows Pointer Injection。
- 不修改 Launcher WebCast 线协议。

## 方案

采用兼容性优先的方案：保留浏览器原生 `getDisplayMedia`，用 Tauri 原生命令返回平台能力；Windows 由 WebView2 安装策略覆盖运行时依赖，macOS 通过 `Info.plist` 和界面文案引导用户授予屏幕录制权限。macOS 的 WebKit/Wry 屏幕捕获选择器需在 macOS runner/真实设备上验收，CI 负责构建和静态回归。

## 约束与验收

- `bundle.targets` 为 `nsis`、`msi`、`app`、`dmg`。
- `bundle.macOS.minimumSystemVersion` 为 `13.0`。
- `nearcast_platform_info` 在 Windows 返回 WebView2 + Pointer Injection，在 macOS 返回 WKWebView + 鼠标 Touchback + 屏幕录制/辅助功能提示。
- `npm test` 和 Windows `cargo check` 必须通过；macOS bundle 由 GitHub Actions 构建。
