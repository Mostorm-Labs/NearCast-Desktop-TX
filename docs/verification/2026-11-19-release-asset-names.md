# GitHub 发布文件名一致性

`0.2.0.48` 的 Windows、macOS Intel 和 Apple Silicon 均已完成构建并发布；两个 Mac 包的 Developer ID、公证票据和 Gatekeeper 验证通过。公开下载核对发现，GitHub 将 `NearHub Cast Desktop Installer-...` 中的空格转换为点号，但签名清单保留了编码空格的镜像 URL，实际访问返回 404。更新客户端从 Mosapi 的 `otaFiles` 按原始文件名解析实际 URL，因此该镜像差异不影响 Mosapi 下载；公开镜像清单仍需修正。

GitHub API 对同一资产执行原名重命名也保持点号名称，不能通过恢复空格修复。此次未覆盖已发布的包、清单或签名。

`releasePackageName` 改为 `NearHub-Cast-Desktop-Installer-...`，让本地发布文件、GitHub、Mosapi、聚合 ZIP 和签名清单具有同一 basename。安装器标题、已安装程序名及应用包名称不变。回归检查先在旧实现上失败，确认四种平台/格式的名称均不应需要 GitHub 归一化，修复后通过。完整发布重新分配 Build，并在发布后核对清单中的公开镜像 URL、包签名、哈希及 Mosapi 实际文件。

源分支的计数同步到已预留的 48，后续流水线从元数据分支继续递增，不复用 46 或覆盖 48。

参考：[GitHub Release assets API](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)。
