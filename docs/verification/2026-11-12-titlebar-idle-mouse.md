# 标题栏点击后空闲鼠标移动触发断流

现场为整屏分享，接收端协商 Mouse，最后原生 SendInput 按钮事件成功。原生执行 16.8458ms，JS 往返 536.7ms，下一条无按钮 Mouse Move 等待 536.7ms 后触发 Input queue age。cleanup 7.5ms 成功，owners/contacts 清零，视频轨道 live、未 muted。关闭反控的是发送端输入队列超时路径；标题栏 Windows 模态消息循环造成回调延迟是与现场吻合的解释，尚未直接测得该次系统调用栈。

修复仅丢弃超过期限的纯空闲 Mouse Move，已提交状态必须无按钮、修饰键、Touch 或滚动；保持输入流和控制通道，继续验证后续序号。不注入过期动作、不伪造提交序号。其他事件超时行为不变。

验证：

- 216 项 JS 测试通过，覆盖延迟按钮释放后丢弃悬停、后续点击恢复，以及过期拖动/按钮释放/Touch/滚轮仍失败清理。
- Edge 完整 SDP/ICE/DataChannel/RTP 测试模拟 537ms 原生 IPC 回调延迟，反控流 active、通道保持开启、按钮释放、后续点击成功且视频继续解码。
- `scripts/test-webview-input.ps1` 通过；隔离 WebView2 自有窗口真实注入 Mouse，增加 WM_NCHITTEST=HTCAPTION 标题栏命中、按钮按下/松开及 UI 心跳恢复检查。既有 owner 竞争反馈和窗口退出检查通过。

真实接收端对用户 TX 标题栏的复测仍需新版运行后确认；不能据测试宣称所有长期标题栏拖拽停顿已解决。
