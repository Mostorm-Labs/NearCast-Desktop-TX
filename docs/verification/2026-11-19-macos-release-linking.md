# macOS Release 可用性检查链接依赖

## 失败证据

[Release TX 44504818671](https://github.com/Mostorm-Labs/NearCast-Desktop-TX/actions/runs/44504818671) 为 `79a1d5f` 分配 `0.2.0.46`。Windows 构建通过，macOS ARM64 在 Release 链接阶段失败，尚未进入 Apple 签名；没有发布该版本。

CI 使用 Rust `1.100.0`、最低 macOS `13.0` 和 ThinLTO。链接器报告 `___isPlatformVersionAtLeast` 未定义，引用来自本地网络及 Core Audio 的 Objective-C `@available` 检查。Clang 在编译原生文件时生成该调用，Rust 的 `-nodefaultlibs` 链接未自动补入 Clang 的运行库。Debug 单元测试通过不能证明 Release 链接依赖完整。

## 最小复现与修复

本机安装与 CI 相同的 Rust `1.100.0`，不改变默认 Rust 工具链。以 `-mmacosx-version-min=13.0 -O3` 编译生产 `macos_core_audio.m`，打入静态库，由一个调用 `nearcast_core_audio_available` 的 Rust 程序链接：

- `opt-level=3`、`lto=thin`、`codegen-units=1` 时复现相同未定义符号，退出码 1。
- 同一原生对象、Rust 程序和优化配置，增加 Clang 的 `libclang_rt.osx.a` 后链接成功，执行真实可用性检查返回 1。

`build.rs` 通过 cc-rs 选中的编译器查询 `-print-file-name=libclang_rt.osx.a`，检查查询成功且文件存在，再添加运行库搜索路径和静态链接依赖。未硬编码 Xcode 安装路径，未自行实现系统版本检测，最低 macOS 要求保持 13.0。

修复后的本地完整 JavaScript 测试 309 项通过；Rust 1.100.0 完整测试 62 项通过、4 项忽略。正式 Release 构建、签名和公证继续由新的 CI Build 验证，不复用或覆盖 46 号发布资产。

参考：[Rust 对 Objective-C 可用性 ABI 与 Clang 运行库的说明](https://github.com/rust-lang/rust/blob/main/library/std/src/sys/platform_version/darwin/public_extern.rs)、[LLVM 运行时实现](https://github.com/llvm/llvm-project/blob/llvmorg-20.1.0/compiler-rt/lib/builtins/os_version_check.c)。

后续 `0.2.0.48` 和 `0.2.0.50` 的 Intel / Apple Silicon Release 链接及公证均通过，正式产物检查见 [发布验收记录](2026-11-19-tx-stable-release.md)。
