# NearHub Cast 0.2.0.50 正式发布验收

- 发布代码：`5863bf909a2e924c0d8bdf65106da3c393a9c324`，包含指定的 `62f1ffeeeac61eb33d2a1d7e8caffafaa96e5899`、macOS 音频选屏修复、Clang 运行库链接及公开文件名修复。
- [Release TX #44510228292](https://github.com/Mostorm-Labs/NearCast-Desktop-TX/actions/runs/44510228292) 全部通过；[GitHub 正式版本](https://github.com/Mostorm-Labs/NearCast-Desktop-TX/releases/tag/v0.2.0.50) 于 2026-11-19 11:24:13 UTC 发布，非 draft、非 prerelease，已设为 latest。
- 第一次 ARM 任务因未取得托管 runner，被 GitHub 在排队 15 分钟后取消，未开始编译。仅重试该 job 及其依赖发布任务，复用同一次预留的 Build 50 和已完成的 Windows / Intel 产物；版本任务未重新分配计数。
- 源分支计数同步到 CI 已预留的 50；本次记录、检查及同步不分配新编号。

## 产物与原生版本

| 平台 | 架构 | 产物 | 版本核对 |
| --- | --- | --- | --- |
| Windows | x86_64 | NSIS、MSI | 清单与更新签名均为 `0.2.0.50`；NSIS PE 版本资源的 FileVersion 为 `0.2.0.50` |
| macOS | aarch64 | `.app.tar.gz` | 解包后仅含 arm64；CFBundleShortVersionString=`0.2.0+50`、CFBundleVersion=`50` |
| macOS | x86_64 | `.app.tar.gz` | 解包后仅含 x86_64；CFBundleShortVersionString=`0.2.0+50`、CFBundleVersion=`50` |

两个 Mac 包的 LSMinimumSystemVersion 均为 `13.0`，主程序路径为 `NearHub Cast.app/Contents/MacOS/NearHub Cast`。分别提供架构包，不是单个 Universal 包。MSI 构建配置按约定映射为 `1.0.50`。

## 签名、公证与公开下载

- 本地完整 JavaScript 测试 **310 项通过**，Rust 1.100.0 完整测试 **62 项通过、4 项忽略**；CI Windows、Intel 和 ARM 平台测试及打包均通过。
- 两种 Mac 包均使用 `Developer ID Application: SUZHOU AUDITORYWORKS CO.,LTD (8C2WJTL66R)`，启用 Hardened Runtime。
- Intel 公证 Accepted：`9aa6b6c1-f148-4835-ab05-ab063153cd01`；ARM 公证 Accepted：`73f2bc26-64b1-40a2-80b2-5c0bd1d40891`。
- 公开下载后，对归档内 `.app` 再次执行 codesign deep / strict、身份与 Team 核对、stapler validate 和 Gatekeeper assess，两个架构全部通过。
- 直接从两份签名清单中的四个 GitHub URL 下载全部安装/更新包，文件名与 GitHub 实际名称一致；使用仓库 `src-tauri/update.pub` 校验版本绑定的包签名和清单签名，并核对长度及 SHA-256。
- GitHub 共 **20 个独立资产**：两个平台各 9 个文件，以及聚合 ZIP 和其 SHA-256。ZIP 结构、全部 18 个成员及其字节与独立资产一致。
- 使用公共 Mosapi 查询入口，按返回的 `otaFiles.file` HTTPS URL 实际下载全部 18 个文件，字节与已验证的 GitHub 文件一致，未使用管理 token 查询或下载。

| Mosapi 产品 | update-id | version | state / type | 文件数 |
| --- | --- | --- | --- | --- |
| nearcast-tx-windows / 646 | 9364 | 0.2.0.50 | release / optional | 9 |
| nearcast-tx-macos / 647 | 9365 | 0.2.0.50 | release / optional | 9 |

`0.2.0.46` 未发布；`0.2.0.48` 保留原资产和记录，`0.2.0.50` 修正 GitHub 镜像文件名差异后作为更新版本发布，未覆盖旧版本的包、清单或签名。

## 验收范围

当前最低 macOS 为 13，不声明支持 10.x。macOS 14.2 及以上使用 Core Audio Tap；13–14.1 的 ScreenCaptureKit 音频兼容后端尚未完成连续有声投屏实机验收。用户对同进程连续三轮有声投屏的确认及系统日志证据见 [选屏修复记录](2026-11-19-macos-picker-reselection.md)。本轮发布没有在 Windows 执行新的人工安装、跨 Build 安装或自动重启验收；CI 打包、原生版本与公开文件完整性检查不替代这些安装测试。

原始下载、CLI 校验输出和公开元数据仅保存在本机 `/tmp/nearcast-release-0.2.0.50`、`/tmp/nearcast-release-50-verification.log` 和 `/tmp/nearcast-release-50-mosapi.log`。未提交凭据、私钥或原始音频/屏幕内容。
