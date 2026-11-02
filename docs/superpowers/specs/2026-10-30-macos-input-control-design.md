# macOS 反向控制设计

## 意图

让 NearCast Desktop TX 在 macOS 13+ 上接收现有 Launcher-compatible Touchback 控制帧，并把可表达的控制转换为 macOS 鼠标/键盘事件。发送端继续使用现有 WebRTC DataChannel 和 Touchback 帧，不另起 WebSocket 或媒体通道。

## 目标

- macOS 支持鼠标移动、左/右/中键按下与释放、拖拽，以及协议已有的修饰键字段。
- 当前 Touchback record 没有独立键码或滚轮增量字段，因此键盘和滚轮等待版本化协议扩展。
- 通过 CoreGraphics `CGEvent` 注入系统事件；首次注入前检查辅助功能权限。
- 权限不足时返回明确的 `not_authorized`，撤销会话时释放所有按键/鼠标按钮状态。
- UI 显示“macOS 鼠标反向控制；键盘和滚轮等待协议扩展”，并明确多指触控暂不支持。
- Windows 继续使用现有 Pointer Injection；AirPlay 继续不授权 Touchback。

## 非目标

- 不实现 macOS 虚拟 HID/DriverKit 系统扩展。
- 不把多指触摸伪装成多个鼠标指针。
- 不改变 Launcher WebCast 配对、信令、WebRTC 或 Touchback 帧头和序列规则。

## 方案

保留 `WebCastTouchbackSender` 和 `LauncherCompatibleWebCastSender` 的会话/校验逻辑，把原生注入桥抽象为平台 sink。Windows sink 仍调用 `nearcast_pointer_*` 的 Pointer Injection；macOS sink 调用独立的 Tauri 命令，在 Rust 的 `cfg(target_os = "macos")` 分支中使用 CoreGraphics：移动和按钮使用 `CGEventCreateMouseEvent`，修饰键映射到鼠标事件 flags。命令只接受已通过 Touchback binding 的记录，并在 fence/reset 时清理活动按钮。未知 record flags、组合按钮和第二触点返回 `not_supported`/`invalid_state`，不会猜测成滚轮或键盘。

## 权限与安全

- macOS `Info.plist` 增加辅助功能用途说明；应用不自动绕过 TCC，也不伪造授权成功。
- 原生层在注入前通过系统可用的辅助功能检查；未授权时返回 `not_authorized`，UI 引导用户到“系统设置 → 隐私与安全性 → 辅助功能”。
- 不支持的多指记录返回 `not_supported`，不会降级成鼠标点击。
- 继续要求 WebCast receiver、显式 binding 和 Touchback capability；AirPlay 不进入输入 sink。

## 验收

- JavaScript 测试覆盖 macOS capability 文案、权限失败、顺序注入、reset/fence 和多指拒绝。
- Windows Rust 测试确认原有 Pointer Injection 分支不变；macOS Rust 编译/测试由 macOS CI 验证。
- GitHub Actions 增加 macOS x86_64 与 arm64 构建检查；真实鼠标/键盘和 TCC 权限需要在 macOS 13+ 设备上手工验收。
