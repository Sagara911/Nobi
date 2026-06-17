# Nobi 开发指南（给接手的智能体 / 开发者）

Nobi：AI 驱动的本地美术素材管理器。Tauri 2 + React 19 + TypeScript（前端）/ Rust（后端）。
画板为自研 Konva 实现（无 tldraw），文本支持行内富文本（TipTap 编辑 + 自研排版）。

## 必读文档

- `docs/ARCHITECTURE.md` —— 架构纪律（**改代码前先读**：invoke 只能在 api.ts、表结构只能在 db.rs 等五条铁律）
- `docs/RELEASE.md` —— 发版流程（自动发版一条命令 + 手动备用 + 坑表）
- `docs/TRANSLATION.md` —— 翻译子系统（三入口/智能路由/离线 ECDICT 词典/离线 OPUS-MT 整句/按需下载；**含发版前必做项**。现在分支 `feat/offline-translation`，未合 main）

## 常用命令

```bash
npm run tauri dev    # 开发（vite 1420 + Rust watcher；端口被占先杀 nobi 进程）
npx tsc --noEmit     # 前端类型检查（提交前必跑）
cargo check          # Rust 检查（在 src-tauri 下；见下方"坑"）
npm run build        # 前端构建（tsc + vite）
node scripts/release.mjs 0.x.y   # 一键发版（改版本号→提交→打 tag→推送→CI 云端发布）
```

## 提交规范

- 提交信息用**中文**，前缀沿用 `feat:` / `fix:` / `chore:` / `docs:` / `ci:`
- 直接提交并推送 `main`（个人项目无 PR 流程）；每完成一个功能/修复就提交，不攒大包
- 提交前确保 `npx tsc --noEmit` 通过；动了 Rust 还要 `cargo check`

## 关键事实

- **数据**：`%APPDATA%\com.nobi.app\nobi.sqlite`；素材原位索引不复制原图；所有"删除"只清库记录与缩略图，**绝不动用户原文件**
- **更新签名密钥**：`C:\Users\huobingli\.tauri\nobi-updater.key`（已加密；**密码在用户的备忘录里，问用户要，不在任何仓库/文档中**）。公钥在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- **CI Secrets**（已配置）：`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，供 `.github/workflows/release.yml` 云端签名
- **MCP**：应用运行时在 `127.0.0.1:21420/api/*` 提供本地接口；stdio 桥为 `scripts/nobi-mcp.mjs`，项目级注册在 `.mcp.json`（10 个工具：检索/打标/相似/上画板等）
- **AI Provider**：OpenAI 兼容三件套（设置面板），默认本地 Ollama；**必须用支持图片输入的视觉模型**（DeepSeek 官方 API 纯文本不可用）

## 聊天子系统（2026-06-15 加，已并入 main）

「和朋友聊天」：默认走云端 Supabase，**后端可换**（留了自建服务器接口）。

- **后端抽象** `src/chat/`：`types.ts` 的 `ChatBackend` 接口是核心——UI 只依赖它。`supabaseBackend.ts`（Realtime 收/insert 发/Storage 存图）、`customBackend.ts`（自建服务器，完整 WS+HTTP 客户端，顶部注释定义协议，搭匹配小服务器即可零改前端切过去）、`index.ts` 工厂、`config.ts`（连接档案/身份/已加入连接/outbox/活跃连接）、`setupSql.ts`（内嵌建表 SQL 供 app 内教程复制）、`avatar.ts`（头像图压成 64px data URL）
- **连接档案（多服务器）** `ChatProfile`：可存多套后端（我的 Supabase / 同事的服务器…），每个聊天窗绑一套——**不同窗口可同时连不同服务器**。启动器有连接下拉/新建/退出删除/「显示·分享凭据」（像 WiFi 密码，含内置后端，可复制 URL+key+房间号发朋友）。`getProfiles/saveProfile/removeProfile/resolveConfig`
- **窗口** `src/components/ChatWindow.tsx`：`main.tsx` 按 `#chat` 路由；URL `?profile=&room=` → 房间窗（label `chat-<profile>-<room>`，**可并排多群**），无参 → 启动器（label `chat`，进入后自动关）。启动器顶部「我的聊天」= 已加入连接列表（持久化，微信式点进去）。`App.tsx` 的 openChatWindow/openChatRoom/sendAssetToFriend
- **凭据内置**：`.env.local`（`*.local` 已 gitignore，**不进仓库**）放 `VITE_CHAT_SUPABASE_URL`/`VITE_CHAT_SUPABASE_ANON_KEY`，Vite 编译打进包→`CREDENTIALS_BAKED` 时有「内置后端」连接。**改 .env 必须重启 dev**
- **发媒体**：文字/图片/**视频**(kind 字段；拖图或视频进群窗，或素材右键「发给朋友」→ outbox 按 profile+room tag → 发活跃连接)。**Emoji 面板 + 表情包收藏**（素材右键「收藏为表情包」，本地路径存 localStorage，发时 re-upload，不受 24h 清理影响）。outbox 跨窗口靠 localStorage **轮询**（WebView2 多窗 storage 事件不可靠）。Supabase 免费档单文件约 50MB 上限
- **头像**：默认彩色首字（确定性），可选 emoji / **上传图片** / 素材右键「设为聊天头像」。随消息 `avatar` 字段带走（data URL，需表有 `avatar` 列）。**v0.2.10 起房间窗内也能改名/换头像**（右上角头像钮）
- **未读提醒**：主窗后台订阅所有已加入连接，没在看的群来消息 → **托盘红点+数字**（`lib.rs` `CHAT_UNREAD`/`badged_tray_icon`/`chat_bump_unread`/`chat_clear_unread`），开/聚焦聊天窗清零。聊天窗全关也能提醒
- **全局快捷键（随聊天窗占用/全关归还，均可改键带冲突检测，存 `chat_prefs.json`）**：老板键 `Alt+C` 藏/显所有聊天窗（`toggle_chat_windows`）；透明度 `Alt+V` 调淡 / `Alt+B` 调浓（`CHAT_OPACITY`+Win32 `SetLayeredWindowAttributes`，跨重启记忆、新窗继承）。命令 `chat_get/set_boss_key`、`chat_get_opacity_keys/chat_set_opacity_key`
- **看球窗隐藏**：`lib.rs` `hide_from_alt_tab`（Win32 `WS_EX_TOOLWINDOW`）让直开窗不在 Alt+Tab/任务栏出现
- **权限** `capabilities/chat-window.json`：`["chat","chat-*"]` + create-webview-window
- **Supabase 建表** `docs/chat-supabase-setup.sql`：messages 表（含 `avatar` 列）+ RLS（anon 读写）+ Realtime + chat-assets 公开桶 + **12h pg_cron 阅后即焚**（`nobi-chat-cleanup` 每小时删超 12h 消息/图片，存量不涨、长期免费；保留时长=改函数里两处 `interval`，v0.2.10 从 24h 改 12h）。**选头像/emoji 前用户须跑 `alter table messages add column if not exists avatar text;`**
- 依赖：`@supabase/supabase-js`。**发图/视频/多服务器真机端到端未最终确认**
- **v0.2.2 新增**：@提及(输入 `@` 弹候选=聊过天的人+所有人，`renderBody` 高亮，@到自己整条 `at-me` 高亮)；任务栏闪烁提醒(`flash_taskbar` FlashWindowEx，`chat_bump_unread(label)` 闪对应群窗/没开闪主窗)；Ctrl+V 粘贴图片/视频直接发；取消隐藏后滚轮失效 → `.chat-list` 手动接管 wheel；透明度 Alt+V/B **长按连调**(`CHAT_HOLD`/`CHAT_HOLD_GEN` 重复线程，同看球)
- **画板导出 PNG 修复**(`src/board/BoardCanvas.tsx`)：①原浏览器 `<a download>` 兜底在 WebView2 会存出假 png(488B HTML)，改为原生 saveDialog→saveFile→`revealItemInDir` 打开文件夹，仅纯浏览器预览才用 `<a download>`；②离屏 Konva Stage 不能放 `display:none` 容器(渲染空画布→toDataURL 空)，改屏外定位 `left:-100000px`
- **v0.2.3–0.2.7 通知/@ 完善**：
  - 任务栏**红角标**(`set_main_overlay`/`set_overlay_icon`)曾在 v0.2.4 加过，**v0.2.8 按用户要求移除**——任务栏未读只保留 `flash_taskbar` 闪烁；常驻红点提示只剩**系统托盘图标**那个(`badged_tray_icon`，主窗收进托盘时的兜底)
  - **未读判定改用窗口可见性**：主窗后台订阅收到消息时直接查该群窗 `isFocused()+isVisible()`(需 `default.json` 的 `is-focused`/`is-visible` 权限)，只有"打开+聚焦+可见"才不提醒——关窗/隐藏(boss键)/在后台都正常提醒。**废弃了原先靠 activeConn 标记判断的做法**(关窗时标记残留→误判"还在看"→提醒全哑)
  - `flash_taskbar`：群窗可见才闪它，否则(关/藏)闪主窗；闪用 `FLASHW_TIMERNOFG`(闪到前台为止)，但读消息常在聊天窗发生(主窗没到前台)，故 `chat_clear_unread` 里 `stop_flash`(FLASHW_STOP)主动停掉主窗+所有聊天窗的闪烁(v0.2.9)
  - **@候选按 clientId 去重**取每人最新名字(改过名只显示当前名、人数准；旧消息保留旧名不动)
  - Ctrl+V 粘贴图片/视频发送；取消隐藏后 `.chat-list` 手动接管滚轮(hover 即滚)；透明度 Alt+V/B 长按连调
- **v0.2.10**：
  - **房间窗内改名/换头像**：群窗右上角头像钮(`chat-me`)开内嵌编辑区(`chat-idedit`)，改名+选 emoji/上传图/默认。**不重连即时生效**——后端新增可选能力 `ChatBackend.updateIdentity(nickname, avatar?)`，只改 `this.cfg` 身份字段(房间/订阅不依赖昵称)，之后发的消息即用新身份；自建后端额外补发一帧 `join` 更新在线名单。渲染处身份从 `cfg.nickname` 改为独立 `nickname`/`avatar` state(故不触发连接 useEffect 重连)。旧消息保留发送时的名字
  - **修「外面改名进已存房间仍旧名」bug**：`goRoom()`(点「我的聊天」列表进房间)之前没把输入框名字落盘——只有点「进入」按钮走 `enter()` 才 `setNickname`，故先改名再点已存房间会读到旧名。现 `goRoom` 进窗前先 `setNickname(trim)`
  - **服务器保留时长 24h→12h**：`docs/chat-supabase-setup.sql` 第5节 `nobi_chat_cleanup()` 两处 `interval '12 hours'`(需在 Supabase SQL Editor 重跑该函数定义生效)
- **v0.2.11**：
  - **用户可见叫法改伪装名**（低调用）：工具菜单 `📺 看球小窗`→`🌐 浏览窗`、`💬 聊天`→`📝 便签`；同步改了浮窗标题/底部说明、状态提示「看球搜索引擎」、直开窗标题「看球（直开外链）→浏览窗（外部网页）」、快捷键冲突报错、`nav` 标签「换台/搜索→地址栏/搜索」。**仅改用户可见字符串，代码内部/注释仍用「看球」为该子系统名**(grep `看球` 改前先分清是不是字面量)
  - **托盘菜单加「📝 便签」**：`lib.rs` 新增 `open_chat_launcher()`(等价前端 openChatWindow，主窗在托盘也能开聊天启动器)，托盘项 id `note`；托盘看球项也改 `🌐 浏览窗（上次的页）`(id 仍 `watch`)

## 开机自启

`tauri-plugin-autostart`（desktop dep + setup 内 desktop-gated 注册 + `capabilities/default.json` 的 `autostart:*` 权限）。前端 `api.getAutostart/setAutostart`（包 `@tauri-apps/plugin-autostart`），工具→⚙设置→开机自启（菜单 `checked` 勾选态）。Windows 走 HKCU Run，无需管理员；**dev 登记调试 exe 路径，安装版才准**

## 划词右键翻译开关（v0.2.9）

工具→⚙设置→**划词右键翻译**（菜单 `checked`）。`selection_translate.rs` 的 `SELECTION_TRANSLATE_ENABLED`(AtomicBool)门控 `handle_right_click`——关掉后 WH_MOUSE_LL 钩子仍跑但右键不弹翻译+藏掉浮窗；存 `selection_translate.json`，`start()` 先 `load_enabled` 再挂钩。命令 `get/set_selection_translate_enabled`，前端 `api.getSelectionTranslateEnabled/setSelectionTranslateEnabled`

## 桌面工具（v0.2.12，桌面专属·Dobby 抄不走）

定位：只做「网页工具站做不到的桌面能力」（系统钩子/置顶浮窗/全局热键/本地文件）。常驻全局热键统一存 `tool_keys.json`，可改键，集中在**编辑→⌨ 首选项·快捷键**（`PreferencesModal.tsx`，调既有 get/set 命令统一录键；含聊天/浏览窗键）。

- **桌面取色器**（`Ctrl+Alt+C`，可改键）：`color_pick_shortcut` 按下→`selection_translate::arm_color_pick()`，**复用划词翻译那个 WH_MOUSE_LL 全局鼠标钩子**进入「取色态」：光标换十字(`SetSystemCursor`，还原用 `SystemParametersInfoW(SPI_SETCURSORS)`)，**左键点哪取哪(吞掉该点击)/右键取消**。取色 = `sample_point_color(x,y)`（GDI `GetPixel`），emit `color-picked{hex,r,g,b}`。前端：`App.tsx` 复制 hex+右下角「最近色板」(左/右键复制 hex/rgb)+顶部「取色模式」横幅；**`BoardCanvas.tsx` 也监听 `color-picked`→`applyStyle({color:hex})`** 把取的色设成画板当前色（画板本就支持任意 hex）。Cargo 加了 `Win32_Graphics_Gdi`。**故意不做跟随光标放大镜**——透明置顶 GPU 画布在本机 WebView2 必翻车
- **悬浮参考窗升级**（`RefWindow.tsx`）：右键图 → 开**独立菜单小窗**(`RefToolsWindow.tsx`，label `ref-tools`，#reftools 路由)——因为参考窗可能被缩到很小，菜单画窗内会被 webview 裁掉，故独立成窗(挂载后 `setSize` 自适应内容高、失焦自动关、物理坐标摆光标处避免跨屏/DPI 错位)。菜单项 emit `ref-apply{target,patch}` → 参考窗监听应用：镜像/灰度/反色/旋转(90°,vw/vh 铺满)/透明度/对比/亮度/点击穿透(`Ctrl+Alt+R` 切回，全局影响所有 ref 窗)/多图轮播(localStorage 传 list)。图用 `object-fit:contain`，窗口缩放只走右下角手柄(按比例 setSize)。`ref-window.json` 加了 create-webview-window/show/hide/set-focus/set-position 等权限
- **截图**：自研框选浮层试过但**放弃**（本机 WebView2 透明/新建窗有黑屏+迟滞，反复修不顺）。改用**系统 Win+Shift+S → 画板 Ctrl+V**：画板 `onPaste` 本就支持剪贴板图片(落盘入库+上板)，零开发。相关自研代码(screenshot.rs/#shot/Ctrl+Alt+S)已全删
- **图层顺序**：画板早有 `store.reorder(ids,"front|back|forward|backward")`，键 `]`上移/`[`下移/`Shift+]`置顶/`Shift+[`置底（不限修饰键，Alt+] 也触发）+ 右键菜单

### v0.2.13 增改
- **文档编辑器（Word 式，自研非内嵌）**：dock 面板 `doc`（`DocEditor.tsx`，TipTap 全功能 StarterKit+Underline+TextStyle+Color），窗口(W)→文档。多文档存 SQLite `docs` 表（`docs.rs` 仿 board.rs：list/create/rename/delete/save/load_doc，内容为 HTML），打字停 0.7s 防抖自动存。颜色当前值描白圈反馈。**下一步要做思维导图(xmind)自研节点画布**
- **浏览窗/便签从 Alt+Tab+任务栏(含悬停预览)彻底隐去**：`WS_EX_TOOLWINDOW`（Tauri skipTaskbar 只去任务栏不去 Alt+Tab）。`hide_from_alt_tab` 加 `SWP_FRAMECHANGED` 即时生效；浏览窗 `open_direct_window` 直接可见建窗后立即打标记（隐藏建窗→show 会卡 WebView2 冷启动）；便签前端 `visible:false` 建窗 + 窗口 mount 调 `stealth_show`（Rust 命令：透明态先套 alpha 再 show、打标记），老板键 show 后也补打。便签首开**别在内容加载前打 layered alpha**（白屏坑）——`stealth_show` 在 mount 后调所以安全
- **素材保存路径**：编辑→⚙设置→📁素材保存路径（`SavePathModal.tsx`）。`settings::import_dir`（用户设置 `import_dir` > 默认 图片\Nobi）+ `get/set_import_dir` 命令；`import_blob` 改用它。粘贴/拖入/画板存图落这
- **设置菜单挪到 编辑(E)**（原在工具(T)）：开机自启/划词翻译/素材保存路径
- **来消息闪烁改只闪任务栏**：`flash_taskbar` 由 `FLASHW_ALL` 改 `FLASHW_TRAY`——`FLASHW_ALL` 含 `FLASHW_CAPTION` 会闪窗口标题栏/边框
- **浏览窗几何存 outer_size**（原 inner_size）：Alt+3 开标题栏时内尺寸被吃掉变小，存内尺寸→开关-关窗-重开循环窗口越来越扁；外尺寸稳定
- **已知正常**：浏览窗首开 Alt+3 迟钝要按两次——`set_decorations` 异步重操作 vs WebView2 冷启动抢资源，引擎热后正常，非 bug

## 已知的坑

- **cargo 文件锁**：`npm run tauri dev` 的 watcher 与任何并行 cargo/构建会抢锁，可能把 watcher 抢死（vite 活着但 Rust 不再重编译、应用不重启）。规则：**dev 跑着时不要并行跑 cargo build/check**；watcher 死了就重启 dev
- **Windows 图标缓存**：换图标后资源管理器显示不变是缓存问题，复制改名即可验证真身
- **画板调试**：DEV 模式下 `window.__nobiBoard` 暴露 store/stage/editor/openTextEditor/tiptap，可在控制台直接驱动
- 画板持久化双层：localStorage 快取（键 `nobi-board-doc-v1[:id]`）+ SQLite 权威副本；多画板按 id 分键
