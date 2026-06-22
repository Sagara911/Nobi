// 骗子酒馆·说谎者扑克 对局面板（嵌在聊天窗里）。走聊天通道传「游戏事件」，房主持权威状态广播快照。
// 传输靠 Supabase realtime 回显（自己发的消息也会经 onMessage 回来）；用版本号 / 动作 id 去重。
// 整套房主权威 + 心跳 + 掉线接管 + 倒计时与 UNO 同源（见 UnoGame.tsx）。规则引擎见 ../chat/liar。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type LiarState,
  type LiarCard,
  type LiarPlayer,
  type LiarAction,
  startLiar,
  applyLiar,
  revealStr,
} from "../chat/liar";
import "./LiarGame.css";

/** 聊天正文里的游戏事件前缀（控制字符 ，正常聊天不会出现）；ChatRoom 据此分流、不显示在消息流 */
export const LIAR_TAG = "LIAR";

export type LiarEvent =
  | { k: "lobby"; gid: string; host: string; players: LiarPlayer[] }
  | { k: "join"; gid: string; player: LiarPlayer }
  | { k: "state"; s: LiarState }
  | { k: "action"; gid: string; aid: string; a: LiarAction };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const TURN_SECS = 30; // 每回合限时；超时只闪烁提醒，不自动操作
const RESULT_MS = 5200; // 结算展示时长：房主到点自动发牌进下一轮
const HOST_GONE_MS = 15000; // 超过这么久没收到房主同步（心跳每 3s 一次）→ 视为房主可能掉线

const RANK_HEX: Record<string, string> = { A: "#e0413a", K: "#2f6fdd", Q: "#3a9e4d", joker: "#caa23a" };

/** 单张牌正面字符 */
function cardFace(card: LiarCard): string {
  return card.rank === "joker" ? "🃏" : card.rank;
}

/** 一张牌（正面/背面）。back=只显示牌背（盖着的牌 / 别人的手牌占位） */
function LiarCardChip({ card, back, sel, onClick }: { card?: LiarCard; back?: boolean; sel?: boolean; onClick?: () => void }) {
  if (back || !card) {
    return <span className="liar-card back" />;
  }
  return (
    <button
      className={`liar-card${sel ? " sel" : ""}${onClick ? " playable" : ""}`}
      style={{ color: RANK_HEX[card.rank] }}
      disabled={!onClick}
      onClick={onClick}
    >
      {cardFace(card)}
    </button>
  );
}

export default function LiarGame({
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
  sendGame: (ev: LiarEvent) => void;
  subscribeGame: (fn: (ev: LiarEvent) => void) => () => void;
  onClose: () => void;
}) {
  const [lobby, setLobby] = useState<{ gid: string; host: string; players: LiarPlayer[] } | null>(null);
  const [gstate, setGstate] = useState<LiarState | null>(null);
  const [sel, setSel] = useState<string[]>([]); // 选中要盖出的牌 id（1-3 张）
  const [pending, setPending] = useState(false); // 已发出动作、等权威快照回来
  const [secsLeft, setSecsLeft] = useState(TURN_SECS);

  const hostStateRef = useRef<LiarState | null>(null);
  const processedAids = useRef<Set<string>>(new Set());
  const seenVersion = useRef<Record<string, number>>({});
  const lastStateAt = useRef<number>(Date.now());
  const [hostGone, setHostGone] = useState(false);
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;
  const sendRef = useRef(sendGame);
  sendRef.current = sendGame;

  const amHost = !!lobby && lobby.host === myId;

  // 事件处理：所有端共用。房主额外处理 join/action 并广播 state。
  const handle = useCallback(
    (ev: LiarEvent) => {
      const send = sendRef.current;
      if (ev.k === "lobby") {
        setLobby({ gid: ev.gid, host: ev.host, players: ev.players });
        setGstate((cur) => (cur && cur.gid !== ev.gid ? null : cur));
        return;
      }
      if (ev.k === "join") {
        const lb = lobbyRef.current;
        if (!lb || lb.host !== myId || lb.gid !== ev.gid) return;
        if (hostStateRef.current) return; // 已发牌就不再加人
        if (lb.players.some((p) => p.id === ev.player.id)) return;
        const players = [...lb.players, ev.player];
        send({ k: "lobby", gid: lb.gid, host: lb.host, players });
        return;
      }
      if (ev.k === "state") {
        const s = ev.s;
        lastStateAt.current = Date.now();
        setHostGone(false);
        const seen = seenVersion.current[s.gid] || 0;
        if (s.v <= seen) return;
        seenVersion.current[s.gid] = s.v;
        setGstate(s);
        return;
      }
      if (ev.k === "action") {
        const host = hostStateRef.current;
        if (!host || host.gid !== ev.gid) return;
        if (processedAids.current.has(ev.aid)) return;
        processedAids.current.add(ev.aid);
        const ns = applyLiar(host, ev.a);
        if (ns === host) return; // 非法动作
        hostStateRef.current = ns;
        send({ k: "state", s: ns });
        return;
      }
    },
    [myId],
  );

  useEffect(() => subscribeGame(handle), [subscribeGame, handle]);

  // 房主心跳：每 3 秒重广播一次权威状态，救回漏收快照而卡住的端
  useEffect(() => {
    if (!amHost) return;
    const t = window.setInterval(() => {
      const s = hostStateRef.current;
      if (s && s.status === "playing") sendRef.current({ k: "state", s });
    }, 3000);
    return () => window.clearInterval(t);
  }, [amHost]);

  // 房主：质疑结算展示到点 → 自动发牌进下一轮（无人操作也能继续）
  const hasResult = !!gstate?.result;
  useEffect(() => {
    if (!amHost || !hasResult) return;
    const t = window.setTimeout(() => {
      const s = hostStateRef.current;
      if (!s || !s.result) return;
      const ns = applyLiar(s, { type: "next", player: myId });
      if (ns === s) return;
      hostStateRef.current = ns;
      sendRef.current({ k: "state", s: ns });
    }, RESULT_MS);
    return () => window.clearTimeout(t);
  }, [amHost, hasResult, myId]);

  // 非房主：长时间收不到房主同步 → 显示接管入口
  useEffect(() => {
    if (amHost || gstate?.status !== "playing") {
      setHostGone(false);
      return;
    }
    const t = window.setInterval(() => {
      if (Date.now() - lastStateAt.current > HOST_GONE_MS) setHostGone(true);
    }, 2000);
    return () => window.clearInterval(t);
  }, [amHost, gstate?.status]);

  useEffect(() => {
    setPending(false);
  }, [gstate]);

  // 轮次/回合切换时清空选牌
  useEffect(() => {
    setSel([]);
  }, [gstate?.turn, gstate?.roundNo, gstate?.result]);

  // 回合倒计时：每个新回合本地起计时；归零只闪烁提醒
  useEffect(() => {
    if (!gstate || gstate.status !== "playing" || gstate.result) {
      setSecsLeft(TURN_SECS);
      return;
    }
    const startedAt = Date.now();
    setSecsLeft(TURN_SECS);
    const tick = window.setInterval(() => {
      const left = TURN_SECS - Math.floor((Date.now() - startedAt) / 1000);
      setSecsLeft(Math.max(0, left));
      if (left <= 0) window.clearInterval(tick);
    }, 250);
    return () => window.clearInterval(tick);
  }, [gstate?.gid, gstate?.v, gstate?.turn, gstate?.status, gstate?.result]);

  const reset = () => {
    setLobby(null);
    setGstate(null);
    setSel([]);
    setPending(false);
    hostStateRef.current = null;
    processedAids.current = new Set();
    seenVersion.current = {};
    setHostGone(false);
  };

  const takeOverHost = () => {
    const g = gstate;
    if (!g) return;
    hostStateRef.current = g;
    processedAids.current = new Set();
    seenVersion.current[g.gid] = g.v;
    const lb = { gid: g.gid, host: myId, players: g.players };
    setLobby(lb);
    setHostGone(false);
    sendGame({ k: "lobby", ...lb });
    sendGame({ k: "state", s: g });
  };

  // —— 房主操作 ——
  const createLobby = () => {
    const gid = `${myId}-${uid()}`;
    const lb = { gid, host: myId, players: [{ id: myId, name: myName }] };
    setLobby(lb);
    sendGame({ k: "lobby", ...lb });
  };
  const startDeal = () => {
    const lb = lobbyRef.current;
    if (!lb || lb.host !== myId || lb.players.length < 2) return;
    const s = startLiar(lb.gid, lb.players);
    hostStateRef.current = s;
    processedAids.current = new Set();
    seenVersion.current[s.gid] = s.v;
    setGstate(s);
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
    const s = startLiar(gid, players);
    hostStateRef.current = s;
    processedAids.current = new Set();
    seenVersion.current[s.gid] = s.v;
    setGstate(s);
    sendGame({ k: "state", s });
  };

  const joinLobby = () => {
    if (!lobby) return;
    sendGame({ k: "join", gid: lobby.gid, player: { id: myId, name: myName } });
  };

  // —— 玩家动作（统一走 action + 回显，房主端处理）——
  const act = (a: LiarAction) => {
    if (!gstate || pending) return;
    setPending(true);
    window.setTimeout(() => setPending(false), 4000); // 兜底：动作被忽略时别一直卡
    sendGame({ k: "action", gid: gstate.gid, aid: uid(), a });
  };

  if (!open) return null;

  const inLobby = !!lobby;
  const g = gstate;
  const result = g?.result;
  const myTurn = !!g && g.status === "playing" && !result && g.players[g.turn]?.id === myId && !!g.alive[myId];
  const myHand = g?.hands[myId] || [];
  const canChallenge = myTurn && !!g?.lastPlay;
  const mustChallenge = myTurn && myHand.length === 0; // 没牌只能质疑
  const successorId = g && lobby ? g.players.find((p) => p.id !== lobby.host && g.alive[p.id])?.id : undefined;
  const iAmSuccessor = !!successorId && successorId === myId;

  const toggleSel = (id: string) =>
    setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));

  return (
    <div className="liar-overlay">
      <div className="liar-head">
        <span className="liar-title">🍷 骗子酒馆</span>
        <div className="liar-head-btns">
          {(inLobby || g) && (
            <button className="liar-leave" title="退出当前对局，回到开局界面" onClick={reset}>退出</button>
          )}
          <button className="liar-x" title="收起面板（不结束对局）" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* 开局 / 等待 */}
      {!inLobby && !g && (
        <div className="liar-idle">
          <p>说谎者扑克：盖牌诈唬、喊骗子摊牌，输的人对自己开一枪 🔫（2–4 人）。</p>
          <button className="liar-btn primary" onClick={createLobby}>开一局（我当房主）</button>
          <p className="liar-hint">或者等别人开局后，这里会出现「加入」。双方都先点开本面板。</p>
        </div>
      )}

      {/* 大厅等待 */}
      {inLobby && !g && (
        <div className="liar-lobby">
          <div className="liar-lobby-title">
            房间：房主 {lobby!.players.find((p) => p.id === lobby!.host)?.name || "?"}
          </div>
          <ul className="liar-players">
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
              <button className="liar-btn primary" disabled={lobby!.players.length < 2} onClick={startDeal}>
                {lobby!.players.length < 2 ? "至少 2 人才能开始" : `发牌开始（${lobby!.players.length} 人）`}
              </button>
              <p className="liar-hint">让朋友在他的面板里点「加入」，人到齐后点发牌。</p>
            </>
          ) : lobby!.players.some((p) => p.id === myId) ? (
            <p className="liar-hint">已加入，等房主发牌…</p>
          ) : (
            <button className="liar-btn primary" onClick={joinLobby}>加入</button>
          )}
        </div>
      )}

      {/* 对局中 / 结束 */}
      {g && (
        <div className="liar-board">
          {hostGone && !amHost && (
            <div className="liar-hostgone">
              {iAmSuccessor ? (
                <>
                  <span>房主好像掉线了，对局可能卡住。</span>
                  <button className="liar-btn primary" onClick={takeOverHost}>我来接管房主</button>
                </>
              ) : (
                <span>房主好像掉线了，等下一位接管，或点右上角「退出」。</span>
              )}
            </div>
          )}

          {/* 座位：名字 + 手牌数 + 左轮状态（已扣几次/出局） */}
          <div className="liar-seats">
            {g.players.map((p, i) => {
              const cnt = g.hands[p.id]?.length ?? 0;
              const gun = g.guns[p.id];
              const dead = !g.alive[p.id];
              const isTurn = i === g.turn && g.status === "playing" && !result;
              return (
                <span
                  key={p.id}
                  className={`liar-seat${isTurn ? " turn" : ""}${p.id === myId ? " me" : ""}${dead ? " dead" : ""}`}
                  title={dead ? "已出局" : `已扣扳机 ${gun?.pulls ?? 0} 次`}
                >
                  <span className="liar-seat-name">
                    {dead ? "💀 " : ""}
                    {p.name}
                    {p.id === myId ? "（你）" : ` (${cnt})`}
                  </span>
                  <span className="liar-seat-gun">
                    {dead ? "出局" : `🔫×${gun?.pulls ?? 0}`}
                  </span>
                  {isTurn && <span className="liar-seat-arrow">←</span>}
                </span>
              );
            })}
          </div>

          {/* 牌桌中央：本轮桌面牌 + 上家声称 */}
          <div className="liar-table" style={{ borderColor: RANK_HEX[g.rank] }}>
            <div className="liar-rank-box">
              <span className="liar-rank-label">本轮桌面牌</span>
              <span className="liar-rank-big" style={{ background: RANK_HEX[g.rank] }}>{g.rank}</span>
            </div>
            <div className="liar-claim">
              {g.lastPlay ? (
                <>
                  <div className="liar-claim-pile">
                    {g.lastPlay.cards.map((_, k) => <LiarCardChip key={k} back />)}
                  </div>
                  <div className="liar-claim-text">
                    {g.players.find((p) => p.id === g.lastPlay!.player)?.name} 盖出 {g.lastPlay.cards.length} 张，
                    声称都是「{g.rank}」
                  </div>
                </>
              ) : (
                <div className="liar-claim-text dim">等 {g.players[g.turn]?.name} 先出牌…</div>
              )}
              {g.roundPlayed > 0 && <div className="liar-claim-sub">本轮已盖出 {g.roundPlayed} 张</div>}
            </div>
          </div>

          {/* 状态条 / 结束 */}
          {g.status === "over" ? (
            <div className="liar-over">
              <div className="liar-over-text">🏆 {g.players.find((p) => p.id === g.winner)?.name || "无人"} 是最后的幸存者！</div>
              <div className="liar-over-btns">
                {amHost ? (
                  <button className="liar-btn primary" onClick={rematch}>再来一局</button>
                ) : (
                  <span className="liar-hint">等房主「再来一局」，或自己退出开新局</span>
                )}
                <button className="liar-btn" onClick={reset}>退出</button>
              </div>
            </div>
          ) : (
            <div className={`liar-turnbar${myTurn ? " mine" : ""}`}>
              {pending
                ? "处理中…"
                : result
                  ? "摊牌中…"
                  : myTurn
                    ? mustChallenge
                      ? "你没牌了，只能喊「骗子!」"
                      : "轮到你：盖牌出 1–3 张，或喊「骗子!」"
                    : `等待 ${g.players[g.turn]?.name} 行动…`}
              {!result && (
                <span className={`liar-timer${secsLeft === 0 ? " over" : secsLeft <= 5 ? " urgent" : ""}`}>
                  {secsLeft === 0 ? "⏰超时" : `⏱${secsLeft}`}
                </span>
              )}
            </div>
          )}

          {/* 我的手牌 */}
          {g.status === "playing" && (
            <>
              <div className="liar-hand-label">
                我的手牌（{myHand.length}）
                {myTurn && !mustChallenge && <span className="liar-callout">选 1–3 张盖出</span>}
              </div>
              <div className="liar-hand">
                {myHand.map((card) => (
                  <LiarCardChip
                    key={card.id}
                    card={card}
                    sel={sel.includes(card.id)}
                    onClick={myTurn && !pending && !mustChallenge ? () => toggleSel(card.id) : undefined}
                  />
                ))}
                {myHand.length === 0 && <span className="liar-hint">手牌已空——只能喊骗子</span>}
              </div>

              {/* 行动按钮 */}
              {myTurn && (
                <div className="liar-actions">
                  {!mustChallenge && (
                    <button
                      className="liar-btn primary"
                      disabled={pending || sel.length < 1 || sel.length > 3}
                      onClick={() => act({ type: "play", player: myId, cardIds: sel })}
                    >
                      {sel.length ? `盖出 ${sel.length} 张（声称${g.rank}）` : "盖出（先选牌）"}
                    </button>
                  )}
                  <button
                    className="liar-btn danger"
                    disabled={pending || !canChallenge}
                    title={canChallenge ? "翻开上家的牌对质" : "本轮还没人出牌，不能质疑"}
                    onClick={() => act({ type: "challenge", player: myId })}
                  >
                    喊「骗子!」🔫
                  </button>
                </div>
              )}
            </>
          )}

          {/* 日志 */}
          <div className="liar-log">
            {g.log.slice(-4).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {/* 摊牌结算弹层 */}
      {g && result && (
        <div className="liar-reveal">
          <div className="liar-reveal-box">
            <div className="liar-reveal-title">
              {g.players.find((p) => p.id === result.challenger)?.name} 喊了「骗子!」
            </div>
            <div className="liar-reveal-sub">
              翻开 {g.players.find((p) => p.id === result.target)?.name} 盖的牌（本轮：{g.rank}）
            </div>
            <div className="liar-reveal-cards">
              {result.cards.map((c, k) => (
                <span key={k} className={`liar-reveal-card${c.rank === g.rank || c.rank === "joker" ? " ok" : " bad"}`} style={{ color: RANK_HEX[c.rank] }}>
                  {cardFace(c)}
                </span>
              ))}
            </div>
            <div className={`liar-reveal-verdict ${result.lie ? "lie" : "true"}`}>
              {result.lie ? `说谎！(${revealStr(result.cards)})` : `全真！冤枉了好人`}
            </div>
            <div className={`liar-reveal-shot ${result.died ? "dead" : "safe"}`}>
              {result.died
                ? `💥 ${g.players.find((p) => p.id === result.loser)?.name} 中弹出局…`
                : `🔫 ${g.players.find((p) => p.id === result.loser)?.name} 扣下扳机——空枪，活着`}
            </div>
            {amHost ? (
              <button
                className="liar-btn primary"
                onClick={() => act({ type: "next", player: myId })}
              >
                继续下一轮
              </button>
            ) : (
              <div className="liar-hint">稍候自动进入下一轮…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
