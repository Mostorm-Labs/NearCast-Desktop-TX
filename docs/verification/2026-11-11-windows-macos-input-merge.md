# Windows/macOS 输入合并验证

## 合并范围

本地 `main` 从 `ad5b455933828200350ed1457b84563be4aa4097` 快进到
`origin/codex/macos-input-control` 的 `60dae33`，纳入 21 个提交。主分支是目标
分支的祖先，没有文本冲突；保留目标分支的 typed 输入、浏览器采集、独立音频、
设备发现、更新模块及 macOS 权限和手势实现。

集成检查发现目标分支的 Windows 原生层仍仅声明 Touch，无法启用原生 Mouse
以及 Touch→Mouse 手势。此次补齐 Windows typed Mouse，经同一随机 owner、
lease、来源和几何 revision 校验后调用 SendInput，不恢复旧无 owner 命令。
AXTP 生成合同及 wire 格式保持合并分支原值。

## 当前路由

| 收到的输入/策略 | Windows | macOS |
| --- | --- | --- |
| 原生 Touch | InjectTouchInput，最多 10 点；初始化成功才声明 | 不支持原生 Touch |
| 原生 Mouse | SendInput | CGEventPost，需辅助功能权限 |
| Touch→点击拖拽 / 点击滚动 / 组合手势 | 支持 | 支持 |
| 长按或双指右键 | Touch→Mouse 组合手势 | Touch→Mouse 组合手势 |
| 捏合缩放 | 显式 Ctrl＋滚轮 | Command＋/− 或显式 Ctrl＋滚轮 |
| Mouse→Touch | 仅左键单点生命周期 | 不支持原生 Touch，选项禁用 |
| 禁用单一收到的类型 | 支持 | 支持 |

Mouse 能力为单独左/右/中键、移动、拖拽、Shift/Ctrl/Alt/Meta、横纵滚轮、
detent120 与 regionQ16_16 连续滚动。不协商多按钮组合或未定义的键盘/触笔记录。
Windows 支持已校准的主/副屏和负坐标；macOS 保留单主屏限制。窗口仍仅投屏。
桌面手势光圈保留 macOS 实现，Windows 暂不绘制光圈。

## 清理与隔离

- Touch 和 Mouse 共用既有串行执行链和原生 owner；跨类型重叠输入拒绝并清理。
- Mouse 仅持有修饰键时同样视为活动输入，阻止 Touch 穿入。
- Ctrl＋滚轮转换紧接本机 modifier-only 释放动作，不让 Ctrl 滞留到下一帧。
- SendInput 部分提交按每个事件记录已提交前缀；清理失败保留 owner 和已按下状态，
  禁止新输入，等待明确释放成功。已由本机用户按住的修饰键不取得所有权。
- Windows Mouse 在物理像素 DPI 上下文中映射完整虚拟桌面，使用 VIRTUALDESK；
  来源边界仍由现有显示绑定校验。未加入提权或 UIAccess。

## 本机证据

- 合并基线：198 项 JavaScript、40 项 Rust 单元测试通过。
- 集成后 JavaScript：202 项通过，含 src/dist 一致性、双类型能力、转换、旧帧隔离、
  清理失败、组合手势、Ctrl 释放和跨类型修饰键隔离。
- 集成后 Rust：49 项通过，5 项默认忽略；忽略项为局域网、桌面标记、
  Touch/Mouse 实际注入及系统音频等显式设备测试。
- 显式执行 Windows typed Mouse 自有窗口测试：通过。测试窗口位于 DISPLAY2，
  坐标为负的副屏；实际收到左/右键、拖拽、Ctrl 点击、横纵和连续滚动，
  owner 释放后收到按钮释放且 Ctrl 不再按下。测试恢复鼠标位置与此前前台窗口。
- 显式执行既有 Windows typed Touch 自有窗口测试：通过；Down/Move/Up 与取消清理，
  窗口收到 2 次按下和 2 次释放。
- Edge 浏览器集成：通过。真实 H.264/Opus、SDP/ICE/DTLS/SCTP/RTP，覆盖原视频轨道、
  音频、多屏校准、副屏负坐标、布局失效和重选；采集与原生 IPC 使用 fixture。
- 更新界面浏览器集成：通过启动提示、后台下载、稍后处理、重新打开、清理及安装错误场景。
- Windows `cargo check --locked` 与 Debug 构建通过；产物为
  `src-tauri/target/debug/nearcast_desktop_tx.exe`。未构建或发布安装包。

## 尚未重新验收的范围

当前执行环境为 Windows，不能在本机重新构建或执行 macOS AppKit/CoreGraphics。
目标分支已保存 macOS 签名构建及操作者现场验收记录，详见
[右键配置验证](2026-11-11-right-click-configuration.json)，这些属于合并前证据。
合并后的 macOS Intel/Apple Silicon 构建需运行已有 CI，不能把 Windows 上的纯逻辑测试
作为新的 macOS 设备验收。

真实 NearCast 接收端到当前合并客户端的整链路、高权限窗口、多 DPI 设备和
长时间反控仍需现场验证；自有窗口 SendInput 成功不代表绕过 Windows UIPI。
