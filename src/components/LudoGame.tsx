// 飞行棋对局面板（嵌在聊天窗里）。沿用 UNO 的房主权威 + 广播快照 + 聊天通道传输。
// 棋盘用「方环」简化布局（52 格环 + 各色回家通道 + 四角机库 + 中心终点），几何可靠、位置/撞子一目了然。
// 规则引擎见 ../chat/ludo。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type LudoState,
  type LudoColor,
  type LudoPlayer,
  type LudoAction,
  RING_OFFSET,
  ringCell,
  startGame,
  applyAction,
  movablePlanes,
} from "../chat/ludo";
import "./LudoGame.css";

/** 聊天正文里的飞行棋事件前缀（带控制字符，正常聊天不会出现），ChatRoom 据此分流 */
export const LUDO_TAG = "LUDO";

export type LEvent =
  | { k: "lobby"; gid: string; host: string; players: LudoPlayer[] }
  | { k: "join"; gid: string; id: string; name: string }
  | { k: "state"; s: LudoState }
  | { k: "action"; gid: string; aid: string; a: LudoAction };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const COLORS: LudoColor[] = ["r", "y", "g", "b"];
const HEX: Record<LudoColor, string> = { r: "#e0413a", y: "#e8b21f", g: "#3a9e4d", b: "#2f6fdd" };

// —— 棋盘几何（方环）——
const VB = 300;
const M = 26; // 环到边的内缩
function ringXY(i: number): { x: number; y: number } {
  const side = Math.floor(i / 13);
  const t = (i % 13) / 13;
  const lo = M, hi = VB - M, span = hi - lo;
  if (side === 0) return { x: lo + span * t, y: lo }; // 上：左→右
  if (side === 1) return { x: hi, y: lo + span * t }; // 右：上→下
  if (side === 2) return { x: hi - span * t, y: hi }; // 下：右→左
  return { x: lo, y: hi - span * t }; // 左：下→上
}
const CENTER = { x: VB / 2, y: VB / 2 };
const cornerXY = (c: LudoColor) => ringXY(RING_OFFSET[c]);
function homeXY(c: LudoColor, h: number): { x: number; y: number } {
  if (h >= 5) return CENTER; // rel 56 = 终点
  const k = cornerXY(c);
  const f = (h + 1) / 6;
  return { x: k.x + (CENTER.x - k.x) * f, y: k.y + (CENTER.y - k.y) * f };
}
const BASE_ANCHOR: Record<LudoColor, { x: number; y: number }> = {
  r: { x: 13, y: 13 },
  y: { x: VB - 13, y: 13 },
  g: { x: VB - 13, y: VB - 13 },
  b: { x: 13, y: VB - 13 },
};
function baseXY(c: LudoColor, idx: number): { x: number; y: number } {
  const a = BASE_ANCHOR[c];
  return { x: a.x + (idx % 2) * 13 - 6.5, y: a.y + Math.floor(idx / 2) * 13 - 6.5 };
}
/** 一架飞机的棋盘坐标（rel: -1 机库 / 0..50 主环 / 51..56 回家通道·终点） */
function planeXY(c: LudoColor, rel: number, idx: number): { x: number; y: number } {
  if (rel === -1) return baseXY(c, idx);
  if (rel <= 50) return ringXY(ringCell(c, rel));
  return homeXY(c, rel - 51);
}

export default function LudoGame({
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
  sendGame: (ev: LEvent) => void;
  subscribeGame: (fn: (ev: LEvent) => void) => () => void;
  onClose: () => void;
}) {
  const [lobby, setLobby] = useState<{ gid: string; host: string; players: LudoPlayer[] } | null>(null);
  const [gstate, setGstate] = useState<LudoState | null>(null);
  const [pending, setPending] = useState(false);

  const hostStateRef = useRef<LudoState | null>(null);
  const processedAids = useRef<Set<string>>(new Set());
  const seenVersion = useRef<Record<string, number>>({});
  const leftGids = useRef<Set<string>>(new Set()); // 点过「退出」的局 id：之后该局快照一律不收，不被拉回
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;
  const sendRef = useRef(sendGame);
  sendRef.current = sendGame;

  const amHost = !!lobby && lobby.host === myId;

  const handle = useCallback(
    (ev: LEvent) => {
      const send = sendRef.current;
      if (ev.k === "lobby") {
        setLobby({ gid: ev.gid, host: ev.host, players: ev.players });
        setGstate((cur) => (cur && cur.gid !== ev.gid ? null : cur));
        return;
      }
      if (ev.k === "join") {
        const lb = lobbyRef.current;
        if (!lb || lb.host !== myId || lb.gid !== ev.gid) return;
        if (hostStateRef.current) return; // 已开局不再加人
        if (lb.players.some((p) => p.id === ev.id)) return; // 去重
        if (lb.players.length >= 4) return; // 最多 4 人
        const color = COLORS[lb.players.length];
        const players = [...lb.players, { id: ev.id, name: ev.name, color }];
        send({ k: "lobby", gid: lb.gid, host: lb.host, players });
        return;
      }
      if (ev.k === "state") {
        if (leftGids.current.has(ev.s.gid)) return; // 已退出这局：忽略后续快照，不被拉回
        const seen = seenVersion.current[ev.s.gid] || 0;
        if (ev.s.v <= seen) return;
        seenVersion.current[ev.s.gid] = ev.s.v;
        setGstate(ev.s);
        return;
      }
      if (ev.k === "action") {
        const host = hostStateRef.current;
        if (!host || host.gid !== ev.gid) return;
        if (processedAids.current.has(ev.aid)) return;
        processedAids.current.add(ev.aid);
        if (processedAids.current.size > 800) processedAids.current = new Set(); // 防长会话无限增长
        const ns = applyAction(host, ev.a);
        if (ns === host) return; // 非法动作忽略
        hostStateRef.current = ns;
        send({ k: "state", s: ns });
        return;
      }
    },
    [myId],
  );

  useEffect(() => subscribeGame(handle), [subscribeGame, handle]);
  useEffect(() => {
    setPending(false); // 收到新快照即清「等待」
  }, [gstate]);

  const reset = () => {
    const gid = lobbyRef.current?.gid; // 标记这局「已离开」，之后该局快照一律不收
    if (gid) leftGids.current.add(gid);
    setLobby(null);
    setGstate(null);
    setPending(false);
    hostStateRef.current = null;
    processedAids.current = new Set();
    seenVersion.current = {};
  };

  // —— 房主 ——
  const createLobby = () => {
    const gid = `${myId}-${uid()}`;
    const lb = { gid, host: myId, players: [{ id: myId, name: myName, color: COLORS[0] }] };
    setLobby(lb);
    sendGame({ k: "lobby", ...lb });
  };
  const startMatch = () => {
    const lb = lobbyRef.current;
    if (!lb || lb.host !== myId || lb.players.length < 2) return;
    const s = startGame(lb.gid, lb.players);
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
    const lb2 = { gid, host: myId, players: lb.players };
    setLobby(lb2);
    sendGame({ k: "lobby", ...lb2 });
    const s = startGame(gid, lb.players);
    hostStateRef.current = s;
    processedAids.current = new Set();
    seenVersion.current[s.gid] = s.v;
    setGstate(s);
    sendGame({ k: "state", s });
  };

  // —— 加入 ——
  const joinLobby = () => {
    if (!lobby) return;
    sendGame({ k: "join", gid: lobby.gid, id: myId, name: myName });
  };

  // —— 动作 ——
  const act = (a: LudoAction) => {
    if (!gstate || pending) return;
    setPending(true);
    window.setTimeout(() => setPending(false), 4000);
    sendGame({ k: "action", gid: gstate.gid, aid: uid(), a });
  };

  if (!open) return null;

  const g = gstate;
  const inLobby = !!lobby;
  const myTurn = !!g && g.status === "playing" && g.players[g.turn]?.id === myId;
  const meColor = g?.players.find((p) => p.id === myId)?.color;
  const movable = g && myTurn && g.phase === "move" && meColor
    ? movablePlanes(g.planes[myId], g.dice)
    : [];

  return (
    <div className="ludo-overlay">
      <div className="ludo-head">
        <span className="ludo-title">🎲 飞行棋</span>
        <div className="ludo-head-btns">
          {(inLobby || g) && (
            <button className="ludo-leave" title="退出当前对局" onClick={reset}>退出</button>
          )}
          <button className="ludo-x" title="收起面板（不结束对局）" onClick={onClose}>✕</button>
        </div>
      </div>

      {!inLobby && (
        <div className="ludo-idle">
          <p>和群里的朋友来盘飞行棋（2–4 人）。</p>
          <button className="ludo-btn primary" onClick={createLobby}>开一局（我当房主）</button>
          <p className="ludo-hint">或等别人开局后点「加入」。双方都先点开本面板。</p>
        </div>
      )}

      {inLobby && !g && (
        <div className="ludo-lobby">
          <ul className="ludo-players">
            {lobby!.players.map((p) => (
              <li key={p.id}>
                <span className="ludo-chip" style={{ background: HEX[p.color] }} />
                {p.name}
                {p.id === lobby!.host ? " 👑" : ""}
                {p.id === myId ? "（你）" : ""}
              </li>
            ))}
          </ul>
          {amHost ? (
            <>
              <button className="ludo-btn primary" disabled={lobby!.players.length < 2} onClick={startMatch}>
                {lobby!.players.length < 2 ? "至少 2 人才能开始" : `开始（${lobby!.players.length} 人）`}
              </button>
              <p className="ludo-hint">让朋友点「加入」，人到齐后开始。</p>
            </>
          ) : lobby!.players.some((p) => p.id === myId) ? (
            <p className="ludo-hint">已加入，等房主开始…</p>
          ) : (
            <button className="ludo-btn primary" onClick={joinLobby}>加入</button>
          )}
        </div>
      )}

      {g && (
        <div className="ludo-board-wrap">
          {/* 棋盘 */}
          <svg className="ludo-board" viewBox={`0 0 ${VB} ${VB}`}>
            {/* 机库底色 */}
            {COLORS.map((c) => {
              const a = BASE_ANCHOR[c];
              return <rect key={"base" + c} x={a.x - 16} y={a.y - 16} width={32} height={32} rx={6} fill={HEX[c]} opacity={0.18} />;
            })}
            {/* 主环格 */}
            {Array.from({ length: 52 }, (_, i) => {
              const p = ringXY(i);
              const startColor = COLORS.find((c) => RING_OFFSET[c] === i);
              return (
                <circle key={"r" + i} cx={p.x} cy={p.y} r={5.5}
                  fill={startColor ? HEX[startColor] : "#2a2c33"}
                  stroke="#44464d" strokeWidth={1} />
              );
            })}
            {/* 回家通道 */}
            {COLORS.flatMap((c) =>
              Array.from({ length: 5 }, (_, h) => {
                const p = homeXY(c, h);
                return <circle key={"h" + c + h} cx={p.x} cy={p.y} r={5} fill={HEX[c]} opacity={0.4} />;
              }),
            )}
            {/* 中心终点 */}
            <circle cx={CENTER.x} cy={CENTER.y} r={13} fill="#1c1d22" stroke="#55575f" strokeWidth={1.5} />
            <text x={CENTER.x} y={CENTER.y + 4} textAnchor="middle" fontSize={11} fill="#9a9ba2">终点</text>

            {/* 飞机 */}
            {g.players.flatMap((pl) =>
              g.planes[pl.id].map((rel, idx) => {
                const base = planeXY(pl.color, rel, idx);
                const off = rel === -1 ? { x: 0, y: 0 } : { x: (idx % 2) * 5 - 2.5, y: Math.floor(idx / 2) * 5 - 2.5 };
                const x = base.x + off.x, y = base.y + off.y;
                const canMove = pl.id === myId && !pending && movable.includes(idx);
                return (
                  <circle
                    key={pl.id + idx}
                    cx={x}
                    cy={y}
                    r={6}
                    fill={HEX[pl.color]}
                    stroke={canMove ? "#fff" : "#1a1b1f"}
                    strokeWidth={canMove ? 2.5 : 1.5}
                    className={canMove ? "ludo-plane movable" : "ludo-plane"}
                    onClick={canMove ? () => act({ type: "move", player: myId, plane: idx }) : undefined}
                  />
                );
              }),
            )}
          </svg>

          {/* 座位条 */}
          <div className="ludo-seats">
            {g.players.map((p, i) => (
              <span key={p.id} className={`ludo-seat${i === g.turn ? " turn" : ""}`}>
                <span className="ludo-chip" style={{ background: HEX[p.color] }} />
                {p.name}{p.id === myId ? "(你)" : ""}
                <span className="ludo-done">{g.planes[p.id].filter((v) => v === 56).length}/4</span>
              </span>
            ))}
          </div>

          {/* 状态 / 操作 */}
          {g.status === "over" ? (
            <div className="ludo-over">
              <div className="ludo-over-text">🎉 {g.players.find((p) => p.id === g.winner)?.name || "某人"} 获胜！</div>
              <div className="ludo-over-btns">
                {amHost && <button className="ludo-btn primary" onClick={rematch}>再来一局</button>}
                <button className="ludo-btn" onClick={reset}>退出</button>
              </div>
            </div>
          ) : (
            <div className="ludo-actbar">
              <span className="ludo-die">{g.dice || "·"}</span>
              {pending ? (
                <span className="ludo-status">等待…</span>
              ) : myTurn ? (
                g.phase === "roll" ? (
                  <button className="ludo-btn primary" onClick={() => act({ type: "roll", player: myId })}>掷骰子</button>
                ) : (
                  <span className="ludo-status hot">点一架高亮的飞机走（掷出 {g.dice}）</span>
                )
              ) : (
                <span className="ludo-status">等 {g.players[g.turn]?.name} 行动…</span>
              )}
            </div>
          )}

          <div className="ludo-log">
            {g.log.slice(-3).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}
