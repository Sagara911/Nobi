// 飞行棋引擎（纯函数，不依赖 React / 网络）。沿用 UNO 的房主权威 + 广播快照模式。
// v1 规则：2–4 人，各执一色 4 架飞机；掷 6 才起飞；走子；落到主环上对手棋子格→送对手回家（己方叠放）；
//          需精确点数进终点(56)；掷 6 再掷一次；四子全到终点获胜。
// 暂不做：「飞」(同色格前跳) / 捷径斜跳 / 安全格 / 连掷三个 6 罚回——核心跑通后再加。

export type LudoColor = "r" | "y" | "g" | "b";
export interface LudoPlayer {
  id: string; // = 聊天 clientId
  name: string;
  color: LudoColor;
}

/** 每色在主环(0..51)上的起点偏移。四色均匀分布、相隔 13。 */
export const RING_OFFSET: Record<LudoColor, number> = { r: 0, y: 13, g: 26, b: 39 };
export const RING_LEN = 52;
/** 飞机相对自家起点的步数：-1=机库；0..50=主环；51..55=回家通道；56=终点。 */
export const HOME = 56;

export interface LudoState {
  gid: string;
  v: number;
  status: "lobby" | "playing" | "over";
  players: LudoPlayer[];
  planes: Record<string, number[]>; // playerId -> 4 架飞机的相对位置
  turn: number; // players 下标
  phase: "roll" | "move"; // 等掷骰 / 已掷等选子
  dice: number; // 最近一次骰子点数（0=未掷）
  winner?: string;
  log: string[];
}

/** 骰子函数（可在测试里替换为确定序列）。默认 1..6 均匀。 */
export let rollFn: () => number = () => 1 + Math.floor(Math.random() * 6);
export function setRollFn(fn: () => number) {
  rollFn = fn;
}

const log = (s: LudoState, msg: string): string[] => [...s.log, msg].slice(-20);
const nameOf = (s: LudoState, id: string) => s.players.find((p) => p.id === id)?.name || "某人";

/** 主环绝对格号（仅 0..50 有效；回家通道/机库不在主环上、不参与撞子） */
export function ringCell(color: LudoColor, rel: number): number {
  return (RING_OFFSET[color] + rel) % RING_LEN;
}

/** 开局：四色按入座顺序分配；各 4 架飞机入库。 */
export function startGame(gid: string, players: LudoPlayer[]): LudoState {
  const planes: Record<string, number[]> = {};
  for (const p of players) planes[p.id] = [-1, -1, -1, -1];
  return {
    gid,
    v: 1,
    status: "playing",
    players,
    planes,
    turn: 0,
    phase: "roll",
    dice: 0,
    log: [`开局！${players.map((p) => p.name).join("、")} 各执一色，掷 6 起飞`],
  };
}

/** 当前点数下某玩家可走的飞机下标 */
export function movablePlanes(planes: number[], roll: number): number[] {
  const out: number[] = [];
  planes.forEach((p, i) => {
    if (p === HOME) return; // 已到终点
    if (p === -1) {
      if (roll === 6) out.push(i); // 机库：掷 6 才起飞
      return;
    }
    if (p + roll <= HOME) out.push(i); // 在途：不能冲过终点
  });
  return out;
}

export type LudoAction =
  | { type: "roll"; player: string }
  | { type: "move"; player: string; plane: number };

/** 把一架飞机按点数前进，并结算撞子（返回被撞回家的数量）。直接改 s。 */
function doMove(s: LudoState, pid: string, idx: number, roll: number): number {
  const planes = s.planes[pid];
  const np = planes[idx] === -1 ? 0 : planes[idx] + roll; // 起飞落到 0(起点格)
  planes[idx] = np;
  let captured = 0;
  if (np >= 0 && np <= 50) {
    const me = s.players.find((p) => p.id === pid)!;
    const myAbs = ringCell(me.color, np);
    for (const other of s.players) {
      if (other.id === pid) continue; // 己方叠放、不撞
      const op = s.planes[other.id];
      for (let j = 0; j < op.length; j++) {
        if (op[j] >= 0 && op[j] <= 50 && ringCell(other.color, op[j]) === myAbs) {
          op[j] = -1; // 送回机库
          captured++;
        }
      }
    }
  }
  return captured;
}

/** 走完一步后：判胜 → 决定续掷(掷6)或换手。直接改 s 并返回。 */
function finishTurn(s: LudoState, pid: string, roll: number): LudoState {
  if (s.planes[pid].every((p) => p === HOME)) {
    s.status = "over";
    s.winner = pid;
    s.log = log(s, `🎉 ${nameOf(s, pid)} 四子全部到家，获胜！`);
    return s;
  }
  if (roll === 6) {
    s.phase = "roll"; // 掷 6 续掷，同一玩家
  } else {
    s.phase = "roll";
    s.turn = (s.turn + 1) % s.players.length;
  }
  return s;
}

/**
 * 应用一个动作，返回新状态（版本 +1）。非法/无效动作原样返回原对象（房主据此忽略）。
 * roll：房主端生成骰子；0 可走→自动换手，1 个可走→自动走，多个→进 move 等选子。
 */
export function applyAction(s: LudoState, a: LudoAction): LudoState {
  if (s.status !== "playing") return s;
  if (s.players[s.turn]?.id !== a.player) return s;

  if (a.type === "roll") {
    if (s.phase !== "roll") return s;
    const ns: LudoState = JSON.parse(JSON.stringify(s));
    ns.v = s.v + 1;
    const die = rollFn();
    ns.dice = die;
    ns.log = log(ns, `${nameOf(ns, a.player)} 掷出 ${die}`);
    const mv = movablePlanes(ns.planes[a.player], die);
    if (mv.length === 0) {
      ns.log = log(ns, `${nameOf(ns, a.player)} 无子可走，跳过`);
      ns.turn = (ns.turn + 1) % ns.players.length; // 无子可走直接换手（即便掷 6）
      ns.phase = "roll";
      return ns;
    }
    if (mv.length === 1) {
      doMove(ns, a.player, mv[0], die);
      return finishTurn(ns, a.player, die);
    }
    ns.phase = "move"; // 多个可走，等玩家点选
    return ns;
  }

  if (a.type === "move") {
    if (s.phase !== "move") return s;
    const mv = movablePlanes(s.planes[a.player], s.dice);
    if (!mv.includes(a.plane)) return s; // 不是合法可走子
    const ns: LudoState = JSON.parse(JSON.stringify(s));
    ns.v = s.v + 1;
    doMove(ns, a.player, a.plane, ns.dice);
    return finishTurn(ns, a.player, ns.dice);
  }

  return s;
}
