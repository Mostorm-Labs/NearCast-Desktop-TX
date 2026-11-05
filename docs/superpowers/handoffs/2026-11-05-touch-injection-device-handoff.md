# NearCast TX 真机 Touch 注入验证 handoff

日期：2026-11-05（Asia/Shanghai）。目标：使用已通过协议联调的发送端，验证真实接收端触摸是否进入 Windows 应用，并取证坐标、释放和权限问题。

**当前结论：真实 TX/RX 进程的 Touch 协议生命周期已通过；物理触摸注入尚未验证。** 联调使用合成视频，没有发送真实触摸记录，`injectionCount=0`。

## 1. 精确代码和产物基线

| 项目 | 基线 |
| --- | --- |
| TX 仓库 | `https://github.com/Mostorm-Labs/NearCast-Desktop-TX.git` |
| TX 分支 | `codex/touchback-input-diagnostics` |
| TX 修复提交 | 包含本 handoff 的提交；交付包 `manifest.json` 中的 `sourceCommit` 和交付消息提供完整 SHA |
| RX NearCast | `d7e3721cbeb1f4701b18505c412225d44afb0477`，分支 `codex/touchback-webcast` |
| RX Axent | `d34bab2`，分支 `codex/nearcast-touchback-axtp-v018` |
| RX AXTP Runtime | `1bfcfa8`，分支 `codex/touchback-input-stream` |
| AXTP Hello | `0.18.0-dev.041e48592d85` |
| 已联调 TX EXE | `nearcast_desktop_tx.exe`，Windows x64 Debug，应用版本 `0.1.0` |
| EXE SHA256 | `85958CF6DDE80C6865BFDA2273E32EBFD7A87ED0E3C6416F63FD3EABCE745B2A` |

应用版本 `0.1.0` 无法区分旧程序和本修复，必须核对提交和产物指纹。EXE 不保存在 Git 中；使用交付 ZIP 中的已验证 EXE，或从精确提交自行构建。重建产物可能因构建路径、工具链不同而具有不同指纹，应重新记录，不能冒用上表的已验证 EXE 指纹。

本修复包含 canonical 大端 BIND、receiver-owned `input.openStream` 请求到结果的协商、完整 target/runtime/token fence、协商上限、命令重放和 reset-close-open，以及必要的界面诊断。未增加 Windows Mouse 注入、提权 Agent、模式切换 UI 或系统音频功能。旧工作树中的其他功能不属于本交付。

## 2. 已有证据和适用边界

- 131 项 Node 测试通过，包含独立 RX C++ 编码器生成的 BIND golden fixture。
- `cargo check --locked`、`cargo build --locked`、`git diff --check` 通过；6 个变更的运行模块与 `src/dist` 哈希一致。
- Edge 视频集成与真实 DTLS/SCTP DataChannel 重放通过。
- 新 TX EXE 与真实 RX 进程完成：BIND accepted → Touch active(epoch 2) → reset/close 到 bound(epoch 3) → Touch active(epoch 3) → reset/close 到 bound(epoch 4)。两次 open、两次 close、两次 reset 均成功，`binaryRejected=0`，视频会话保持 mediaActive。
- 发送端 `injectionCount=0`，因此这些结果只证明协议链路，不能代替本 handoff 的物理触摸验收。

可携带的协议摘要见 [验证摘要](../../verification/2026-11-05-touchback-protocol-lifecycle.json)。完整原始证据由原联调机保留，交付包也携带本次生命周期摘要；不要将过期 sessionId、配对码、PID 或 target 直接用于真机测试。

## 3. 真机运行或构建

### 使用交付 EXE

1. 在 Windows 10/11 x64 发送端确认已安装 WebView2 Runtime。发送端包不需要接收端的 GStreamer SDK/DLL；RX 依赖遵循 RX 会话的独立 handoff。
2. 解压交付 ZIP 到新目录，在该目录核对：

   ```powershell
   Get-FileHash .\nearcast_desktop_tx.exe -Algorithm SHA256
   Get-Content .\manifest.json
   ```

3. 关闭旧 TX 测试实例，双击当前 EXE，先以普通权限运行。程序已内置页面；不需要复制本机的 `src`、`dist` 或 WebView2 用户数据目录。
4. 本轮使用正常系统选屏，不启用合成视频脚本、不执行 `tx-joint-setup.js`。已交付 EXE 没有内置合成采集替换；此前的临时脚本已通过页面重载清除。

### 从远端构建

需要 Git、Node.js、Rust stable MSVC、Visual Studio C++ Build Tools 和 Windows SDK。测试机只运行预编译 EXE 时不需要 Rust/Node/VS。本次本机构建使用 Node `20.17.0`、Rust/Cargo `1.96.1`。

```powershell
git clone --branch codex/touchback-input-diagnostics --single-branch https://github.com/Mostorm-Labs/NearCast-Desktop-TX.git NearCast-Desktop-TX
Set-Location NearCast-Desktop-TX
git rev-parse HEAD
# 应与交付 manifest.json 的 sourceCommit 一致；需要时 checkout 该完整 SHA。
node --test tests
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo build --locked --manifest-path src-tauri/Cargo.toml
.\src-tauri\target\debug\nearcast_desktop_tx.exe
```

JavaScript 单元测试不要求安装额外 npm 依赖。若另行构建 Release，使用 `cargo build --release --locked --manifest-path src-tauri/Cargo.toml` 并记录新 EXE 指纹；Release 不是上表已验证的那份 Debug EXE。不要将原开发机的代理地址复制成真机运行依赖。

## 4. Touch 注入前提

- RX 使用上述兼容基线，真实触摸屏/输入设备由 RX 捕获，目标为本次 WebCast 的已呈现画面。
- 重新读取现场接收端配对码，建立新会话。发送端选择整个主屏幕；首次基准测试采用单显示器、100% 缩放，并记录两端分辨率和 DPI。窗口/副屏捕获映射尚未验收。
- 接收端选择 Touch，确保 receiverOptIn 和 controllerRequested 均开启，观测到 `phase=active`、`effectiveEnabled=true`、`negotiatedMode=touch`。请求 code 0/accepted 或 BIND accepted 单独都不能作为 active 证据。
- Windows 本机路径为 `InitializeTouchInjection/InjectTouchInput`，最多协商 10 contacts。普通权限 TX 先控制普通权限窗口；Windows Mouse required 不属于本验证。
- 本版本没有 UIAccess/提权 Agent。高权限普通窗口应单独做管理员 TX 对照，由现场人员处理 UAC；UAC 安全桌面、锁屏、登录界面不属于支持范围。不要用高权限窗口作为普通窗口基准测试的替代。

## 5. 实测顺序和通过标准

1. **建立协议基线。** 连接并分享主屏幕，RX 开启 Touch。保存 RX active 状态及 TX 诊断；TX 应 `controlChannelReady=true`、`nativeReady=true`、`bindingReady=true`、`control.streamState=active`。
2. **单点与坐标。** 在发送端打开普通权限的应用或测试页，准备中心、四角附近的大按钮/点击目标；在 RX 的投屏画面上实际触摸这些位置。记录系统实际响应及偏移方向，确认 TX 的 `lastBinary.status=applied`、packet sequence 和 `injectionCount` 增长。记录条数不等于点击次数，DOWN/MOVE/UP 都可能计数。
3. **移动与释放。** 在支持触控拖动或画线的普通应用中持续移动，再抬手；重复点击/移动/抬手至少 10 轮。确认目标应用响应、抬手后不继续拖动、`lastInjectionStatus=accepted`，且没有新增 `lastInjectionFailure`。仅计数增长但应用没有响应不能判定通过。
4. **关闭与重开。** 一次正常关闭后重新开启 Touch，保存更高 epoch 的 active 状态。再受控验证按住/拖动时关闭反控，确认接触释放、无粘手，重新开启后旧帧不复活。确认投屏保持正常。
5. **权限对照。** 普通窗口通过后，再记录高权限普通窗口的表现；如有必要，人工以管理员权限启动同一 SHA 的 TX 重测。区分权限变化与协议/坐标错误，不把 UAC 安全桌面纳入通过标准。
6. **结束。** 关闭反控、离开接收端，确认无持续输入，并保存两端诊断。DPI 125%/150%、多显示器和更多 contacts 可在基准通过后单独记录，不能用它们替代主屏幕基准结果。

## 6. 诊断和故障分流

在 TX 投屏页展开“反控收包诊断”并复制 JSON。Debug 版也可打开 DevTools 执行：

```js
JSON.stringify(globalThis.__nearcastTouchbackDiagnostics(), null, 2)
```

| 观察 | 下一步取证 |
| --- | --- |
| `controlChannelReady=false` | 排查配对、WebSocket/WebRTC/DataChannel；先恢复连接 |
| `nativeReady=false` | 记录本机初始化状态、系统版本及应用错误 |
| `bindingReady=false` 或 BIND `invalid_state` | 核对 TX/RX 提交、EXE 指纹及 binaryRejected，避免运行旧 EXE |
| 已 active，触摸后没有新的普通 binary | 检查 RX 实际触摸捕获、目标路由和 gate |
| `lastBinary.status=applied`，但 injectionCount 不增长/出现失败 | 保存 `lastInjectionStatus` 和 `lastInjectionFailure`，定位本机队列/注入 |
| injectionCount 增长且 accepted，应用无响应或位置偏移 | 记录前台窗口完整性、主屏幕/DPI/捕获区域及焦点；做普通窗口与管理员窗口对照 |

必须记录：TX commit/EXE SHA256、RX/Axent/Runtime 版本、Windows 版本、普通/管理员启动、显示器与 DPI、捕获类型、目标应用权限、RX active 状态、每步 TX 诊断、可见响应及失败复现步骤。原生失败的 error 字符串可能包含 `windows_inject_touch_input_failed:0x...`，按原样保留，不只写“没反应”。当前诊断没有自动报告 senderIntegrityLevel/inputDesktop 等提权 Agent 设计字段，需由现场补充环境说明。

TX 最近 32 条文本控制消息与二进制计数分开保存；无需普通帧应用 ACK。`receiverEnabled=null` 是预期值，接收端 gate 应通过 RX 状态核对。关闭后没有实际粘手的可见确认仍是必须项。

## 7. 交回结果模板

```text
TX sourceCommit / EXE SHA256:
RX / Axent / Runtime:
Windows / 权限 / 分辨率 / DPI / 捕获类型:
RX active: phase / effectiveEnabled / negotiatedMode / streamId / epoch:
TX 开始前、单点后、拖动抬手后、关闭重开后的诊断文件:
可见点击/移动/抬手响应与坐标偏差:
关闭后有无粘手，重开 epoch:
普通窗口与高权限普通窗口对照:
结论: 未执行 / 通过 / 失败（附复现步骤）
```

只有现场实际触摸、可见应用响应和可靠释放同时成立，才可将“物理 Touch 注入”标记为通过。本 handoff 交付时该项仍为**未执行**。
