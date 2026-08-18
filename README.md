# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成 **Windows 桌面应用**。

普通用户**不需要安装 Node.js、不需要命令行**，双击安装、双击启动，就能使用完整的 Harness。

## ✨ 特性

- 🖥️ **开箱即用**：内置 Node.js 运行时与 Harness 服务（`@deepseek-ai/dsh`），无需任何开发环境
- 🚀 **自动启动本地服务**：启动应用后自动拉起 Harness（127.0.0.1:3080），就绪后自动打开界面
- 🎨 **鲸鱼娘主题**：应用图标、安装器图标、托盘图标、启动页主题背景，四件套独立设计（Docker 风格圆角化）
- 🐋 **内置鲸鱼娘皮肤**：安装包自带"深海女仆工坊"界面皮肤，首次启动自动部署，开盒即用（来源标注见下文）
- 📌 **系统托盘**：关闭窗口最小化到托盘，托盘菜单支持打开 / 启动 / 停止 / 重启 / 状态显示 / 退出
- 🛡️ **稳定性保障**：
  - 看门狗防残留（Electron 被强杀时自动清理 Harness 进程树）
  - 崩溃自动恢复（服务异常退出后 2s/4s/6s 退避重试，失败弹窗提示）
  - 端口身份校验（3080 被其他程序占用时明确报错，不误挂他人服务）
  - 单实例锁（重复启动只聚焦已有窗口并弹窗提示）
- 🔒 **安全加固**：`contextIsolation` + 沙箱 + preload 最小桥接、权限白名单、导航白名单、外链协议校验
- 📦 **版本化发布**：一条命令自动升版本 + 打包，`dist\<版本>\` 独立归档互不覆盖

## 🏗️ 架构

```
Windows 用户
   ↓ 双击
DeepSeek-Harness.exe（Electron 主进程）
   ├─ 创建窗口 → 显示主题启动页
   ├─ 启动内置 node.exe → watchdog.js → dsh web
   ├─ 监听 127.0.0.1:3080（Harness 本地服务）
   ├─ 服务就绪 → 窗口切换到 Harness Web UI
   └─ 系统托盘（隐藏/启动/停止/重启/退出）
```

Electron 只负责桌面生命周期；Harness 负责核心业务；两者通过本地 HTTP 通信，完全解耦。

## 📥 下载

**安装包**：见 [Releases](../../releases)（`DeepSeek-Harness-Desktop-<版本>-Setup.exe`）

- 支持 Windows 11 / Windows 10 x64
- 安装包未签名，SmartScreen 提示时选择「更多信息 → 仍要运行」
- 覆盖安装即可升级，用户数据（API Key、会话）保存在 `%USERPROFILE%\.dsh` 与 `%APPDATA%\deepseek-harness-desktop`，升级/重装不丢失

## 🛠️ 开发与打包

环境要求：Node.js ≥ 20（仅开发/打包需要）

```bash
# 1. 安装依赖
npm install

# 2. 准备内置运行时（harness-runtime 目录）
#    把 Windows x64 版 node.exe 放到 harness-runtime\node.exe
cd harness-runtime
npm install        # 安装 @deepseek-ai/dsh（版本见 package.json）

# 3. 开发模式启动
cd ..
npm start

# 4. 打包（输出到 dist\<版本>\）
npm run build

# 5. 版本化发布（自动升版本 + 打包）
npm run release:patch    # 普通改动：2.0.3 → 2.0.4
npm run release:minor    # 较大变更：2.0.3 → 2.1.0
npm run release:major    # 特大变动：2.0.3 → 3.0.0
```

打包配置集中在 `package.json` 的 `build` 字段（唯一来源）；`build.js` 只负责精简运行时、注入 `resources\harness` 与构建后自动清理旧版中间产物。

## 📁 目录结构

```
├── main.js                 # Electron 主进程（窗口/托盘/服务生命周期/看门狗/自恢复）
├── preload.js              # contextBridge 最小桥接
├── index.html              # 主题启动页（鲸鱼娘主题背景）
├── build.js                # 打包编排（精简运行时 + afterPack + 旧产物清理）
├── package.json            # 版本、脚本与 electron-builder 配置（唯一来源）
├── icon.ico                # 应用图标（多尺寸）
├── installer-icon.ico      # 安装器/卸载器图标
├── tray.png                # 托盘图标（32×32）
├── theme-bg.png            # 启动页背景（模糊化）
├── theme-emblem.png        # 启动页圆角徽章
├── icon-design/            # 图标工程（源图/生成脚本/备份/预览）
├── 项目说明书.md           # 目录导航说明书（每个文件/文件夹的作用）
└── harness-runtime/        # 内置运行时（git 忽略，按上文步骤重建）
```

## 📝 版本历史

| 版本 | 主要变更 |
|---|---|
| 2.0.12 | 皮肤部署双保险 + 落盘校验 + 启动自愈 |
| 2.0.11 | 修复新机器皮肤部署缺失文件导致的启动崩溃 |
| 2.0.10 | 失败弹窗「复制日志」按钮 |
| 2.0.9 | 黑匣子文件日志 |
| 2.0.8 | 内置鲸鱼娘皮肤（开盒即用）、窗口标题带版本号、皮肤来源标注 |
| 2.0.7 | 窗口标题固定为 DeepSeek Harness Desktop v版本号 |
| 2.0.6 | 托盘图标改为鲸鱼娘立绘（01 伸手眨眼版） |
| 2.0.5 | 托盘图标改为极简矢量鲸鱼娘 |
| 2.0.4 | 全新鲸鱼娘图标四件套 + 主题启动页 |
| 2.0.3 | 打包配置收敛、看门狗、崩溃自恢复、端口校验、单实例、安全加固 |
| 2.0.1 | 托盘与生命周期完善 |
| 2.0.0 | 内置 Node 运行时架构 |
| 1.2.0 / 1.0.0 | 早期版本 |

## 🐋 鲸鱼娘皮肤（内置，开盒即用）

"深海女仆工坊"皮肤来自第三方开源项目 [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)。**自 v2.0.8 起皮肤已内置进安装包**：首次启动时自动部署到用户配置，无需安装 pnpm、无需任何手动操作（若用户自定义过 dsh 配置则自动跳过，尊重用户设置）。

源码构建时如需包含皮肤，把 `maid-atelier` 目录复制到 `harness-runtime\node_modules\@dsh-external\dsh-client-ui-skin-maid-atelier` 即可；手动安装方式：

```powershell
# 1. 克隆皮肤仓库
git clone https://github.com/Small-tailqwq/dsh-deep-whale

# 2. 安装皮肤子包（dsh 不在 PATH 时用内置运行时完整路径）
& "harness-runtime\node.exe" "harness-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add <克隆目录>\maid-atelier

# 3. 重启 Harness 生效
```

**来源与许可**：

| 项目 | 说明 |
|---|---|
| 皮肤项目 | [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) · 作者 Small-tailqwq · **CC BY-NC-SA 4.0**（署名-非商业-相同方式共享） |
| 角色原画 | 上善（[Pixiv](https://www.pixiv.net/users/62155430) · [Bilibili](https://b23.tv/8h5L4xz)） |
| 二次设计 | ZipZipPipe（[Pixiv](https://www.pixiv.net/users/18604994) · [Bilibili](https://b23.tv/Pnw6nG8)） |
| 皮肤脚手架 | [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) |

## 📄 License

[MIT](LICENSE)

本项目的鲸鱼娘角色插画由 AI 生成；Harness 本身版权归 [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) 及其许可方所有。
