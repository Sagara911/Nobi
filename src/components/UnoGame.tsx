// UNO 对局面板（嵌在聊天窗里）。走聊天通道传「游戏事件」，房主持权威状态广播快照。
// 传输靠 Supabase realtime 回显（自己发的消息也会经 onMessage 回来）；用版本号 / 动作 id 去重，
// 兼容历史重放与至少一次投递。规则引擎见 ../chat/uno。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type UnoState,
  type UnoCard,
  type UnoColor,
  type UnoPlayer,
  type UnoAction,
  startGame,
  applyAction,
  legalCardIds,
} from "../chat/uno";
import "./UnoGame.css";

/** 聊天正文里的游戏事件前缀（控制字符，正常聊天不会出现）；ChatRoom 据此分流、不显示在消息流 */
export const UNO_TAG = "UNO";

export type GEvent =
  | { k: "lobby"; gid: string; host: string; players: UnoPlayer[] }
  | { k: "join"; gid: string; player: UnoPlayer }
  | { k: "state"; s: UnoState }
  | { k: "action"; gid: string; aid: string; a: UnoAction };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const TURN_SECS = 30; // 每回合限时；超时只闪烁提醒，不自动操作

const COLOR_HEX: Record<UnoColor, string> = { r: "#e0413a", y: "#e8b21f", g: "#3a9e4d", b: "#2f6fdd" };
const COLOR_NAME: Record<UnoColor, string> = { r: "红", y: "黄", g: "绿", b: "蓝" };

/** 单张牌的显示符号 */
function cardFace(card: UnoCard): string {
  switch (card.value) {
    case "skip": return "⊘";
    case "rev": return "⇄";
    case "wrev": return "⇄";
    case "d2": return "+2";
    case "wild": return "🎨";
    case "wd4": return "+4";
    case "lightning": return "⚡";
    case "kbomb": return "💥";
    case "swap": return "🔄";
    case "challenge": return "❓";
    default: return card.value;
  }
}

function CardChip({ card, dim, big, onClick }: { card: UnoCard; dim?: boolean; big?: boolean; onClick?: () => void }) {
  const isWild = card.color === "w";
  const style = isWild ? undefined : { background: COLOR_HEX[card.color as UnoColor] };
  return (
    <button
      className={`uno-card${isWild ? " uno-wild" : ""}${big ? " big" : ""}${dim ? " dim" : ""}${onClick ? " playable" : ""}`}
      style={style}
      disabled={!onClick}
      onClick={onClick}
      title={card.inv ? "侵袭牌：打出后所有人需跟同色/同点，否则摸2" : onClick ? "出这张" : undefined}
    >
      {cardFace(card)}
      {card.inv && <span className="uno-badge" title="侵袭">⚔</span>}
    </button>
  );
}

export default function UnoGame({
  open,
  myId,
  myName,
  sendGame,
  subscribeGame,
  onClose,
}: {
  open: boolean;
  myId: string;
  myName: string;
  sendGame: (ev: GEvent) => void;
  subscribeGame: (fn: (ev: GEvent) => void) => () => void;
  onClose: () => void;
}) {
  const [lobby, setLobby] = useState<{ gid: string; host: string; players: UnoPlayer[] } | null>(null);
  const [gstate, setGstate] = useState<UnoState | null>(null);
  const [colorPick, setColorPick] = useState<string | null>(null); // 待选色的变色牌 cardId
  const [swapTake, setSwapTake] = useState<string | null>(null); // 替换：要留下的下家牌 id
  const [swapGive, setSwapGive] = useState<string | null>(null); // 替换：要给出的自己牌 id
  const [claimPick, setClaimPick] = useState<string | null>(null); // 质疑牌待声明 cardId（选同色/同点）
  const [pending, setPending] = useState(false); // 已发出动作、等权威快照回来（点击反馈 + 防连点）
  const [secsLeft, setSecsLeft] = useState(TURN_SECS); // 当前回合倒计时

  // 房主权威状态 + 去重
  const hostStateRef = useRef<UnoState | null>(null);
  const processedAids = useRef<Set<string>>(new Set());
  const seenVersion = useRef<Record<string, number>>({});
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;
  const sendRef = useRef(sendGame);
  sendRef.current = sendGame;

  const amHost = !!lobby && lobby.host === myId;

  // 事件处理：所有端共用。房主额外处理 join/action 并广播 state。
  const handle = useCallback(
    (ev: GEvent) => {
      const send = sendRef.current;
      if (ev.k === "lobby") {
        setLobby({ gid: ev.gid, host: ev.host, players: ev.players });
        // 收到新一局的 lobby：清掉旧对局状态，回到等待
        setGstate((cur) => (cur && cur.gid !== ev.gid ? null : cur));
        return;
      }
      if (ev.k === "join") {
        const lb = lobbyRef.current;
        if (!lb || lb.host !== myId || lb.gid !== ev.gid) return; // 只有房主、且本局 lobby 才处理
        if (hostStateRef.current) return; // 已发牌就不再加人
        if (lb.players.some((p) => p.id === ev.player.id)) return; // 去重
        const players = [...lb.players, ev.player];
        send({ k: "lobby", gid: lb.gid, host: lb.host, players }); // 回显会更新各端
        return;
      }
      if (ev.k === "state") {
        const s = ev.s;
        const seen = seenVersion.current[s.gid] || 0;
        if (s.v <= seen) return; // 旧快照忽略
        seenVersion.current[s.gid] = s.v;
        setGstate(s);
        return;
      }
      if (ev.k === "action") {
        const host = hostStateRef.current;
        if (!host || host.gid !== ev.gid) return; // 只有房主有权威态才处理
        if (processedAids.current.has(ev.aid)) return; // 去重
        processedAids.current.add(ev.aid);
        const ns = applyAction(host, ev.a);
        if (ns === host) return; // 非法动作，忽略
        hostStateRef.current = ns;
        send({ k: "state", s: ns });
        return;
      }
    },
    [myId],
  );

  // 始终订阅（即使面板关着也在听，这样别人开局/邀请不会漏）
  useEffect(() => subscribeGame(handle), [subscribeGame, handle]);

  // 房主心跳：每 3 秒重广播一次权威状态，救回「漏收某次快照而卡住」的端
  // （高版本快照被接受→追上进度；同版本被忽略→不会闪屏）。质疑/替换等多人同时操作时尤其需要。
  useEffect(() => {
    if (!amHost) return;
    const t = window.setInterval(() => {
      const s = hostStateRef.current;
      if (s && s.status === "playing") sendRef.current({ k: "state", s });
    }, 3000);
    return () => window.clearInterval(t);
  }, [amHost]);

  // 收到新快照（自己的动作生效或别人出牌）即清掉「出牌中」
  useEffect(() => {
    setPending(false);
  }, [gstate]);

  // 替换阶段开始/结束时清空选牌（依赖 from：开始=出牌人 id，结束=undefined）
  const swapFrom = gstate?.pendingSwap?.from;
  useEffect(() => {
    setSwapTake(null);
    setSwapGive(null);
  }, [swapFrom]);

  // 回合倒计时：每个新回合本地起计时；归零只闪烁提醒（不替任何人出牌/摸牌/跳过）。
  useEffect(() => {
    if (!gstate || gstate.status !== "playing") {
      setSecsLeft(TURN_SECS);
      return;
    }
    const startedAt = Date.now();
    setSecsLeft(TURN_SECS);
    const tick = window.setInterval(() => {
      const left = TURN_SECS - Math.floor((Date.now() - startedAt) / 1000);
      setSecsLeft(Math.max(0, left));
      if (left <= 0) window.clearInterval(tick); // 到点就停，闪烁交给 UI
    }, 250);
    return () => window.clearInterval(tick);
  }, [gstate?.gid, gstate?.v, gstate?.status]);

  // 退出当前对局 / 大厅，回到初始（任何人随时可用——结算卡死的逃生口）
  const reset = () => {
    setLobby(null);
    setGstate(null);
    setColorPick(null);
    setSwapTake(null);
    setSwapGive(null);
    setClaimPick(null);
    setPending(false);
    hostStateRef.current = null;
    processedAids.current = new Set();
    seenVersion.current = {};
  };

  // —— 房主操作 ——
  const createLobby = () => {
    const gid = `${myId}-${uid()}`;
    const lb = { gid, host: myId, players: [{ id: myId, name: myName }] };
    setLobby(lb); // 乐观显示；回显会再设一次（幂等）
    sendGame({ k: "lobby", ...lb });
  };
  const startDeal = () => {
    const lb = lobbyRef.current;
    if (!lb || lb.host !== myId || lb.players.length < 2) return;
    const s = startGame(lb.gid, lb.players);
    hostStateRef.current = s;
    processedAids.current = new Set();
    seenVersion.current[s.gid] = s.v;
    setGstate(s); // 乐观显示
    sendGame({ k: "state", s });
  };
  const rematch = () => {
    const lb = lobbyRef.current;
    if (!lb || lb.host !== myId) return;
    const gid = `${myId}-${uid()}`;
    const players = lb.players;
    const lb2 = { gid, host: myId, players };
    setLobby(lb2);
    sendGame({ k: "lobby", ...lb2 });
    const s = startGame(gid, players);
    hostStateRef.current = s;
    processedAids.current = new Set();
    seenVersion.current[s.gid] = s.v;
    setGstate(s);
    sendGame({ k: "state", s });
  };

  // —— 加入 ——
  const joinLobby = () => {
    if (!lobby) return;
    sendGame({ k: "join", gid: lobby.gid, player: { id: myId, name: myName } });
  };

  // —— 玩家动作（含房主自己，统一走 action + 回显，房主端处理）——
  const act = (a: UnoAction) => {
    if (!gstate || pending) return;
    setPending(true);
    window.setTimeout(() => setPending(false), 4000); // 兜底：动作被忽略时别一直卡「出牌中」
    sendGame({ k: "action", gid: gstate.gid, aid: uid(), a });
  };
  const playCard = (card: UnoCard) => {
    if (card.value === "challenge") {
      // 质疑：先选声称维度（同色/同点）
      setClaimPick(card.id);
      return;
    }
    if (card.value === "lightning" || card.value === "kbomb" || card.value === "swap") {
      // 闪电/王炸/替换直接打出，不选色
      act({ type: "play", player: myId, cardId: card.id });
      return;
    }
    if (card.color === "w") {
      setColorPick(card.id);
      return;
    }
    act({ type: "play", player: myId, cardId: card.id });
  };
  const chooseColor = (color: UnoColor) => {
    if (!colorPick) return;
    act({ type: "play", player: myId, cardId: colorPick, chooseColor: color });
    setColorPick(null);
  };

  if (!open) return null;

  const inLobby = !!lobby;
  const g = gstate;
  const myTurn = !!g && g.status === "playing" && g.players[g.turn]?.id === myId;
  const legal = g ? legalCardIds(g, myId) : new Set<string>();
  const myHand = g?.hands[myId] || [];
  const top = g?.discard[g.discard.length - 1];
  const pend = g?.pendingDraw ?? 0; // 叠牌待罚数
  const inv = g?.invasion; // 侵袭判定中的需求（同色/同点），存在则为应招阶段
  const invColor = inv ? COLOR_NAME[inv.color] : "";
  const ps = g?.pendingSwap; // 替换待决
  const mySwap = !!ps && ps.from === myId; // 轮到我做替换选牌
  const offeredCards = ps ? (g!.hands[ps.target] || []).filter((c) => ps.offered.includes(c.id)) : [];
  const ch = g?.challenge; // 质疑待决
  const canChallenge = !!ch && ch.pending.includes(myId); // 我还没表态，可质疑/不质疑
  const iAmChallenged = !!ch && ch.from === myId; // 我是被质疑的出牌人

  // 手牌排序：先颜色(红黄绿蓝、变色最后)，再点数/功能，看着顺手
  const COLOR_RANK: Record<string, number> = { r: 0, y: 1, g: 2, b: 3, w: 4 };
  const valRank = (v: string) =>
    /^[0-9]$/.test(v)
      ? Number(v)
      : ({ skip: 10, rev: 11, d2: 12, wild: 13, wd4: 14, wrev: 15, lightning: 16, kbomb: 17, swap: 18, challenge: 19 } as Record<string, number>)[v] ?? 99;
  const sortedHand = [...myHand].sort(
    (a, b) => COLOR_RANK[a.color] - COLOR_RANK[b.color] || valRank(a.value) - valRank(b.value),
  );

  return (
    <div className="uno-overlay">
      <div className="uno-head">
        <span className="uno-title">🎴 UNO</span>
        <div className="uno-head-btns">
          {(inLobby || g) && (
            <button className="uno-leave" title="退出当前对局，回到开局界面" onClick={reset}>退出</button>
          )}
          <button className="uno-x" title="收起面板（不结束对局）" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* 没有 lobby：开局 / 等待 */}
      {!inLobby && (
        <div className="uno-idle">
          <p>和群里的朋友来一局 UNO（2–4 人）。</p>
          <button className="uno-btn primary" onClick={createLobby}>开一局（我当房主）</button>
          <p className="uno-hint">或者等别人开局后，这里会出现「加入」。双方都先点开本面板。</p>
        </div>
      )}

      {/* 有 lobby 但还没发牌：等待区 */}
      {inLobby && !g && (
        <div className="uno-lobby">
          <div className="uno-lobby-title">
            房间：房主 {lobby!.players.find((p) => p.id === lobby!.host)?.name || "?"}
          </div>
          <ul className="uno-players">
            {lobby!.players.map((p) => (
              <li key={p.id}>
                {p.name}
                {p.id === lobby!.host ? " 👑" : ""}
                {p.id === myId ? "（你）" : ""}
              </li>
            ))}
          </ul>
          {amHost ? (
            <>
              <button className="uno-btn primary" disabled={lobby!.players.length < 2} onClick={startDeal}>
                {lobby!.players.length < 2 ? "至少 2 人才能开始" : `发牌开始（${lobby!.players.length} 人）`}
              </button>
              <p className="uno-hint">让朋友在他的面板里点「加入」，人到齐后点发牌。</p>
            </>
          ) : lobby!.players.some((p) => p.id === myId) ? (
            <p className="uno-hint">已加入，等房主发牌…</p>
          ) : (
            <button className="uno-btn primary" onClick={joinLobby}>加入</button>
          )}
        </div>
      )}

      {/* 对局中 / 结束 */}
      {g && (
        <div className="uno-board">
          {/* 其他玩家 + 手牌数 + 当前回合 */}
          <div className="uno-seats">
            {g.players.map((p, i) => {
              const cnt = g.hands[p.id]?.length ?? 0;
              const uno = cnt === 1; // 剩 1 张高亮提醒
              const zapped = g.lightning?.onPlayer === p.id; // 头上挂着闪电
              return (
                <span
                  key={p.id}
                  className={`uno-seat${i === g.turn ? " turn" : ""}${p.id === myId ? " me" : ""}${uno ? " uno1" : ""}${zapped ? " zapped" : ""}`}
                  title={zapped ? "头上挂着⚡闪电，轮到他时判定" : undefined}
                >
                  {zapped ? "⚡" : ""}
                  {p.name} {p.id === myId ? "" : `(${cnt})`}
                  {uno ? " ⚠UNO" : ""}
                  {i === g.turn && g.status === "playing" ? " ←" : ""}
                </span>
              );
            })}
            <span className="uno-dir">{g.dir === 1 ? "顺序 ↻" : "逆序 ↺"}</span>
          </div>

          {/* 牌桌：整片按当前颜色染色（一眼看清现在是什么色），中间放大「要压的牌」 */}
          <div className="uno-table" style={{ background: `${COLOR_HEX[g.curColor]}26`, borderColor: `${COLOR_HEX[g.curColor]}` }}>
            <div className="uno-pile">
              <span className="uno-pile-label">牌堆</span>
              <div className="uno-back">{g.drawPile.length}</div>
            </div>
            <div className="uno-center">
              <span className="uno-center-label">↓ 压这张</span>
              {top && <CardChip card={top} big />}
            </div>
            <div className="uno-curcolor-box">
              <span className="uno-curcolor-label">当前色</span>
              <span className="uno-curcolor" style={{ background: COLOR_HEX[g.curColor] }} title="当前颜色">
                {COLOR_NAME[g.curColor]}
              </span>
            </div>
          </div>

          {/* 状态提示 */}
          {g.status === "over" ? (
            <div className="uno-over">
              <div className="uno-over-text">🎉 {g.players.find((p) => p.id === g.winner)?.name || "某人"} 获胜！</div>
              <div className="uno-over-btns">
                {amHost ? (
                  <button className="uno-btn primary" onClick={rematch}>再来一局</button>
                ) : (
                  <span className="uno-hint">等房主「再来一局」，或自己退出开新局</span>
                )}
                <button className="uno-btn" onClick={reset}>退出</button>
              </div>
            </div>
          ) : (
            <div className={`uno-turnbar${myTurn ? " mine" : ""}${inv ? " invasion" : ""}`}>
              {inv && <span className="uno-stack inv">⚔侵袭 需 {invColor} 或 {inv.value}</span>}
              {pend > 0 && <span className="uno-stack">累计 +{pend}</span>}
              {pending
                ? "出牌中…"
                : ch
                  ? canChallenge
                    ? `❓ ${g.players.find((p) => p.id === ch.from)?.name} 声称有「${ch.label}」，质疑还是不质疑？`
                    : iAmChallenged
                      ? `❓ 你声称有「${ch.label}」，等其他人表态…`
                      : `❓ 等其他人对「${ch.label}」表态…`
                  : ps
                    ? mySwap
                      ? "🔄 替换：从下家翻出的牌里留 1 张、给出自己 1 张"
                      : `${g.players.find((p) => p.id === ps.from)?.name} 正在替换…`
                    : inv
                    ? myTurn
                      ? `应招：打出 ${invColor} 或 ${inv.value} 的牌`
                      : `${g.players[g.turn]?.name} 正在应招侵袭…`
                    : myTurn
                      ? pend > 0
                        ? `轮到你：接同类把 +${pend} 甩给下家，或摸 ${pend} 张`
                        : "轮到你了"
                      : `等待 ${g.players[g.turn]?.name} 出牌…`}
              <span className={`uno-timer${secsLeft === 0 ? " over" : secsLeft <= 5 ? " urgent" : ""}`}>
                {secsLeft === 0 ? "⏰超时" : `⏱${secsLeft}`}
              </span>
            </div>
          )}

          {/* 我的手牌（已排序） */}
          <div className="uno-hand-label">我的手牌（{myHand.length}）{myHand.length === 1 && <span className="uno-callout">UNO!</span>}</div>
          <div className="uno-hand">
            {sortedHand.map((card) => {
              const canHit = myTurn && !pending && legal.has(card.id);
              return (
                <CardChip
                  key={card.id}
                  card={card}
                  dim={myTurn && !canHit}
                  onClick={canHit ? () => playCard(card) : undefined}
                />
              );
            })}
            {myHand.length === 0 && g.status === "playing" && <span className="uno-hint">手牌已空</span>}
          </div>

          {/* 行动按钮（侵袭应招 / 质疑阶段不显示摸牌/过） */}
          {g.status === "playing" && myTurn && !inv && !ch && (
            <div className="uno-actions">
              {!g.justDrew && (
                <button className="uno-btn" disabled={pending} onClick={() => act({ type: "draw", player: myId })}>
                  {pend > 0 ? `摸 ${pend} 张` : "摸牌"}
                </button>
              )}
              {g.justDrew && <button className="uno-btn" disabled={pending} onClick={() => act({ type: "pass", player: myId })}>过</button>}
              {myHand.length === 1 && <span className="uno-callout">UNO!</span>}
            </div>
          )}

          {/* 质疑表态按钮（其余玩家各自一组） */}
          {g.status === "playing" && canChallenge && (
            <div className="uno-actions uno-challenge">
              <button className="uno-btn primary" disabled={pending} onClick={() => act({ type: "challenge", player: myId, doChallenge: true })}>质疑</button>
              <button className="uno-btn" disabled={pending} onClick={() => act({ type: "challenge", player: myId, doChallenge: false })}>不质疑</button>
            </div>
          )}

          {/* 日志 */}
          <div className="uno-log">
            {g.log.slice(-4).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {/* 变色选色 */}
      {colorPick && (
        <div className="uno-colorpick" onClick={() => setColorPick(null)}>
          <div className="uno-colorpick-box" onClick={(e) => e.stopPropagation()}>
            <div className="uno-colorpick-title">选个颜色</div>
            <div className="uno-colorpick-row">
              {(["r", "y", "g", "b"] as UnoColor[]).map((c) => (
                <button key={c} className="uno-colorbtn" style={{ background: COLOR_HEX[c] }} onClick={() => chooseColor(c)}>
                  {COLOR_NAME[c]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 替换选牌（仅出牌人可见可操作） */}
      {g && mySwap && ps && (
        <div className="uno-colorpick">
          <div className="uno-colorpick-box uno-swap-box" onClick={(e) => e.stopPropagation()}>
            <div className="uno-colorpick-title">
              🔄 替换 · 从 {g.players.find((p) => p.id === ps.target)?.name} 翻出 {offeredCards.length} 张
            </div>
            <div className="uno-swap-sec">留 1 张进自己手里：</div>
            <div className="uno-swap-row">
              {offeredCards.map((c) => (
                <span key={c.id} className={`uno-swap-pick${swapTake === c.id ? " sel" : ""}`}>
                  <CardChip card={c} onClick={() => setSwapTake(c.id)} />
                </span>
              ))}
            </div>
            <div className="uno-swap-sec">给出自己 1 张：</div>
            <div className="uno-swap-row uno-swap-hand">
              {sortedHand.map((c) => (
                <span key={c.id} className={`uno-swap-pick${swapGive === c.id ? " sel" : ""}`}>
                  <CardChip card={c} onClick={() => setSwapGive(c.id)} />
                </span>
              ))}
            </div>
            <div className="uno-swap-btns">
              <button
                className="uno-btn primary"
                disabled={!swapTake || !swapGive || pending}
                onClick={() => act({ type: "swap", player: myId, takeCardId: swapTake!, giveCardId: swapGive! })}
              >
                确定替换
              </button>
              <button className="uno-btn" disabled={pending} onClick={() => act({ type: "swap", player: myId })}>
                放弃替换
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 质疑牌声称维度（同色 / 同点） */}
      {g && claimPick && top && (
        <div className="uno-colorpick" onClick={() => setClaimPick(null)}>
          <div className="uno-colorpick-box" onClick={(e) => e.stopPropagation()}>
            <div className="uno-colorpick-title">❓ 质疑 · 声称你手里有…</div>
            <div className="uno-colorpick-row">
              <button
                className="uno-btn primary"
                onClick={() => { act({ type: "play", player: myId, cardId: claimPick, claim: "color" }); setClaimPick(null); }}
              >
                {COLOR_NAME[g.curColor]}色（同色）
              </button>
              <button
                className="uno-btn primary"
                onClick={() => { act({ type: "play", player: myId, cardId: claimPick, claim: "value" }); setClaimPick(null); }}
              >
                {cardFace(top)}（同点）
              </button>
            </div>
            <div className="uno-hint" style={{ marginTop: 10 }}>真有→质疑你的人摸牌；没有(诈唬)→被质疑你就摸牌</div>
          </div>
        </div>
      )}
    </div>
  );
}
