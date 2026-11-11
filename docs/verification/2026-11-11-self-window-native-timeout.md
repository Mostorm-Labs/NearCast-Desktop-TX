# 点击 TX 自身窗口后的原生调用超时

现场运行 Release 候选（2026-11-11 构建，SHA-256
3774EF8B1E872F0FCB8CC6A213EBFD219694DD694EBA2A28FFE2069FDF117A8E）。
用户确认 RX 点击的是 TX 自己的窗口，TX UI 随之卡住。

## 已有证据

- RX 开流仅请求 Mouse，共收到 4 包、成功提交 1 包；队列峰值 2、最大队列等待约 22.7ms。
- 错误为 TIMEOUT: Native operation timed out，触发 3 秒本机操作期限；不是 250ms 队列期限。
- 原生调用最终返回 submitted，release 最终返回 released，但 cleanupMs 达到约 37156.8ms。
  该值包含等待未完成原生调用，不能当作纯 reset 执行时间。
- 音频同期出现大量 discontinuity/underrun，符合运行中存在较长停顿，但不能据此定位卡点。
- 故障恢复后采集的线程栈中 main 已回到 GetMessage，不能还原当时是否卡在 SendInput、
  EnumDisplaySettings、owner mutex 或 WebView IPC。没有获得足以确认唯一根因的卡住现场栈。

## 修正与诊断

- Windows nearcast_input_feedback 从同步 Tauri 命令改成 async + spawn_blocking，避免
  UI 在等待 native OWNER 时阻塞自己的 Win32 消息循环。
- Windows CloseRequested 先 prevent_close，由 worker 清理输入/绑定/音频后 destroy；
  在 SendInput 指向自身窗口时 UI 仍能泵消息。实际 RunEvent::Exit 保留最终清理。
- input_execution_status 使用独立短锁 try_lock，不读取 owner、不等待 Win32 注入。
  nativeInput.nativeExecution 显示当前 apply/release 阶段、工作线程 ID、阶段/总耗时，
  以及最近一次 >=250ms 慢调用的 slowestPhase；慢记录不会被普通 release 覆盖。
- 阶段覆盖 owner_lock、capture_geometry、EnumDisplayMonitors/EnumDisplaySettings、
  display_binding、mouse DPI/物理键查询、virtual_desktop、send_input、inject_touch。
- JS 每秒更新该信息，lastSubmission 额外保存 nativeDurationMs；未放宽任何超时，
  未绕过输入清理，未新增提权或外部 Agent。

当前修正确认消除了 UI 等待输入锁的两个入口，但原现场 TX 默认 native/native，
不会主动定时发手势 halo；因此不能把反馈锁竞争单独当作该现场的已确认唯一根因。

## 回归

- 210 项 JavaScript、53 项 Rust 普通测试及 cargo check 通过。
- 浏览器投屏、持续滚轮背压、Touch/Mouse 切换和更新界面回归通过。
- 显式真实 WebView2 fixture：自有页面实际收到 SendInput Down/Up，页面触发生产反馈命令；
  另外强制 worker 占用 OWNER，反馈调用期间页面 heartbeat 仍可到达；关闭窗口期间
  OWNER 仍忙时 heartbeat 仍可到达，释放锁后窗口按顺序销毁。测试通过。
- fixture 只向自己创建的页面注入，恢复原光标和前台；没有在用户投屏会话中注入。
- opt-in feature 不影响默认包体，独立测试 EXE 需要 common-controls v6 manifest。
  测试脚本只为生成的 fixture 二进制写入该资源，不改变应用 manifest/权限：

```powershell
./scripts/test-webview-input.ps1
```

真实 RX 点击 TX 页面复测尚未完成。若候选版仍有长停顿，应检查
nativeInput.nativeExecution.lastSlowCall.slowestPhase，再针对明确卡点修复；
不能宣称目前已证明解决所有自身窗口卡顿。
