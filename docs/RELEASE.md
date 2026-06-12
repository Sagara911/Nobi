# Nobi 发版手册

> 给任何接手发版的人/智能体（Codex、Claude 等）的完整流程。照顺序执行即可。
> 当前发布渠道：GitHub Releases（自动更新依赖它）。

## 发版会自动喂到哪（下游消费方）

发一个 GitHub Release（setup.exe + latest.json）后，**两条下游全自动跟最新，无需额外操作**：

1. **装机版自动更新器** —— 读 `releases/latest/download/latest.json`，老用户启动即提示升级。
2. **Dobby 工具站的下载页**（另一个仓库 `Sagara911/Dobby` 的 `nobi.html`，线上 `dobby-aih.pages.dev/nobi.html`）
   —— 运行时调 GitHub API 取 `releases/latest`，下载按钮自动指向最新 `*-setup.exe`。**Nobi 发新版后 Dobby 那边不用动**。
   - 注意：若**改了打包格式/命名**（不再是 Tauri 默认的 `nobi_<版本>_x64-setup.exe`），要同步改 Dobby `nobi.html` 里的资产匹配正则 `/-setup\.exe$/i`，否则下载页认不出安装包。
   - Dobby `nobi.html` 还有个断网兜底直链常量 `FALLBACK_EXE` 写死了某版，偶尔需手动 bump（不影响正常 API 路径）。

## 前置认知（30 秒）

- 安装包由 NSIS 打出，**用户只需要 setup.exe 一个文件**
- 自动更新：已装的 Nobi 启动时拉取
  `https://github.com/Sagara911/Nobi/releases/latest/download/latest.json`，
  版本比本机新就提示升级；更新包用 minisign 私钥签名，应用内嵌公钥验签
- **签名私钥**：`C:\Users\huobingli\.tauri\nobi-updater.key`（已加密；密码在用户的
  密码管理器/备忘录里，构建时向用户索要或由用户注入环境变量）。
  私钥另有 GitHub 私有仓库备份，丢失本地副本时从私库恢复到上述路径即可。
  **丢钥或丢密码 = 已发布版本永远无法自动更新，只能重新分发。**

## 自动发版（推荐，一条命令）

前置（只需配一次）：仓库 Settings → Secrets and variables → Actions，添加两个 secret：
- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件内容（PowerShell 复制到剪贴板：
  `Get-Content $env:USERPROFILE\.tauri\nobi-updater.key -Raw | Set-Clipboard`）
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码（问用户要）

之后每次发版：

**第 0 步（必做）：在 `CHANGELOG.md` 最上面加本版条目**，格式 `## v0.1.X` + 几条简短 bullet。
CI 会把这一段取出来当 Release 说明 + 应用内「发现新版本」弹窗里显示的更新内容（没写就只显示
"Nobi v0.1.X"）。然后：

```bash
node scripts/release.mjs 0.1.2
```

脚本会改版本号、提交、打 v0.1.2 标签并推送；GitHub Actions
（`.github/workflows/release.yml`）随即在云端编译、签名、生成 latest.json、
创建 Release（说明取自 CHANGELOG.md 对应 `## v0.1.2` 段）。约 10-15 分钟后用户自动收到更新。
进度看仓库的 Actions 页。

## 手动发版（备用，Actions 不可用时）

### 1. 改版本号

`src-tauri/tauri.conf.json` 的 `"version"` 字段（如 `0.1.0` → `0.2.0`）。
只改这一处；「关于」菜单读的就是它（动态获取，无需另改）。

### 2. 停掉 dev（如果在跑）

`npm run tauri dev` 的 watcher 与 release 构建抢 cargo 文件锁，构建期间别开 dev、
别改 Rust 文件。已有惨案，见文末「坑」。

### 3. 签名构建（bash 执行）

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /c/Users/huobingli/.tauri/nobi-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<密钥密码，问用户要>'
npm run tauri build
```

- 必须传**密钥内容**（`$(cat ...)`），`TAURI_SIGNING_PRIVATE_KEY_PATH` 实测不生效
- 密码用**单引号**包（防特殊字符被 shell 展开）
- 成功标志：日志末尾出现 `Finished 2 updater signatures`

### 4. 生成更新清单 + 归集发布文件

```bash
node scripts/make-latest-json.mjs "本次更新说明"
```

产物自动拷到 **`release/`**（项目根目录，gitignored）：
- `nobi_<版本>_x64-setup.exe`
- `latest.json`

注意：中文更新说明经 PowerShell 命令行会乱码，要么在 bash 里跑，要么用英文，
要么生成后手工编辑 `release/latest.json` 的 `notes` 字段。

### 5. 发布 GitHub Release

手动（无 gh CLI 时）：
1. 打开 https://github.com/Sagara911/Nobi/releases/new
2. Tag 填 `v<版本>`（如 `v0.2.0`，Create new tag），标题如 `Nobi v0.2.0`
3. 上传 `release/` 里的**两个文件**
4. Publish release

有 gh CLI 时：
```bash
gh release create v<版本> release/nobi_<版本>_x64-setup.exe release/latest.json \
  --title "Nobi v<版本>" --notes "更新说明"
```

### 6. 验证

- `latest.json` 可达：
  `curl -sL https://github.com/Sagara911/Nobi/releases/latest/download/latest.json`
  应返回刚发布的版本号
- 找一台装着旧版的机器启动 Nobi，3 秒内应弹「发现新版本」；
  或本机用「帮助 → 检查更新…」手动触发
- 提交并推送版本号变更：`git add src-tauri/tauri.conf.json && git commit && git push`

## 已知的坑

| 坑 | 处置 |
|---|---|
| 构建时报 `A public key has been found, but no private key` | 第 3 步的环境变量没设上（常见于换了 shell），重新 export |
| 密码错 | 报错会明说 decrypt 失败；密码在用户备忘录，别猜 |
| setup.exe 图标看着是默认图标 | Windows 图标缓存，复制改名即可见真身；用户全新下载不受影响 |
| dev watcher 和构建抢 cargo 锁 | watcher 可能静默死掉（vite 活着但 Rust 不再重编译）。构建期不开 dev；watcher 死了就重启 `npm run tauri dev` |
| 公钥/私钥不配套 | 公钥在 `tauri.conf.json` 的 `plugins.updater.pubkey`。换过钥必须重新构建安装包再分发，否则旧安装包拒收新签名的更新 |
| 想现场看更新弹窗 | 临时把 version 改成更小的（如 0.0.9）打一个包装上，启动即提示升级；打完记得把 version 改回来 |

## 相关文件速查

- 更新逻辑（前端）：`src/App.tsx` 的 `checkUpdateAction`
- updater 配置：`src-tauri/tauri.conf.json` → `plugins.updater`
- 清单生成脚本：`scripts/make-latest-json.mjs`
- 安装器外观：`tauri.conf.json` → `bundle.windows.nsis`（图标/中文界面）
- MCP 接入脚本（随包内嵌，菜单可导出）：`scripts/nobi-mcp.mjs`
