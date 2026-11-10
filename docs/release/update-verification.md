# TX 后台更新实现与验证

工作树：NearCast-Desktop-TX-latest；分支：codex/touchback-input-diagnostics。

## 已实现

- Windows/macOS 按固定平台 slug 查询 Mosapi 正式版本，按四段数字比较。
- 启动时恢复签名缓存并提示；运行时每四小时检查，失败退避重试。
- 自动预下载、进度、更新入口、暂不更新、本次启动内不重复弹窗。
- 签名版本清单、包大小/SHA-256/签名校验、原子缓存和安装前重验证。
- Tauri updater 安装；Windows 按 bundle 类型匹配 NSIS/MSI，macOS 按架构匹配 app 更新归档。
- 安装前结束投屏、音频、反控并确认本机输入释放；失败保留重试。
- 独立 Release workflow：Windows 与 macOS 两架构构建、签名、平台清单、聚合 ZIP、同一 GitHub Release、Mosapi 646/647，folder 546。
- 公钥入仓库，私钥位于仓库外，CI 私钥与 Mosapi token 通过 Secret 配置。

## 本地验证

提交更新/CI 时已单独导出暂存快照（不含未提交的 WASAPI 和帧率优化）：164 项 JavaScript、44 项 Rust 测试通过，6 项按仓库配置跳过；独立快照的 `cargo check --locked`、更新浏览器集成及 actionlint 通过。以下完整工作树测试数字包含媒体开发改动。

- `node --test tests/*.test.mjs`：172 项通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：46 项通过，7 项按仓库配置忽略。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- 更新浏览器集成：启动弹窗、后台下载、稍后、再次展开、安装前清理、安装失败恢复通过。
- WebRTC 浏览器回归：真实 SDP/ICE/DTLS/SCTP/RTP，连接、停止和重新分享通过（采集为合成轨道）。
- 更新签名 fixture：真实 Tauri signer 生成，验证版本、平台、架构、元数据修改与缓存篡改拒绝。
- `actionlint` 和 `git diff --check`：通过。
- Windows 实际生成 `0.1.0.2` NSIS/MSI 及 `.sig`。NSIS 文件数字版本为 `0.1.0.2`，MSI ProductVersion 为 `1.0.2`；发布脚本成功处理两种真实包。
- 生成的 Release EXE 普通启动后响应正常。
- 重新启动发现普通 Cargo 构建缺少 updater 配置导致插件初始化退出，已将公钥和 requireSignedVersion 加入基础配置；新增回归测试，重建后进程持续运行正常。
- Mosapi Windows TX 公共查询正常，测试时尚无 TX 发布记录。

## 验证限制

- 未创建 GitHub Release、推送 tag、触发远端工作流或向 Mosapi 上传测试包。
- 未对当前用户安装执行替换；NSIS/MSI 从旧 Build 升到新 Build、UAC 取消、升级后实际重启仍需实机验收。
- macOS 两架构构建、Developer ID/notarization 和真实更新依赖 macOS CI/设备，未在 Windows 上宣称通过。
- 自动审批拒绝了带 WebView2 远程调试参数启动的原生查询探测，未执行该探测；保留普通启动、浏览器集成和 Rust 验证结果。
- 构建仍有已有的 `native_capture.rs` 中 `frame` 未使用警告。
