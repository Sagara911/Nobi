---
name: chat-system
description: Nobi 内置云端聊天子系统：后端抽象层(Supabase/自建服务器,多连接档案)、并排多群+我的聊天列表、文字/图片/视频/Emoji/表情包、自定义头像、托盘红点未读、Alt+C老板键+Alt+V/B透明度(均可改键)、24h阅后即焚免费、开机自启。v0.2.1 已并入 main
metadata: 
  node_type: memory
  type: project
  originSessionId: 41615f6e-a2da-472f-af57-05660c233fc5
---

Nobi 加的「和朋友聊天」子系统（2026-06-15 本会话从零搭，[[gringotts-project]] 的一部分）。需求演进：局域网→改云端（用户「不想让 IT 看到」，HTTPS 传输加密即可，**不要端到端加密**）→ 要并排多群 → 要 Alt+Tab 隐藏 → 要 24h 自动删省钱。

**Why:** 桌面素材管理器顺带做轻量聊天，杀手锏是「右键素材/拖图直接发给朋友」。隐私目标=公司 IT 读不到内容（HTTPS 达成），可接受消息存第三方云。

## 架构（后端抽象层是核心，"留接口"给将来自建服务器）
- `src/chat/types.ts`：`ChatBackend` 接口（connect/disconnect/sendText/sendAsset/history/onMessage/onStatus）——UI 只认它，不碰具体后端。
- `src/chat/supabaseBackend.ts`：Realtime 订阅收、insert 发、Storage 存图。
- `src/chat/customBackend.ts`：**自建服务器实现**，已写成完整 WebSocket+HTTP 客户端，顶部注释定义了一套极简协议（join/text/image 帧 + /upload /history）。将来用户搭个匹配的小服务器、设置里切 provider=custom 填地址即用，**前端零改**。
- `src/chat/index.ts`：`createBackend(cfg)` 工厂（加后端只改这一处）；`src/chat/config.ts`：配置/outbox/活跃房间。
- `src/components/ChatWindow.tsx`(+css)：两形态由 URL `?room=` 决定——无 room=「发起/加入群」启动器，有 room=该房间独立聊天窗。`main.tsx` 按 `#chat` 路由。

## 关键实现点
- **凭据内置**：`.env.local`（被 `*.local` gitignore，**不进公开仓库**）放 `VITE_CHAT_SUPABASE_URL` / `VITE_CHAT_SUPABASE_ANON_KEY`，Vite 编译时打进包。`config.ts` 的 `CREDENTIALS_BAKED` 为真时启动器只需「名字+房间号」（微信面对面建群式），URL/key 用户不用碰。改 .env 需**重启 dev**（Vite 启动时才读）。当前用户的 Supabase 项目：`ihucapiudxxmqbodlpgj.supabase.co`，用的是新版 `sb_publishable_` 可公开密钥（supabase-js ≥2.108 支持）。
- **并排多群**：每群一个独立窗口，label `chat-<房间号>`；启动器 label `chat`。点「进入」开房间窗，启动器留着可反复开多个群。`App.tsx` openChatWindow(启动器)/openChatRoom(房间)。
- **发图两路**：①桌面拖图进群窗（窗口建时 `dragDropEnabled:false` 走 HTML5 拖放，File 直接当 blob 上传，最顺）②素材右键「发给朋友」→ 进 outbox（按房间号 tag）→ 发往「当前活跃群」（房间窗获焦时 setActiveRoom）。outbox 跨窗口靠 localStorage + **轮询**排空（WebView2 多窗口间 storage 事件不可靠，1.5s 轮询）。
- **老板键 Alt+C**（可改）：Rust 全局快捷键，按一下藏所有聊天窗、再按恢复。随聊天窗存在才占用、全关归还（lib.rs on_window_event 生命周期 + `CHAT_BOSS_ON`）。默认 `Alt+KeyC`，用户在启动器「改键」录新组合，存 `chat_prefs.json`，命令 `chat_get_boss_key`/`chat_set_boss_key`。看球老板键是 Alt+\`，二者独立。
- **看球窗从 Alt+Tab 隐去**：lib.rs `hide_from_alt_tab`（Win32 加 `WS_EX_TOOLWINDOW` 去 `WS_EX_APPWINDOW`），open_direct_window 建窗时 + toggle_web_windows show 后各打一次。代价：任务栏也没按钮（靠托盘/老板键唤回）。
- **capability** `chat-window.json`：windows `["chat","chat-*"]` + core:default + create-webview-window（开兄弟窗）+ close/set-title/set-focus/set-always-on-top。

## Supabase 侧（用户已建好并跑过 SQL）
`docs/chat-supabase-setup.sql` 一段搞定：messages 表 + RLS(anon 读写) + Realtime + chat-assets 公开桶 + **第5节 24h 阅后即焚**（pg_cron 每小时 `nobi_chat_cleanup()` 删超 24h 的消息和图片，jobname `nobi-chat-cleanup`）。免费额度瓶颈=存储 1GB/库 500MB/egress 5GB·月，24h 删让存量永不涨→长期免费。RLS 是「任何拿到 anon key 的人可读写」（小圈子够用，未按房间口令收紧）。

## 验证状态（2026-06-15 真机 tauri dev）
已验：文字收发+实时、自己气泡识别(clientId)、Alt+C 老板键、cron 任务 active。**发图真机未最终确认**（改完拖图机制后没回看结果，理论通：contactSheet 已证 fetch(convertFileSrc) 可读字节、Storage 上传策略已配）。端到端两人互聊未做（需第二台/第二人）。

## 同会话续扩（2026-06-15，全部已提交，v0.2.1 在 main）
权威细节看仓库 `AGENTS.md` 的「聊天子系统」段（已同步）。要点：
- **连接档案 ChatProfile**：多套后端，每窗绑一套→不同窗可同时连不同服务器；启动器连接下拉/新建/退出/「显示·分享凭据」(像 WiFi 密码,可复制 URL+key 发朋友)。`config.ts` 大重构(身份 nickname 全局 + profiles + 已加入连接 JoinedConn + 活跃连接)，含旧单一配置/旧 rooms 的迁移。
- **我的聊天列表**：启动器顶部列已加入连接，微信式点进去；房间记忆本就持久化(localStorage)，只是补了 UI。进入后启动器自动关。
- **媒体扩到视频**(kind:text/image/video，`<video>` 播)；**Emoji 面板 + 表情包收藏**(素材右键「收藏为表情包」存本地路径,发时 re-upload)。
- **头像**：默认彩色首字 / emoji / 上传图片 / 素材右键「设为聊天头像」，压成 64px data URL 随消息 `avatar` 字段带走 → **messages 表要加 `avatar` 列**(setupSql 已含 + ALTER；没列+没选头像不受影响,选了才需要)。
- **托盘红点未读**：主窗后台订阅所有已加入连接(`App.tsx` useEffect)，没在看的群来消息→`chat_bump_unread` 亮托盘红点(`badged_tray_icon` 在默认图标叠红点)，聚焦聊天窗 `chat_clear_unread` 清零。
- **透明度 Alt+V/B**(Win32 SetLayeredWindowAttributes，同看球)；老板键 Alt+C。**两者均可改键+冲突检测**(register 失败=被占,报错恢复旧键)，存 `chat_prefs.json`(bossKey/opacity/opacityDownKey/opacityUpKey)。
- **开机自启**：`tauri-plugin-autostart`，工具→⚙设置→开机自启(菜单 checked)；dev 登记调试 exe，安装版才准。
- **v0.2.2(同会话续)**：@提及(输入@弹候选=聊过的人+所有人,@到自己整条高亮)；任务栏闪烁(FlashWindowEx `flash_taskbar`,来消息闪对应群窗/没开闪主窗,并入 `chat_bump_unread(label)`)；Ctrl+V 粘贴图片/视频直接发;取消隐藏后滚轮失效→`.chat-list` 手动接管 wheel(hover 即滚);透明度 Alt+V/B 长按连调(`CHAT_HOLD`/`CHAT_HOLD_GEN`)。另:**画板导出 PNG 修复**(浏览器 `<a download>` 在 WebView2 存出 488B 假 png/HTML→改原生 saveDialog+saveFile+revealItemInDir,见 BoardCanvas.tsx)。v0.2.1 已发布,本批进 v0.2.2。
- **v0.2.3–0.2.7(连发)**:画板导出再修(离屏 Konva Stage 不能放 display:none 容器→渲染空画布→toDataURL 空→save_file 报 missing dataB64;改屏外定位 left:-100000px);**任务栏红角标**(set_main_overlay→Tauri set_overlay_icon,主窗任务栏按钮叠红点,常驻到已读,比托盘红点/闪烁显眼);**未读判定改用窗口可见性**(后台订阅收到消息直接查该群窗 isFocused+isVisible,需 default.json is-focused/is-visible 权限;废弃 activeConn 标记判断——关窗时标记残留会误判"还在看"导致提醒全哑,这是"关/隐藏聊天窗后收不到提醒"的根因);flash_taskbar 群窗不可见时改闪主窗;@候选按 clientId 去重取每人最新名(改名只显当前名、人数准,旧消息保留旧名)。发版节奏:每个 tag v0.2.x 触发 CI 云端签名发布,连发多个用户更新直接跳最新。
- **v0.2.8**:按用户要求**移除任务栏红角标**(删 set_main_overlay/red_dot_image)——任务栏未读只留 flash_taskbar 闪烁;常驻红点只剩系统托盘图标那个(在 ^ 折叠里)。术语对齐:任务栏=最下面那条/按钮闪烁;系统托盘=右下时钟旁 ^ 里的小图标红点。
- **v0.2.9**:任务栏闪烁"已读不灭"修复——flash 用 FLASHW_TIMERNOFG(闪到前台为止),但读消息常在聊天窗(主窗没到前台)→标亮不灭;改成 chat_clear_unread 里 `stop_flash`(FLASHW_STOP)主动停主窗+所有聊天窗闪烁。同版加[[translation-system]]的划词翻译开关。

## 验证状态
已验：文字收发+实时、clientId 自识别、Alt+C 老板键、cron active、大重构后启动器正常渲染(用户截图)、各 Rust 改动均编译通过(Finished)。**未最终真机确认**：发图/发视频端到端、托盘红点、透明度 Alt+V/B、多服务器并存、自定义头像显示、开机自启重启后效果。端到端两人互聊未做(需第二人/第二端)。

## 2026-06-17 续：气泡改色 + UNO 小游戏（本会话，未发版）
- **气泡改色**：本机偏好，只染自己发出的气泡。`chat/config.ts` 加 `getBubbleColor/setBubbleColor + BUBBLE_COLORS`(8 预设)；ChatWindow 在「改名/换头像」面板加选色器(预设+`<input type=color>`)，`.chat-win` 上设 `--mine-bubble`/`--mine-bubble-text`(按亮度自动深/浅字，readableText)，CSS `.chat-row.mine .chat-bubble` 用变量。**纯 CSS 背景，WebView2 无渲染风险**。仅本地、对方看不到（要同步得动消息 payload/Supabase 表）。
- **UNO**：纯函数引擎 `chat/uno.ts`(标准 108 张/跳过/反转/+2/变色/+4；摸牌后可打该牌或过；反转2人=跳过；不做叠加/不罚未喊UNO/+4不校验)——**已严格验证**(浏览器 dynamic import 跑 200 局随机对战全部正常终局、守恒、各功能牌定向测试通过)。`components/UnoGame.tsx`(+css) 嵌聊天窗：**房主持权威 UnoState、应用动作后广播快照；其余端只渲染快照**。传输走聊天通道,正文带 `UNO_TAG`(=`UNO` 控制字符,ChatRoom `routeIncoming` 分流,不进消息流)；靠 Supabase realtime **回显**(自己发的也经 onMessage 回来,见 supabaseBackend 无乐观插入)送达,用快照版本号+动作 id **去重**抗历史重放/至少一次。后端零改动、无 Supabase 表变更。UI 各态(idle/lobby/board/选色/胜负)preview 逐一验过。**信任客户端**(手牌全量随快照广播、各端只显示自己的→开发者工具可偷看,朋友局可接受)。**真机 2 端联机未验**(单机同 clientId 没法自测,需两台机/两浏览器)。坑:房主掉线对局停;面板没开也在听(始终订阅)但邀请最好双方都先点开 🎴。
- **注意**:撤思维导图后主窗 dockview 旧布局含已删 `mind` 面板→加载报 "failed to deserialize layout. Reverting" 并重置一次布局(自愈,无害)。
- **UNO bug 修(同会话,真机测后)**:①打完一把卡死(结算页非房主无任何按钮)→结算页给所有人加「退出」(reset 回 idle 可重开)+头部常驻「退出」;房主仍「再来一局」。②无点击反馈→出牌后 `pending` 立刻显示「出牌中…」+禁手牌/按钮(4s 兜底超时防忽略卡死)+卡牌/按钮 `:active` 按下态。

## 2026-06-17 续2：便签透明度首开 + 隐身窗标题栏按钮(本会话,未发版,**真机未验**——Win32 窗样式无法在 preview 里测)
- **便签透明度首开不生效**(关软件后首开便签不透明、点一下才透明):根因 `stealth_show` 里 apply_chat_opacity(layered alpha) 在 `hide_from_alt_tab` 的 `SWP_FRAMECHANGED` **之前**套→帧变更把 alpha 抹了→显示成不透明;点窗口才触发 Focused 事件重套(那次之后无帧变更才生效)。**修**:透明度改到所有 hide_from_alt_tab 帧变更**之后**再套(show 前一次+show后补刀后再一次),抽 `apply_chat_alpha_for(&window)` 复用。同 set_decorations 抹 alpha 一族坑。
- **隐身窗标题栏只剩关闭键**:根因 `WS_EX_TOOLWINDOW`(隐身=不进 Alt+Tab/任务栏)**会砍掉系统标题栏的最小化/最大化键、只留关闭**——隐身与原生最小/最大化二者不可兼得。用户选「便签自定义键保持隐身」:
  - **便签**:聊天窗头部加自定义 `▢`最大化(`toggleMaximize`)/`—`隐藏(`hide()`,Alt+C 老板键或托盘唤回)按钮;关闭用原生顶栏那个。**保持隐身不动 toolwindow**。
  - **浏览窗**(外部网页放不了我们的 UI):Alt+3 切标题栏的 handler 里,显示标题栏时同时 `show_in_alt_tab(&w)`(去 WS_EX_TOOLWINDOW)→拿到系统完整三键;收起标题栏 `hide_from_alt_tab` 恢复隐身。新增 `show_in_alt_tab` 为 `hide_from_alt_tab` 反操作。
- **v0.2.16 这俩修复真机翻车→真根因(v0.2.17 后修)**:症状=隐藏/最大化/Alt+3 三键「只闪一帧就消失」。真因=`on_window_event` 里 **`Focused(true)` 每次获焦都无条件 `hide_hwnd_from_alt_tab` 重打隐身**(v0.2.15「隐身打标记改到 Focused」那段),把刚显示的按钮/刚最大化的状态瞬间打回(SWP_FRAMECHANGED)。修:①浏览窗 focus 重隐身加 `!WEB_DECOR` 闸(标题栏模式不重打);②便签改**只首焦打一次隐身**(`STEALTH_DONE: Mutex<BTreeSet<String>>`,BTreeSet::new() 是 const 能进 static;Destroyed 时 remove 该 label 以便重开再首焦);③`show_in_alt_tab` 去掉 hide/show(只去 toolwindow 即出最小/最大化键,hide/show 只为任务栏注册却会闪)。**仍真机未验**(Win32 窗样式 preview 测不了)。

## UNO 优化(本会话,未发版)：+2/+4 叠牌 + 体验打磨
- **+2/+4 同类叠牌**(uno.ts)：UnoState 加 `pendingDraw`，叠牌类型从顶牌 value 推导。被 +2 罚可接任意色 +2 把累计甩下家(+4 接 +4，**不跨类叠**)；接不住摸完累计、跳过自己(draw 动作在 pendingDraw>0 时=一次摸 N 张+advance1)。play 校验：pendingDraw>0 时只许出同 value 牌；d2/wd4 效果改为 `pendingDraw+=2/4 + advance1`(不再立即罚)。起始 +2 也起叠(首家 pendingDraw=2)。**严格验证**(250 局随机自测全终局+守恒，maxStack 12；叠加/接完跳过/跨类拒/普通牌拒 定向测试过)。**+4 仍随时可出**(用户嫌"只在无同色时出"无聊)。
- **UI 打磨**(UnoGame.tsx)：手牌按 颜色(红黄绿蓝<变色)+点数 排序显示；座位剩 1 张高亮「⚠UNO」；叠牌时回合条显「累计 +N」徽标 + 「接同类甩下家或摸 N 张」、摸牌键变「摸 N 张」。preview 逐项验过。
- **牌桌更直观(同会话续)**：整片牌桌按当前色染色(内联 `${HEX}26` 底 + 同色边框，变色后一眼看清现在什么色)；中间「↓ 压这张」放大顶牌(`.uno-card.big` 54×80)；「当前色」带标签的色块；「我的手牌（N）」计数；轮到谁的座位**金色填充高亮**(注意 `.uno-seat.turn` 必须排在 `.me` 之后才压得过蓝底)；轮到我时回合条金底大字。preview inspect 验过。

> ⚠ 本机 preview_screenshot 全程必超时(30s)，只能用 preview_eval/inspect/snapshot 读 DOM 验证，截图给不了。
> ⚠ 本机 board-preview 的 `window.innerHeight`/`100vh` = **0**（headless 无真实视口）→ 任何 `height:%/vh` 的元素在 preview 里塌成 0，但真机 Tauri 窗(560px)正常。教训：要在 preview 里验高度就用**固定 px**，别用 %/vh。

## 游戏内聊天 GameChat — 弹幕版(本会话,未发版)
- 解决「开着游戏全屏盖住聊天、发消息得退出游戏」。`components/GameChat.tsx`(+css)：**底部常驻输入条**(z60) + **弹幕层**(`.dm-layer` z58,`pointer-events:none` 不挡游戏点击) → 新消息从右往左飘过游戏区(`left:100%→-100%` 8s 线性,`onAnimationEnd` 移除)，自己的弹幕金色。首次挂载只记录历史 id 不回放，只飘新消息(5 条 lane 轮换)。**不动 UNO/飞行棋组件**——ChatRoom 在 `{openGame && <GameChat messages onSend={sendChatText} myId/>}` 渲染，复用 messages + `sendChatText`(直发文本)。两个游戏 overlay 加 `padding-bottom:46px` 让底部按钮不被输入条盖。preview 验过结构(输入条/弹幕层/发送清空/padding)；**弹幕动效+真消息需真机**(preview 无后端消息、视口宽=0 测不了飘动)。
  - 之前做过抽屉版(💬 浮钮+底部抽屉)，用户改要弹幕版，已替换。

## UNO 续：摸到能出为止 + 回合倒计时(本会话,未发版)
- 用户提的玩法里挑了「摸到能出为止」+「回合倒计时」(没喊UNO抓人没做、用户误以为做了——其实只有⚠UNO提示)。两者**默认开启**(没做房规开关)。
- **摸到能出为止**(uno.ts draw)：pendingDraw=0 时摸牌改为循环摸到摸出能压的牌为止(或牌摸光)，摸到的能出牌可打或过；摸光也没有就过。
- **回合倒计时 30s**(`TURN_SECS`)：纯前端，无状态字段。UnoGame 每回合(gid-v 变)本地 setInterval 计时，回合条显 ⏱N、≤5s 变红。**用户要求超时不踢人**：归零只把计时器变「⏰超时」**闪烁**(CSS `uno-blink`)提醒，**不自动出牌/摸牌/跳过**。引擎里原先的 `timeout` action(摸牌跳过)已**删除**(不再用)。代价：真挂机会卡在他回合(用户接受，宁可不乱动别人的牌)。preview 验过(TURN_SECS 临时=2 看到 ⏰超时+blink、无自动操作)。

## UNO 续：炸弹牌(本会话,未发版)
- 用户要的自定义玩法：牌堆掺 **6 张炸弹**(`value:"bomb"`,color"w" 使其不被选作起始牌)，摸到即引爆——摇骰子(`unoRoll` 1-6)多摸那么多张真牌，炸弹移除(不进手不进堆)。`canPlay` 对 bomb 返回 false(永不可出)；`startGame` 发牌跳过炸弹(起手不含)；连环炸弹会叠加。
- 实现：抽象出 `takeOne`(取一张+洗回)/`drawReal`(摸N张真牌,炸弹→need+=骰子)/`drawUntilPlayable`(摸到能出,含引爆)，**所有摸牌路径**(普通#5/+2+4接不住/超时)统一走它们；炸弹引爆记两行日志(💣 摇骰子 X，多摸 N 张)。删了旧 `refillIfEmpty`。
- 验证：牌堆 108 真+6 炸；起手 0 炸弹；250 局**真牌守恒 108、炸弹零泄漏到手牌/弃牌、全终局、引爆生效**；定向(固定骰子3,叠牌摸2→引爆→共摸5)对。默认开启(没做开关)。

## 2026-06-17 续3：飞行棋(本会话,未发版,2 端联机真机未验)
- 第二个聊天内游戏。引擎 `chat/ludo.ts` 纯函数(2–4 人各执一色 4 机;掷6起飞/走子/主环撞子送回家(己方叠放)/精确点数进终点56/掷6续掷/四子到家胜)——**严格验证**(浏览器 300 局随机自动对战全部正常终局、位置合法、撞子/叠放/胜/续掷定向测试过)。**暂不做**：「飞」(同色前跳)/捷径斜跳/安全格/连三6罚回——需精确彩色棋盘建模,核心稳后再加。
- `components/LudoGame.tsx`(+css):沿用 UNO 房主权威+广播快照+lobby/join/state/action 那套(房主在 join 时按入座序分配颜色 r/y/g/b)。棋盘用**方环简化布局**(52 格环+各色回家通道+四角机库+中心终点,几何可靠;不是传统十字盘——要十字以后再说)。掷骰子按钮+多子可走时高亮点选+pending「等待…」。preview 逐项验过(开局/lobby/棋盘渲染/move 高亮/点击 pending)。
- **传输改造**:ChatRoom 从单一 UNO 监听改成**按 tag 分流**:`UNO_TAG`(=`UNO`)/`LUDO_TAG`(=`LUDO`) 各自独立监听集 + sendUno/subscribeUno + sendLudo/subscribeLudo;`routeIncoming` 泛型 dispatch 按前缀分发。`gameOpen` 布尔改 `openGame:"uno"|"ludo"|null`(互斥),头部加 🎲 按钮。**UNO 线路 wire 格式没动、回归验过仍正常**。下个游戏(斗地主)照此再加一路。

## 坑
- 改 `.env.local` / Cargo.toml / capability / lib.rs 必须等 dev **重编重启**才生效；本会话多次遇到 **tauri dev 的 Rust watcher 在 app 异常退出(0xffffffff)后停摆**(只剩 vite 热更前端)，表现为 lib.rs 改了没重编——靠 kill vite(1420)+nobi+cargo 后 `npm run tauri dev` 干净重启解决。
- 选头像/emoji 前用户须在 Supabase 跑 `alter table public.messages add column if not exists avatar text;`，否则带 avatar 的 insert 会失败。
- 本机另开着正式版会占端口致 dev 请求打到老版（见 [[translation-system]] 同坑）。
