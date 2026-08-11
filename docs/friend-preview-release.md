# 朋友试用发布指南

这份流程用于把当前 DeepCreator 做成少量朋友可下载安装的预览版。默认发行版使用本地 Profile，不需要登录或账号服务；每位用户的名称、最近项目、对话和模型凭据只保存在自己的电脑上。

## 试用者会经历什么

1. 从项目的 GitHub Releases 页面下载与电脑匹配的安装包。
2. 首次打开时创建本地 Profile，并可直接填写自己的 DeepSeek API Key。
3. 如果暂时不填 Key，可以进入 `mock-agent` 演示模式；此模式不调用真实模型。
4. 进入应用后仍可在“设置 → 模型与 API”修改 Key。凭据经 Electron Main 使用系统安全存储加密，不会发送给 DeepCreator 账号服务。

GitHub Actions 的 macOS 构建项分为：

- `macOS-Apple-Silicon`：M1、M2、M3、M4 及后续 Apple 芯片 Mac。
- `macOS-Intel`：处理器为 Intel 的旧款 Mac。

公开 Release 中对应的 ZIP 文件名分别包含 `darwin-arm64` 和 `darwin-x64`；朋友应按这个架构标记选择。

Windows 试用者下载 `DeepCreator-Setup.exe`。首个朋友预览版可以暂不配置代码签名，但系统会显示来源警告：macOS 在“系统设置 → 隐私与安全”中选择“仍要打开”；Windows 在 SmartScreen 中选择“更多信息 → 仍要运行”。不要引导用户关闭系统安全功能。

## 发布者操作流程

### 1. 先做不公开的构建验收

在 GitHub Actions 手动运行 **Release** 工作流。手动运行只生成 Actions Artifacts，不会创建公开 Release：

- DeepCreator-macOS-Apple-Silicon
- DeepCreator-macOS-Intel
- DeepCreator-Windows

分别在对应系统上至少走通：安装、首次 Profile、保存 API Key、打开项目、发起一次真实模型任务、完全退出并重启。

### 2. 创建新的版本

确认验收通过后：

1. 把 `package.json` 的版本提升到新的 SemVer，例如 `0.1.1`。
2. 合并并推送代码到 `main`。
3. 创建同版本 Tag，例如 `v0.1.1`，并推送到 GitHub。
4. Tag 会触发 Release 工作流，上传 macOS 两种架构、Windows 安装包和 `SHA256SUMS.txt`，并创建公开 GitHub Release。
5. 打开 Release 页面核对文件齐全后，再把该 Release 链接发给朋友。

版本与 Tag 不一致时，工作流会主动失败。不要替换已经发布版本的文件；修复后发布新的补丁版本。

## 下载校验

Release 会生成 `SHA256SUMS.txt`。试用者可在下载目录核对文件：

macOS：

```bash
shasum -a 256 <下载的文件名>
```

Windows PowerShell：

```powershell
Get-FileHash .\DeepCreator-Setup.exe -Algorithm SHA256
```

输出应与 `SHA256SUMS.txt` 中同名文件的值一致。朋友只应使用项目官方 GitHub Releases 链接，不要转发来源不明的安装包。

## 每次发布前的验收清单

- `npm run check` 全部通过。
- 三个平台构建任务均成功，且产物名称能区分 macOS 架构。
- 新安装能显示 DeepCreator 图标和首次本地 Profile 引导。
- 填写 DeepSeek API Key 后能完成一次真实请求；跳过时明确显示为演示模式。
- 项目文件、API Key、对话没有上传到账号服务。
- Windows 安装与卸载正常；macOS 两种架构至少各由一台真实设备验证。
- Release 中包含安装文件和 `SHA256SUMS.txt`。
- 未签名期间明确告知系统警告和手动更新方式。

## 更新说明

Windows 的 Squirrel 更新素材会随 Release 一起发布。macOS 自动更新要求稳定的 Developer ID 签名；朋友预览阶段如果仍是未签名构建，应让用户从新 Release 手动下载安装新版。正式公开发布前再配置 Apple Developer ID、公证和 Windows Authenticode 签名。

Windows Release 同时提供安装版 `DeepCreator-Setup.exe` 与免安装 ZIP。安装版会在发布流水线的干净 Windows 环境中实际执行一次；如果测试用户的旧 Squirrel 安装状态损坏，可下载 ZIP，解压后直接运行其中的 `DeepCreator.exe`，本机 Profile 与项目数据仍保存在正常的用户数据目录中。
