# Windows 本地页面来源

Windows WebView2 的主页面使用 `http://cast.nearhub.localhost/index.html`，系统选屏对话框
据此显示 `http://cast.nearhub.localhost`。它是应用内置资源的虚拟来源，不是公网域名或
LAN 服务，不新增监听端口，也不需要 DNS、hosts 修改或 TLS 证书。

`src-tauri/src/local_origin.rs` 注册 `cast.nearhub` 自定义协议。Wry 在 Windows 将
`cast.nearhub://localhost/…` 映射到上述 HTTP origin；handler 仅接受主窗口的准确 authority，
使用 Tauri asset resolver 读取内置资源，并保留 MIME/CSP。Tauri 将已注册的本地协议视为
本地 IPC 来源，不增加 remote capability 或通配远程域名权限。`.localhost` 保持浏览器
secure-context 语义，WebRTC、getDisplayMedia、Worker 和 AudioWorklet 继续使用原有通路。

`localStorage` 按 origin 隔离。Windows 启动时先短暂加载旧来源的 `settings-migration.html`，
只读取 `nearhub-cast-settings-v1`，经准确页面／窗口校验与长度检查后放入一次性原生内存，
再替换到新来源。`bootstrap.mjs` 在加载 app 之前迁移设置；已有新来源设置优先。
没有旧设置或旧数据损坏时使用原有默认设置。设备信任、更新缓存和诊断位于原生目录，
不通过页面迁移。macOS 保持原有本地来源及权限归属。

验证入口：`scripts/test-webview-input.ps1 -Fixture local-origin`。隔离的隐藏 WebView2
验证实际新 origin、secure context、native IPC、模块／Worker／音频 Worklet 和旧设置迁移；
不控制用户桌面、不打开选屏弹窗、不修改正在运行的 TX 配置。选屏 UI 的最终文案由
已安装的 WebView2 Runtime 决定，实际选屏后仍需现场核对。
