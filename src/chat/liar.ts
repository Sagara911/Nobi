// 骗子酒馆·说谎者扑克 引擎（纯函数，不依赖 React / 网络 / Tauri，可单测）。
// 设计：房主持权威 LiarState，应用动作后广播快照；其余端只渲染收到的快照（与 UNO 同一套路）。
// 规则：20 张牌 = A/K/Q 各 6 + Joker ×2（Joker 百搭，算任意点）。
//   每轮：洗牌、给每个存活玩家发 5 张、随机定一张「桌面牌」(A/K/Q)。
//   轮到你只能二选一：①盖着打出 1-3 张，声称「都是桌面牌」(真假随你诈唬)；②喊「骗子!」质疑上家刚打的牌。
//     手里没牌时只能质疑；本轮首家没有可质疑对象，只能出牌。
//   质疑即摊牌——翻开上家刚打的那几张：全是桌面牌或 Joker → 质疑者输；有一张不符 → 出牌的骗子输。
//   输家开一枪（俄罗斯轮盘）：每人一把左轮，6 膛、开局随机 1 发实弹，按膛位顺序扣扳机（递增命中：1/6→1/5→…）。
//     空枪=活、中弹=出局。一次质疑后本轮即结束，进入结算展示，再重新发牌开新一轮。
//   最后存活的人获胜。回合倒计时是 UI 侧的（超时只闪烁提醒，不在引擎里自动操作）。

export type LiarRank = "A" | "K" | "Q";

export interface LiarCard {
  id: string; // 每张物理牌唯一，用于 React key / 动作引用
  rank: LiarRank | "joker"; // joker=百搭
}

export interface LiarPlayer {
  id: string; // = 聊天 clientId
  name: string;
}

/** 一把左轮：6 膛、bulletAt 为实弹膛位，chamber 为下次要扣的膛位，按顺序推进（递增命中） */
export interface LiarGun {
  chamber: number; // 下一次扣扳机的膛位 0..5
  bulletAt: number; // 实弹所在膛位 0..5（开局随机）
  pulls: number; // 已扣过几次扳机（展示紧张度用）
  dead: boolean; // 已中弹出局
}

export interface LiarState {
  gid: string; // 一局唯一 id（房主开局时定）
  v: number; // 快照版本号，单调递增；端上只接受更新的版本
  status: "lobby" | "playing" | "over";
  players: LiarPlayer[]; // 座位顺序
  alive: Record<string, boolean>; // playerId -> 是否还在局（未出局）
  guns: Record<string, LiarGun>; // playerId -> 左轮状态
  hands: Record<string, LiarCard[]>; // playerId -> 手牌（全量；各端只显示自己的）
  rank: LiarRank; // 本轮桌面牌
  turn: number; // players 下标（当前该行动者）
  lastPlay?: { player: string; cards: LiarCard[] }; // 上家盖着打出的牌（唯一可被质疑的一手）
  roundPlayed: number; // 本轮已盖着打出的总张数（展示用）
  roundNo: number; // 第几轮
  // 质疑结算展示态：存在时本轮暂停，等 next 动作推进下一轮。
  result?: {
    challenger: string; // 喊骗子的人
    target: string; // 被质疑的出牌人
    cards: LiarCard[]; // 摊开的牌
    lie: boolean; // 上家是否说谎
    loser: string; // 开枪的人
    died: boolean; // 是否中弹出局
    chamber: number; // 这次扣的膛位（展示用）
  };
  winner?: string; // 最后幸存者 id
  log: string[]; // 简短事件日志（末尾最新，最多留 20 条）
}

const RANKS: LiarRank[] = ["A", "K", "Q"];
const CHAMBERS = 6; // 左轮膛数

/** 每点数张数（A/K/Q 各 6） */
const PER_RANK = 6;
/** Joker（百搭）张数 */
const JOKER_COUNT = 2;
/** 每人每轮发牌数 */
const HAND_SIZE = 5;

/** 随机源（可在测试里替换为确定序列）。默认 Math.random。 */
export let liarRand: () => number = () => Math.random();
export function setLiarRand(fn: () => number) {
  liarRand = fn;
}
const randInt = (n: number) => Math.floor(liarRand() * n);

/** Fisher–Yates 原地洗牌（房主端权威即可） */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 20 张：A/K/Q 各 6 + Joker ×2（id 唯一） */
export function buildLiarDeck(): LiarCard[] {
  const deck: LiarCard[] = [];
  let n = 0;
  for (const r of RANKS) for (let i = 0; i < PER_RANK; i++) deck.push({ id: `${r}-${n++}`, rank: r });
  for (let i = 0; i < JOKER_COUNT; i++) deck.push({ id: `j-${n++}`, rank: "joker" });
  return deck;
}

const log = (s: LiarState, msg: string): string[] => [...s.log, msg].slice(-20);
const nameOf = (s: LiarState, id: string) => s.players.find((p) => p.id === id)?.name || "某人";

const RANK_NAME: Record<string, string> = { A: "A", K: "K", Q: "Q", joker: "🃏Joker" };
/** 摊牌时把一手牌拼成可读串 */
export function revealStr(cards: LiarCard[]): string {
  return cards.map((c) => RANK_NAME[c.rank]).join(" ");
}

/** 座位顺序里从 from 之后的下一个存活玩家下标（绕一圈找不到就返回 from） */
function nextAlive(s: LiarState, from: number): number {
  const n = s.players.length;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + 1) % n;
    if (s.alive[s.players[i].id]) return i;
  }
  return from;
}

/** 扣一次扳机（就地改 gun）：命中 bulletAt→死；否则膛位前移（下次更险）。返回这次扣的膛位 + 是否中弹。 */
function pull(g: LiarGun): { died: boolean; chamber: number } {
  const chamber = g.chamber;
  g.pulls++;
  if (chamber === g.bulletAt) {
    g.dead = true;
    return { died: true, chamber };
  }
  g.chamber = (g.chamber + 1) % CHAMBERS;
  return { died: false, chamber };
}

/** 发新一轮：洗牌、给每个存活玩家发 5 张、随机桌面牌、由 starter 先出。清空上一轮残留。 */
function dealRound(s: LiarState, starter: number): LiarState {
  const deck = shuffle(buildLiarDeck());
  const hands: Record<string, LiarCard[]> = {};
  for (const p of s.players) hands[p.id] = [];
  for (const p of s.players) if (s.alive[p.id]) hands[p.id] = deck.splice(0, HAND_SIZE);
  const rank = RANKS[randInt(RANKS.length)];
  return {
    ...s,
    v: s.v + 1,
    hands,
    rank,
    turn: starter,
    lastPlay: undefined,
    roundPlayed: 0,
    result: undefined,
    roundNo: s.roundNo + 1,
    log: log(s, `🃏 第 ${s.roundNo + 1} 轮：桌面牌是「${rank}」，每人 ${HAND_SIZE} 张，${nameOf(s, s.players[starter].id)} 先出`),
  };
}

/** 开局：每人一把上好膛的左轮，发第一轮。players 为座位顺序。 */
export function startLiar(gid: string, players: LiarPlayer[]): LiarState {
  const alive: Record<string, boolean> = {};
  const guns: Record<string, LiarGun> = {};
  for (const p of players) {
    alive[p.id] = true;
    guns[p.id] = { chamber: 0, bulletAt: randInt(CHAMBERS), pulls: 0, dead: false };
  }
  const base: LiarState = {
    gid,
    v: 1,
    status: "playing",
    players,
    alive,
    guns,
    hands: {},
    rank: "Q",
    turn: 0,
    roundPlayed: 0,
    roundNo: 0,
    log: [`开局！${players.map((p) => p.name).join("、")} 入座，每人面前摆好一把左轮…`],
  };
  return dealRound(base, 0);
}

export type LiarAction =
  | { type: "play"; player: string; cardIds: string[] } // 盖牌出 1-3 张，声称都是本轮桌面牌
  | { type: "challenge"; player: string } // 喊「骗子!」质疑上家
  | { type: "next"; player: string }; // 结算后推进下一轮（任意端可发，房主执行）

/**
 * 应用一个动作，返回新状态（版本 +1）。非法动作原样返回（房主端据此忽略）。
 * 房主收到任意端的动作后调用它，再广播新快照。
 */
export function applyLiar(s: LiarState, a: LiarAction): LiarState {
  if (s.status !== "playing") return s;

  // 结算展示中：只接受 next（推进下一轮 / 结束）
  if (s.result) {
    if (a.type !== "next") return s;
    return nextRound(s);
  }
  if (a.type === "next") return s; // 没有待结算时无效

  const me = s.players[s.turn];
  if (!me || me.id !== a.player) return s; // 不是该你行动
  if (!s.alive[a.player]) return s; // 出局者不能动

  if (a.type === "play") {
    const hand = s.hands[a.player] || [];
    const ids = a.cardIds || [];
    if (ids.length < 1 || ids.length > 3) return s; // 一次盖 1-3 张
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) return s; // 有重复 id
    const picked = hand.filter((c) => idSet.has(c.id));
    if (picked.length !== idSet.size) return s; // 选了不在手里的牌
    const rest = hand.filter((c) => !idSet.has(c.id));
    return {
      ...s,
      v: s.v + 1,
      hands: { ...s.hands, [a.player]: rest },
      lastPlay: { player: a.player, cards: picked }, // 覆盖上一手（旧的那手已不可质疑，弃掉）
      roundPlayed: s.roundPlayed + picked.length,
      turn: nextAlive(s, s.turn),
      log: log(s, `${nameOf(s, a.player)} 盖着打出 ${picked.length} 张，声称都是「${s.rank}」`),
    };
  }

  // challenge
  if (!s.lastPlay) return s; // 本轮首家没有可质疑对象
  const lp = s.lastPlay;
  const lie = lp.cards.some((c) => c.rank !== s.rank && c.rank !== "joker"); // 有一张既非桌面牌也非百搭 = 说谎
  const loser = lie ? lp.player : a.player;
  const guns = { ...s.guns, [loser]: { ...s.guns[loser] } };
  const shot = pull(guns[loser]);
  const alive = shot.died ? { ...s.alive, [loser]: false } : s.alive;
  let lg = log(
    s,
    lie
      ? `${nameOf(s, a.player)} 喊「骗子!」——摊牌：${revealStr(lp.cards)}，${nameOf(s, lp.player)} 说谎了！`
      : `${nameOf(s, a.player)} 喊「骗子!」——摊牌：${revealStr(lp.cards)}，全真！冤枉了 ${nameOf(s, lp.player)}`,
  );
  lg = [...lg, shot.died ? `💥 ${nameOf(s, loser)} 中弹出局…` : `🔫 ${nameOf(s, loser)} 扣下扳机——空枪，活着`].slice(-20);
  return {
    ...s,
    v: s.v + 1,
    guns,
    alive,
    result: { challenger: a.player, target: lp.player, cards: lp.cards, lie, loser, died: shot.died, chamber: shot.chamber },
    log: lg,
  };
}

/** 结算后推进：存活 ≤1 人则结束；否则由开枪者（活着）或其下家起手发新一轮。 */
function nextRound(s: LiarState): LiarState {
  const r = s.result;
  const aliveList = s.players.filter((p) => s.alive[p.id]);
  if (aliveList.length <= 1) {
    const w = aliveList[0]?.id;
    return {
      ...s,
      v: s.v + 1,
      status: "over",
      winner: w,
      result: undefined,
      log: log(s, w ? `🏆 ${nameOf(s, w)} 是最后的幸存者，赢了！` : "全员阵亡…"),
    };
  }
  let starter = r ? s.players.findIndex((p) => p.id === r.loser) : 0;
  if (starter < 0 || !s.alive[s.players[starter].id]) starter = nextAlive(s, starter < 0 ? 0 : starter);
  return dealRound({ ...s, result: undefined }, starter);
}
