# 设置页与诊断反馈

设置入口位于左上角，与配对和投屏页面共享同一个 WebView。打开设置只切换可见视图，不刷新页面，不释放 MediaStream、WebRTC 或输入会话。返回时按当前连接状态恢复配对或投屏界面。

首页提供“输入配对码”和“查找设备”两个 Tab，默认直接输码，无需先发现设备。查找设备页点击“使用设备”直接切到输码 Tab 并显示所选设备，不使用弹窗。切换 Tab 保留设备选择；可点击“清除设备选择，直接输码”取消关联。两种方式共享受控单字符输入组件。四格使用 readonly 原生输入阻止 IME 临时编辑缓冲，由键盘与 paste 事件写入每格一个 A–Z 或 0–9，小写自动转大写；组合输入、候选提交和多字符填充均不能在格内展开。完整配对码可显式粘贴并逐格分配，退格、删除和方向键可修改。不修改系统全局输入法。

通用设置包含分辨率、动态/固定码率、码率、系统声音、反控开关及 Touch/Mouse 显式转换策略。画质和声音在下次分享时生效；反控开关立即生效；转换需点击“应用转换配置”，释放旧输入并重新协商。设置保存于本机 WebView localStorage 的 `nearhub-cast-settings-v1`，升级不清除此键；首次运行默认关闭反控，保存后沿用用户的选择。损坏或无法读取的设置回退默认值。接收端仍需独立启用反控。

macOS 在设置分类中单独提供“macOS 权限”，显示本地网络、录屏与系统录音、辅助功能的原生检测状态，并提供相应系统设置入口。打开此分类、从系统设置返回或点击“刷新状态”均重新检测。授权由用户在系统设置确认，点击入口不直接改变状态。本地网络显示的是实际组播访问检测结果，不把“网络可用”当作系统授权结论。权限面板仅在此分类内显示，不占用配对或投屏页；Windows 和尚未识别的平台不显示该分类。当前产品使用 `com.mostorm.nearhub.cast` 身份，系统权限应配置给 NearHub Cast。

检查更新页复用原有后台更新管理器，显示当前版本、构建渠道、下载状态和错误。点击检查会打开可确认安装的弹窗。设置页面在安装期间同样不可操作。安装前停止音视频并释放输入，签名、版本和缓存校验仍由 Rust 执行。测试渠道固定于构建时，不通过前端 URL 或 IPC 选择。

## Feedback

实现参照 RX `scripts/Upload-NearCastLogs.ps1`：

1. 用户填写邮箱、问题描述，并明确同意上传。
2. Rust 从日志存储生成 `diagnostics.json`，打包为 ZIP（最多 4 MiB），不接受前端任意路径、URL 或产品编号。
3. 公共 Mosapi `/v1/upload` 接收 multipart：`files` 的 filename 为 `blob`，`fileInfo` 为 `{"name":"nearhub-cast-diagnostics.zip","folder":"diagnostic"}`。
4. 取得文件 ID 后 POST `/v1/feedbacks`，将附件 ID 关联到 `content.attachments`；只有返回有效反馈 ID 才显示成功。

诊断包含版本、平台、架构及最多三个 1 MiB 轮转日志中的白名单数值指标和状态；不包含音视频、配对码、SDP/ICE、设备密钥、窗口标题或任意文件。上传失败保留表单；单次超时 90 秒，同时只允许一次提交。附件成功但反馈记录失败时，不显示成功，重试会重新上传附件。

Feedback 的应用关系由 Rust 固定选择：Windows `application.connect.id=39`、macOS `=40`。不发送 `product` 字段；更新服务的 product-id `646/647` 与 Feedback application-id 不同。客户端不携带 CI 的 `MOSAPI_TOKEN`；若公共服务不允许匿名 Feedback，需要后台提供面向客户端的受限提交机制，不把管理 token 放入安装包。

## 验证

- `node --test tests/*.test.mjs`：设置保存、异常回退、发布矩阵和签名资产约束。
- `node tests/pairing-input-browser.integration.mjs`：真实浏览器 IME 组合缓冲拒绝、每格值约束、大写输入、整码粘贴、修改及清空。
- `node tests/settings-browser.integration.mjs`：设置导航、页面返回、保存、Feedback 同意、确认编号及失败重试。
- `node tests/webcast-browser.integration.mjs`：设置页面打开时实际 RTP 视频仍持续解码，浏览器原轨道保持 live；保留音频、反控和切屏覆盖。
- `node tests/update-browser.integration.mjs`：启动提示、后台下载、暂不更新、再次打开、安装前清理与失败提示。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：真实本地 HTTP mock 检查 multipart ZIP、附件 ID、平台 application 和 HTTP 401 中止，以及原有清单/包签名和缓存篡改拒绝。

Windows CI/Mosapi/安装重启的最终验收步骤见 [发布约定](../release/version-and-mosapi.md)。macOS 本机安装与更新仍需 macOS 主机验证。

真实 Mosapi 合成报告测试已经成功，Windows Feedback 返回编号 `2729`，请求关联 `application.connect.id=39`。该测试只上传显式构造的空事件报告，不读取本机日志。可显式设置 `NEARCAST_LIVE_FEEDBACK_TEST=1` 并单独执行 ignored 的 `live_mosapi_confirms_synthetic_windows_feedback` 重现；普通 CI 不创建反馈记录。
