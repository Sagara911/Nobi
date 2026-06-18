// UNO 游戏引擎（纯函数，不依赖 React / 网络 / Tauri，可单测）。
// 设计：房主持权威 UnoState，应用动作后广播快照；其余端只渲染收到的快照。
// 规则：标准 108 张；跳过/反转/+2/变色/+4变色；反转在 2 人局当跳过；+4 随时可出（不校验无同色）；不做未喊 UNO 罚牌。
//       **+2/+4 同类叠牌**：被 +2 罚时可接 +2 把累计罚牌甩给下家(+4 接 +4)；接不住就一次摸完累计的牌、跳过自己。
//       **摸到能出为止**：出不了牌时摸牌动作会一直摸到摸出能压的牌（或牌摸光），摸到的能出牌可打或过。
//       **炸弹**：牌堆里的陷阱，摸到引爆（摇骰子多摸真牌）；不进手不可出。
//       **电击**：牌堆里的陷阱，摸到直接 +2 张真牌；电击牌本身洗回牌堆继续循环（不进手不可出）。
//       **闪电**（仿三国杀）：可持可出的牌，当变色牌随时打出，但不进弃牌堆/不改色，而是「挂」在出牌人头上；
//         论一圈后从出牌人开始，每当轮到被挂者，判定一次：命中(随机)→该玩家摸 4 张、闪电消失；
//         未命中→闪电顺位移到下家头上。同时只存在一片闪电。
//       **王炸**：可持可出的牌，打出后除自己外每个玩家各摸 4 张；牌本身用完洗回牌堆继续循环（不进弃牌堆/不改色）。
//       **四色反转**（wrev）：变色牌版反转，随时可出、出时选色，效果同反转（2 人局当跳过/再出一张）。
//       **侵袭**（普通数字牌带角标 inv）：打出后进入「侵袭判定」——其他玩家按出牌顺序轮流应招：
//         手里有同色或同点的牌就必须打出一张（其功能不触发），没有则自动摸 2；全部应招后从侵袭者下家继续正常出牌。
//       **替换**（swap，四色万能）：打出后从下家手里随机翻 2 张（只出牌人可见），留 1 张进手、塞自己 1 张给下家
//         （没选中那张留在下家手里，双方手牌数不变）；可放弃。牌本身用完洗回牌堆，不进弃牌堆/不改色。
//       **质疑**（challenge，四色万能诈唬牌）：打出时声称「手里有同色 / 同点的牌」，其余玩家各自选质疑或不质疑：
//         若声称属实→质疑者摸 1；若是诈唬→出牌人摸 1（按质疑人数各算一次）。不质疑者无事。牌用完洗回牌堆。
//       回合倒计时是 UI 侧的（超时只闪烁提醒，不在引擎里做任何自动操作）。

export type UnoColor = "r" | "y" | "g" | "b";
/** 牌面值：0-9 数字，或 skip(跳过) rev(反转) d2(+2) wild(变色) wd4(+4变色) */
export type UnoValue =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "skip" | "rev" | "d2" | "wild" | "wd4"
  | "bomb"  // 炸弹：埋在牌堆里的陷阱，摸到即引爆（摇骰子摸几张），不进手、不可出
  | "shock"  // 电击：埋在牌堆里的陷阱，摸到直接 +2 张；牌本身洗回牌堆继续循环，不进手、不可出
  | "lightning"  // 闪电：可持可出，当变色牌打出后挂玩家头上，论圈判定命中→摸4、未中→移下家
  | "kbomb"  // 王炸：可持可出，打出后除自己外每人各摸 4 张；用完洗回牌堆，不进弃牌堆、不改色
  | "wrev"  // 四色反转：变色牌版反转，随时可出、出时选色，效果同反转
  | "swap"  // 替换：四色万能，打出后与下家盲选换 1 张牌；用完洗回牌堆，不进弃牌堆/不改色
  | "challenge"; // 质疑：四色万能诈唬牌，声称有同色/同点的牌，其余玩家各自质疑；用完洗回牌堆

export interface UnoCard {
  id: string; // 每张物理牌唯一，用于 React key / 动作引用
  inv?: boolean; // 侵袭角标：普通数字牌带此标记，正常出牌但落地后发动侵袭判定
  color: UnoColor | "w"; // "w" = 变色牌（出牌时再定色）
  value: UnoValue;
}

export interface UnoPlayer {
  id: string; // = 聊天 clientId
  name: string;
}

export interface UnoState {
  gid: string; // 一局唯一 id（房主开局时定）
  v: number; // 快照版本号，单调递增；端上只接受更新的版本
  status: "lobby" | "playing" | "over";
  players: UnoPlayer[]; // 座位顺序
  hands: Record<string, UnoCard[]>; // playerId -> 手牌（全量；各端只显示自己的）
  drawPile: UnoCard[];
  discard: UnoCard[]; // 末尾为顶牌
  curColor: UnoColor; // 当前有效颜色（变色牌出后由出牌人指定）
  turn: number; // players 下标
  dir: 1 | -1; // 出牌方向
  justDrew: boolean; // 当前玩家本回合已摸牌（只能再打摸到的那张或过）
  drawnCardId?: string; // 刚摸到的牌 id（摸牌后唯一可出的牌）
  pendingDraw: number; // 叠牌累计待罚摸牌数（>0 时当前玩家只能接同类 +2/+4，或一次摸完跳过）
  pendingSwap?: { from: string; target: string; offered: string[]; card: UnoCard }; // 替换待决：from=出牌人(仍是当前回合)，target=下家，offered=翻出的下家牌id(≤2)，card=替换牌本体
  challenge?: { from: string; dim: "color" | "value"; label: string; trueClaim: boolean; pending: string[]; card: UnoCard }; // 质疑待决：from=出牌人，dim=声称维度，label=声称内容(展示用)，trueClaim=声称是否属实，pending=还没表态的其他玩家，card=质疑牌本体
  invasion?: { color: UnoColor; value: string; from: string }; // 侵袭判定进行中：需匹配的色/点 + 侵袭者(回合转回他即判定结束)
  lightning?: { card: UnoCard; onPlayer: string }; // 头上挂着的闪电（同时只一片）：card=物理牌，onPlayer=被挂者
  winner?: string; // 清空手牌者 id
  log: string[]; // 简短事件日志（末尾最新，最多留 20 条）
}

const COLORS: UnoColor[] = ["r", "y", "g", "b"];

/** 炸弹张数（掺进牌堆的陷阱） */
const BOMB_COUNT = 6;

/** 电击张数（掺进牌堆的陷阱；摸到 +2 张，自身洗回牌堆循环） */
const SHOCK_COUNT = 4;

/** 摸到电击牌时直接追加的真牌数 */
const SHOCK_DRAW = 2;

/** 闪电张数（可发到手里、可出的牌） */
const LIGHTNING_COUNT = 2;

/** 闪电命中时被劈中者摸的牌数 */
const LIGHTNING_DRAW = 4;

/** 闪电判定：unoRoll() === 此值视为命中（约 1/6） */
const LIGHTNING_HIT_ON = 1;

/** 王炸张数（可发到手里、可出的牌） */
const KBOMB_COUNT = 2;

/** 王炸打出时，除自己外每个玩家各摸的牌数 */
const KBOMB_DRAW = 4;

/** 四色反转张数（变色牌版反转） */
const WREV_COUNT = 4;

/** 替换牌张数（四色万能换牌） */
const SWAP_COUNT = 4;

/** 替换时从下家手里翻出供挑选的张数 */
const SWAP_OFFER = 2;

/** 质疑牌张数（四色万能诈唬牌） */
const CHALLENGE_COUNT = 4;

/** 质疑结算时摸的牌数（质疑错=质疑者摸，质疑对=出牌人摸） */
const CHALLENGE_DRAW = 1;

/** 侵袭角标张数（挑这么多张普通数字牌打上角标） */
const INVASION_COUNT = 6;

/** 侵袭判定中，应招不出（无同色同点）时自动摸的牌数 */
const INVASION_DRAW = 2;

/** 一张牌是否满足侵袭判定（同色或同点；变色牌 color "w" 不算匹配） */
const matchesInvasion = (c: UnoCard, inv: { color: UnoColor; value: string }) =>
  c.color === inv.color || c.value === inv.value;

/** 陷阱牌（埋在牌堆里，不进手、不可出）：炸弹 / 电击。闪电/王炸不是陷阱（可持可出）。 */
const isTrap = (c: UnoCard) => c.value === "bomb" || c.value === "shock";

/** 标准 108 张 + 6 张炸弹 + 4 张电击（id 唯一） */
export function buildDeck(): UnoCard[] {
  const deck: UnoCard[] = [];
  let n = 0;
  const add = (color: UnoCard["color"], value: UnoValue) =>
    deck.push({ id: `${color}-${value}-${n++}`, color, value });
  for (const c of COLORS) {
    add(c, "0"); // 每色一张 0
    for (let i = 1; i <= 9; i++) {
      add(c, String(i) as UnoValue);
      add(c, String(i) as UnoValue); // 1-9 每色两张
    }
    for (const a of ["skip", "rev", "d2"] as UnoValue[]) {
      add(c, a);
      add(c, a); // 功能牌每色两张
    }
  }
  for (let i = 0; i < 4; i++) add("w", "wild");
  for (let i = 0; i < 4; i++) add("w", "wd4");
  for (let i = 0; i < BOMB_COUNT; i++) add("w", "bomb"); // 炸弹（color 用 "w" 使其不会被选作起始牌）
  for (let i = 0; i < SHOCK_COUNT; i++) add("w", "shock"); // 电击（同理 color "w" 不会成为起始牌）
  for (let i = 0; i < LIGHTNING_COUNT; i++) add("w", "lightning"); // 闪电（color "w"=可随时出、且不会成为起始牌）
  for (let i = 0; i < KBOMB_COUNT; i++) add("w", "kbomb"); // 王炸（同理 color "w"=可随时出、且不会成为起始牌）
  for (let i = 0; i < WREV_COUNT; i++) add("w", "wrev"); // 四色反转（变色牌版反转，color "w" 不会成为起始牌）
  for (let i = 0; i < SWAP_COUNT; i++) add("w", "swap"); // 替换（四色万能，color "w"=可随时出、且不会成为起始牌）
  for (let i = 0; i < CHALLENGE_COUNT; i++) add("w", "challenge"); // 质疑（四色万能诈唬牌，color "w"=可随时出、且不会成为起始牌）
  // 侵袭角标：在普通数字牌里均匀挑 INVASION_COUNT 张打上角标（确定性，便于测试；发牌前还会洗）
  const nums = deck.filter((c) => /^[0-9]$/.test(c.value));
  for (let i = 0; i < INVASION_COUNT && nums.length; i++) {
    nums[Math.floor((i * nums.length) / INVASION_COUNT)].inv = true;
  }
  return deck;
}

/** 骰子（可在测试里替换为确定序列）。默认 1..6 均匀。 */
export let unoRoll: () => number = () => 1 + Math.floor(Math.random() * 6);
export function setUnoRoll(fn: () => number) {
  unoRoll = fn;
}

/** Fisher–Yates 原地洗牌（房主端用 Math.random，权威即可） */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 一张牌能否压在顶牌上（按当前有效颜色判断） */
export function canPlay(card: UnoCard, top: UnoCard, curColor: UnoColor): boolean {
  if (isTrap(card)) return false; // 陷阱牌（炸弹/电击）永不可出（只是摸牌陷阱，正常也不会进手）
  if (card.color === "w") return true; // 变色牌随时可出
  if (card.color === curColor) return true;
  return card.value === top.value; // 同点数 / 同功能
}

/** 当前玩家此刻可出的牌 id 集合（供 UI 高亮）；摸牌后只剩摸到那张可出 */
export function legalCardIds(s: UnoState, playerId: string): Set<string> {
  const out = new Set<string>();
  if (s.status !== "playing" || s.players[s.turn]?.id !== playerId) return out;
  const top = s.discard[s.discard.length - 1];
  const hand = s.hands[playerId] || [];
  if (s.pendingSwap) return out; // 待替换中：不走普通出牌，交由替换弹窗处理
  if (s.challenge) return out; // 质疑表态中：不走普通出牌，交由质疑按钮处理
  if (s.invasion) {
    // 侵袭应招：只能打出同色或同点的牌（轮到的应招者此时必有匹配，无匹配者已被引擎自动摸牌跳过）
    for (const card of hand) if (matchesInvasion(card, s.invasion)) out.add(card.id);
    return out;
  }
  if (s.pendingDraw > 0) {
    // 叠牌中：只能接同类（+2 接 +2、+4 接 +4），否则只能摸牌
    for (const card of hand) if (card.value === top.value) out.add(card.id);
    return out;
  }
  for (const card of hand) {
    if (s.justDrew && card.id !== s.drawnCardId) continue;
    if (card.value === "lightning" && s.lightning) continue; // 已有一片闪电在场，不能再挂
    if (canPlay(card, top, s.curColor)) out.add(card.id);
  }
  return out;
}

const log = (s: UnoState, msg: string): string[] =>
  [...s.log, msg].slice(-20);

const nameOf = (s: UnoState, id: string) =>
  s.players.find((p) => p.id === id)?.name || "某人";

/** 开局：洗牌、每人发 7、翻一张非变色牌作起始弃牌。players 为座位顺序。 */
export function startGame(gid: string, players: UnoPlayer[]): UnoState {
  const deck = shuffle(buildDeck());
  const hands: Record<string, UnoCard[]> = {};
  // 发牌跳过陷阱：起手牌里不放炸弹/电击（都留在牌堆里当陷阱）。从牌堆按序取 7 张非陷阱牌。
  for (const p of players) {
    const h: UnoCard[] = [];
    while (h.length < 7) {
      const idx = deck.findIndex((c) => !isTrap(c));
      if (idx < 0) break;
      h.push(deck.splice(idx, 1)[0]);
    }
    hands[p.id] = h;
  }
  // 起始牌不能是变色牌/炸弹（都是 color "w"）：找第一张带色牌
  let firstIdx = deck.findIndex((c) => c.color !== "w");
  if (firstIdx < 0) firstIdx = 0;
  const [first] = deck.splice(firstIdx, 1);
  const curColor: UnoColor = first.color === "w" ? "r" : first.color;
  const base: UnoState = {
    gid,
    v: 1,
    status: "playing",
    players,
    hands,
    drawPile: deck,
    discard: [first],
    curColor,
    turn: 0,
    dir: 1,
    justDrew: false,
    pendingDraw: 0,
    log: [`开局！${players.map((p) => p.name).join("、")} 入座，起始牌已翻开`],
  };
  // 起始牌若是功能牌，按对首家生效（简化：跳过/反转影响首家，+2 首家摸2跳过）
  return applyStartCardEffect(base, first);
}

function applyStartCardEffect(s: UnoState, first: UnoCard): UnoState {
  const n = s.players.length;
  if (first.value === "skip") {
    return { ...s, turn: (s.turn + 1) % n, log: log(s, "起始为跳过，首家被跳过") };
  }
  if (first.value === "rev") {
    if (n === 2) return { ...s, turn: (s.turn + 1) % n }; // 2 人=跳过
    return { ...s, dir: -1 as const, turn: (n - 1) % n, log: log(s, "起始为反转，方向逆转") };
  }
  if (first.value === "d2") {
    // 起始 +2：首家面对 +2 叠牌（可接 +2 或摸 2），不直接罚
    return { ...s, pendingDraw: 2, log: log(s, `起始为+2，${nameOf(s, s.players[0].id)} 需接 +2 或摸 2`) };
  }
  return s;
}

export type UnoAction =
  | { type: "play"; player: string; cardId: string; chooseColor?: UnoColor; claim?: "color" | "value" } // claim：质疑牌声称维度
  | { type: "draw"; player: string }
  | { type: "pass"; player: string }
  | { type: "swap"; player: string; takeCardId?: string; giveCardId?: string } // 替换：留 take/给 give；都省略=放弃替换
  | { type: "challenge"; player: string; doChallenge: boolean }; // 质疑表态：true=质疑，false=不质疑

function advance(s: UnoState, steps: number): number {
  const n = s.players.length;
  return ((s.turn + s.dir * steps) % n + n) % n;
}

/** 从牌堆取一张（空了就把弃牌除顶牌洗回牌堆）；返回 null=实在没牌。就地改 pile/discard。 */
function takeOne(pile: UnoCard[], discard: UnoCard[]): UnoCard | null {
  if (!pile.length) {
    if (discard.length <= 1) return null;
    const top = discard[discard.length - 1];
    const rest = discard.slice(0, -1);
    discard.length = 0;
    discard.push(top);
    pile.push(...shuffle(rest));
  }
  return pile.shift() ?? null;
}

/** 把牌洗回牌堆随机位置，使其在后续摸牌中继续循环（不进手、不进弃牌堆）。电击/王炸/替换用完都走这里。 */
function reinsertToPile(pile: UnoCard[], card: UnoCard): void {
  const at = Math.floor(Math.random() * (pile.length + 1));
  pile.splice(at, 0, card);
}

/** 从一手牌里随机挑 k 个 id（替换牌用：盲翻下家几张供出牌人二选一） */
function pickRandomIds(hand: UnoCard[], k: number): string[] {
  const ids = hand.map((c) => c.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(k, ids.length));
}

/** 摸牌途中触发的陷阱统计：炸弹骰子点数、电击次数（记日志用）。 */
interface DrawEvents {
  rolls: number[]; // 每次炸弹摇出的点数
  shocks: number; // 触发电击的次数
}

/** 抽 count 张真牌进 hand；途中摸到炸弹→摇骰子多摸、炸弹移除；摸到电击→直接 +SHOCK_DRAW、电击洗回牌堆。 */
function drawReal(pile: UnoCard[], discard: UnoCard[], hand: UnoCard[], count: number): DrawEvents {
  const ev: DrawEvents = { rolls: [], shocks: 0 };
  let need = count;
  let guard = 0;
  while (need > 0 && guard++ < 400) {
    const c = takeOne(pile, discard);
    if (!c) break;
    if (c.value === "bomb") {
      const r = unoRoll();
      ev.rolls.push(r);
      need += r; // 炸弹移除（不进手不进堆）
    } else if (c.value === "shock") {
      ev.shocks++;
      need += SHOCK_DRAW; // 电击：直接多摸 2 张
      reinsertToPile(pile, c); // 电击牌洗回牌堆继续循环
    } else {
      hand.push(c);
      need--;
    }
  }
  return ev;
}

/** 摸到能出为止：一张张摸进 hand，摸到炸弹就引爆（摇骰多摸真牌），直到摸出能压的牌或牌摸光。
 *  返回 { playableId?, rolls }。 */
function drawUntilPlayable(
  pile: UnoCard[],
  discard: UnoCard[],
  hand: UnoCard[],
  top: UnoCard,
  curColor: UnoColor,
): { playableId?: string } & DrawEvents {
  const ev: DrawEvents = { rolls: [], shocks: 0 };
  let guard = 0;
  while (guard++ < 400) {
    const c = takeOne(pile, discard);
    if (!c) break;
    if (c.value === "bomb") {
      const r = unoRoll();
      ev.rolls.push(r);
      mergeEvents(ev, drawReal(pile, discard, hand, r)); // 引爆：多摸 r 张真牌（嵌套陷阱也处理）
      continue;
    }
    if (c.value === "shock") {
      ev.shocks++;
      reinsertToPile(pile, c); // 电击牌洗回牌堆继续循环
      mergeEvents(ev, drawReal(pile, discard, hand, SHOCK_DRAW)); // 电击：直接多摸 2 张真牌
      continue;
    }
    hand.push(c);
    if (canPlay(c, top, curColor)) return { playableId: c.id, ...ev };
  }
  return { ...ev };
}

/** 合并陷阱事件统计（嵌套触发时累加） */
function mergeEvents(into: DrawEvents, more: DrawEvents): void {
  into.rolls.push(...more.rolls);
  into.shocks += more.shocks;
}

/** 把陷阱事件（炸弹/电击）拼成日志行（可能多行） */
function trapLog(ev: DrawEvents): string[] {
  const lines: string[] = [];
  if (ev.rolls.length) {
    const sum = ev.rolls.reduce((a, b) => a + b, 0);
    lines.push(`💣 摸到炸弹！摇骰子 ${ev.rolls.join("+")}，多摸 ${sum} 张`);
  }
  if (ev.shocks) {
    const n = ev.shocks;
    lines.push(`⚡ 电击${n > 1 ? ` ×${n}` : ""}！直接多摸 ${n * SHOCK_DRAW} 张（电击牌已洗回牌堆）`);
  }
  return lines;
}

/** 摸牌过程是否触发了陷阱（用于判断回合是否真的发生了事） */
const hadTrap = (ev: DrawEvents) => ev.rolls.length > 0 || ev.shocks > 0;

/**
 * 应用一个动作，返回新状态（版本 +1）。非法动作原样返回（房主端据此忽略）。
 * 房主收到任意端的动作后调用它，再广播新快照。
 * 外层在动作生效后追加自动判定：侵袭阶段（无匹配者自动摸牌跳过）优先；否则做闪电入场判定。
 */
export function applyAction(s: UnoState, a: UnoAction): UnoState {
  const ns = applyActionCore(s, a);
  if (ns === s) return s; // 非法/无变化
  // 侵袭阶段独占自动判定（暂停闪电，避免交叉）；侵袭判定结束后下一动作会恢复闪电判定
  if (s.invasion || ns.invasion) return resolveInvasionOnEntry(s, ns);
  return resolveLightningOnEntry(s, ns);
}

function applyActionCore(s: UnoState, a: UnoAction): UnoState {
  if (s.status !== "playing") return s;

  // 质疑表态阶段：任何「还没表态的其他玩家」都能响应（不看 turn）；全部表态完才结束、回收质疑牌、推进回合
  if (s.challenge) {
    if (a.type !== "challenge" || !s.challenge.pending.includes(a.player)) return s;
    const ch = s.challenge;
    const pile = [...s.drawPile];
    const disc = [...s.discard];
    let hands = s.hands;
    let lg = s.log;
    const addLog = (m: string) => { lg = [...lg, m].slice(-20); };
    if (a.doChallenge) {
      // 声称属实→质疑者摸；诈唬→出牌人摸（均经 drawReal，途中会触发炸弹/电击）
      const loser = ch.trueClaim ? a.player : ch.from;
      const h = [...s.hands[loser]];
      const before = h.length;
      const ev = drawReal(pile, disc, h, CHALLENGE_DRAW);
      hands = { ...hands, [loser]: h };
      addLog(ch.trueClaim
        ? `${nameOf(s, a.player)} 质疑失败（${nameOf(s, ch.from)} 真有「${ch.label}」），摸 ${h.length - before} 张`
        : `${nameOf(s, a.player)} 质疑成功（${nameOf(s, ch.from)} 没有「${ch.label}」），${nameOf(s, ch.from)} 摸 ${h.length - before} 张`);
      for (const t of trapLog(ev)) addLog(t);
    } else {
      addLog(`${nameOf(s, a.player)} 选择不质疑`);
    }
    const pending = ch.pending.filter((id) => id !== a.player);
    if (pending.length === 0) {
      reinsertToPile(pile, ch.card); // 全部表态完：质疑牌洗回牌堆
      addLog("质疑结束，继续出牌");
      return {
        ...s, v: s.v + 1, drawPile: pile, discard: disc, hands,
        challenge: undefined, justDrew: false, drawnCardId: undefined,
        turn: advance(s, 1), log: lg,
      };
    }
    return { ...s, v: s.v + 1, drawPile: pile, discard: disc, hands, challenge: { ...ch, pending }, log: lg };
  }
  if (a.type === "challenge") return s; // 没有质疑阶段时无效

  if (s.players[s.turn]?.id !== a.player) return s; // 不是该玩家回合
  const n = s.players.length;
  const top = s.discard[s.discard.length - 1];

  // 替换待决：出牌人必须用 swap 动作完成（留 take/给 give，或都省略=放弃）；其余动作一律拒绝
  if (s.pendingSwap) {
    if (a.type !== "swap") return s;
    const ps = s.pendingSwap;
    if (ps.from !== a.player) return s;
    const pile = [...s.drawPile];
    const myHand = [...s.hands[a.player]];
    const tgtHand = [...s.hands[ps.target]];
    const take = a.takeCardId, give = a.giveCardId;
    // 校验：take 必须是翻出的牌之一且仍在下家手里；give 必须在自己手里
    const takeIdx = take ? tgtHand.findIndex((c) => c.id === take) : -1;
    const giveIdx = give ? myHand.findIndex((c) => c.id === give) : -1;
    const valid = take && give && ps.offered.includes(take) && takeIdx >= 0 && giveIdx >= 0;
    reinsertToPile(pile, ps.card); // 替换牌用完洗回牌堆
    if (!valid) {
      // 放弃替换（或参数不全）：只回收替换牌、推进回合
      return {
        ...s, v: s.v + 1, drawPile: pile, pendingSwap: undefined,
        justDrew: false, drawnCardId: undefined, turn: advance(s, 1),
        log: log(s, `${nameOf(s, a.player)} 放弃了替换`),
      };
    }
    const taken = tgtHand.splice(takeIdx, 1)[0];
    const given = myHand.splice(giveIdx, 1)[0];
    myHand.push(taken);
    tgtHand.push(given);
    return {
      ...s, v: s.v + 1, drawPile: pile, pendingSwap: undefined,
      hands: { ...s.hands, [a.player]: myHand, [ps.target]: tgtHand },
      justDrew: false, drawnCardId: undefined, turn: advance(s, 1),
      log: log(s, `${nameOf(s, a.player)} 用 ${cardLabel(given)} 换走了 ${nameOf(s, ps.target)} 的 1 张牌`),
    };
  }
  if (a.type === "swap") return s; // 没有待替换时的 swap 动作无效

  if (a.type === "draw") {
    if (s.invasion) return s; // 侵袭应招阶段不能主动摸牌（有匹配必须出，无匹配由引擎自动摸）
    const pile = [...s.drawPile];
    const disc = [...s.discard];
    const hand = [...s.hands[a.player]];
    const before = hand.length;
    // 叠牌中摸牌 = 接不住，一次摸完累计罚牌（含炸弹引爆）、跳过自己
    if (s.pendingDraw > 0) {
      const ev = drawReal(pile, disc, hand, s.pendingDraw);
      let lg = log(s, `${nameOf(s, a.player)} 接不住，摸 ${hand.length - before} 张`);
      const traps = trapLog(ev);
      if (traps.length) lg = [...lg, ...traps].slice(-20);
      return {
        ...s, v: s.v + 1, drawPile: pile, discard: disc,
        hands: { ...s.hands, [a.player]: hand },
        pendingDraw: 0, justDrew: false, drawnCardId: undefined,
        turn: advance(s, 1), log: lg,
      };
    }
    if (s.justDrew) return s; // 本回合已摸过
    // 「摸到能出为止」（含炸弹/电击触发）：摸到能压的牌或牌摸光为止
    const { playableId, ...ev } = drawUntilPlayable(pile, disc, hand, top, s.curColor);
    if (hand.length === before && !hadTrap(ev)) return s; // 实在没牌可摸
    let lg = log(s, `${nameOf(s, a.player)} 摸了 ${hand.length - before} 张${playableId ? "（摸到能出的）" : ""}`);
    const traps = trapLog(ev);
    if (traps.length) lg = [...lg, ...traps].slice(-20);
    const ns: UnoState = {
      ...s, v: s.v + 1, drawPile: pile, discard: disc,
      hands: { ...s.hands, [a.player]: hand }, log: lg,
    };
    if (playableId) return { ...ns, justDrew: true, drawnCardId: playableId }; // 摸到能出 → 打或过
    return { ...ns, justDrew: false, drawnCardId: undefined, turn: advance(ns, 1) };
  }

  if (a.type === "pass") {
    if (s.invasion) return s; // 侵袭应招阶段不能过
    if (!s.justDrew) return s; // 只有摸牌后能过
    return {
      ...s,
      v: s.v + 1,
      turn: advance(s, 1),
      justDrew: false,
      drawnCardId: undefined,
      log: log(s, `${nameOf(s, a.player)} 过`),
    };
  }

  // play
  const hand = s.hands[a.player] || [];
  const idx = hand.findIndex((c) => c.id === a.cardId);
  if (idx < 0) return s;
  const card = hand[idx];

  // —— 侵袭应招阶段：当前玩家是应招者，只能打出同色或同点的牌，且其功能不触发，打完轮到下一应招者 ——
  if (s.invasion) {
    if (!matchesInvasion(card, s.invasion)) return s; // 必须同色或同点
    const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    const ns: UnoState = {
      ...s, v: s.v + 1,
      hands: { ...s.hands, [a.player]: newHand },
      discard: [...s.discard, card],
      curColor: card.color === "w" ? s.curColor : (card.color as UnoColor), // 匹配牌必为带色牌
      justDrew: false, drawnCardId: undefined,
      log: log(s, `${nameOf(s, a.player)} 应招打出 ${cardLabel(card)}`),
    };
    if (newHand.length === 0) {
      return { ...ns, status: "over", winner: a.player, invasion: undefined, log: log(ns, `🎉 ${nameOf(s, a.player)} 获胜！`) };
    }
    return { ...ns, turn: advance(ns, 1) }; // 轮到下一应招者（外层 resolver 会自动跳过无匹配者 / 结束判定）
  }

  if (s.pendingDraw > 0) {
    if (card.value !== top.value) return s; // 叠牌中只能接同类（+2/+4）
  } else {
    if (s.justDrew && a.cardId !== s.drawnCardId) return s; // 摸牌后只能出摸到那张
    if (!canPlay(card, top, s.curColor)) return s;
  }

  // 闪电：不进弃牌堆、不改当前色、不需选色；从手里移除挂到出牌人头上（论一圈后从他开始判定）。
  if (card.value === "lightning") {
    if (s.lightning) return s; // 场上已有一片闪电，不能再挂
    const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    const ns: UnoState = {
      ...s, v: s.v + 1,
      hands: { ...s.hands, [a.player]: newHand },
      lightning: { card, onPlayer: a.player },
      justDrew: false, drawnCardId: undefined,
      log: log(s, `${nameOf(s, a.player)} 打出⚡闪电，挂在自己头上（一圈后开始判定）`),
    };
    if (newHand.length === 0) {
      return { ...ns, status: "over", winner: a.player, log: log(ns, `🎉 ${nameOf(s, a.player)} 获胜！`) };
    }
    return { ...ns, turn: advance(ns, 1) };
  }

  // 王炸：不进弃牌堆、不改色、不选色；除自己外每人各摸 KBOMB_DRAW 张，牌用完洗回牌堆。
  if (card.value === "kbomb") {
    const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    const pile = [...s.drawPile];
    const disc = [...s.discard];
    const hands: Record<string, UnoCard[]> = { ...s.hands, [a.player]: newHand };
    const ev: DrawEvents = { rolls: [], shocks: 0 };
    for (const p of s.players) {
      if (p.id === a.player) continue;
      const h = [...hands[p.id]];
      mergeEvents(ev, drawReal(pile, disc, h, KBOMB_DRAW)); // 各摸 4（摸牌途中同样会触发炸弹/电击）
      hands[p.id] = h;
    }
    reinsertToPile(pile, card); // 摸完后王炸牌洗回牌堆继续循环
    let lg = log(s, `${nameOf(s, a.player)} 打出💥王炸！其他人各摸 ${KBOMB_DRAW} 张（王炸牌已回牌堆）`);
    const traps = trapLog(ev);
    if (traps.length) lg = [...lg, ...traps].slice(-20);
    const ns: UnoState = {
      ...s, v: s.v + 1, drawPile: pile, discard: disc, hands,
      justDrew: false, drawnCardId: undefined, log: lg,
    };
    if (newHand.length === 0) {
      return { ...ns, status: "over", winner: a.player, log: log(ns, `🎉 ${nameOf(s, a.player)} 获胜！`) };
    }
    return { ...ns, turn: advance(ns, 1) };
  }

  // 替换：不进弃牌堆、不改色、不选色；从下家盲翻 SWAP_OFFER 张进入「待替换」，回合留在出牌人等其完成。
  if (card.value === "swap") {
    const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    const base = { ...s, v: s.v + 1, hands: { ...s.hands, [a.player]: newHand }, justDrew: false, drawnCardId: undefined };
    if (newHand.length === 0) { // 替换牌是最后一张 → 直接获胜，不触发替换
      return { ...base, status: "over", winner: a.player, log: log(s, `🎉 ${nameOf(s, a.player)} 获胜！`) };
    }
    const targetId = s.players[advance(s, 1)].id;
    const offered = pickRandomIds(s.hands[targetId] || [], SWAP_OFFER);
    if (offered.length === 0) { // 下家没牌可换：回收替换牌、推进回合
      const pile = [...s.drawPile];
      reinsertToPile(pile, card);
      return { ...base, drawPile: pile, turn: advance(s, 1), log: log(s, `${nameOf(s, a.player)} 打出🔄替换，但 ${nameOf(s, targetId)} 没牌可换`) };
    }
    return {
      ...base,
      pendingSwap: { from: a.player, target: targetId, offered, card },
      log: log(s, `${nameOf(s, a.player)} 打出🔄替换，从 ${nameOf(s, targetId)} 翻出 ${offered.length} 张待选`),
    }; // 回合不推进，等出牌人发 swap 动作
  }

  // 质疑：声称手里有同色(curColor) 或同点(top.value) 的牌；其余玩家各自质疑/不质疑，回合留在出牌人等结算。
  if (card.value === "challenge") {
    if (a.claim !== "color" && a.claim !== "value") return s; // 必须声明声称维度
    const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    const base = { ...s, v: s.v + 1, hands: { ...s.hands, [a.player]: newHand }, justDrew: false, drawnCardId: undefined };
    if (newHand.length === 0) { // 质疑牌是最后一张 → 直接获胜，不触发质疑
      return { ...base, status: "over", winner: a.player, log: log(s, `🎉 ${nameOf(s, a.player)} 获胜！`) };
    }
    const trueClaim = a.claim === "color"
      ? newHand.some((c) => c.color === s.curColor)
      : newHand.some((c) => c.value === top.value);
    const label = a.claim === "color" ? COLOR_NAME[s.curColor] : (VALUE_NAME[top.value] || top.value);
    const pending = s.players.filter((p) => p.id !== a.player).map((p) => p.id);
    return {
      ...base,
      challenge: { from: a.player, dim: a.claim, label, trueClaim, pending, card },
      log: log(s, `${nameOf(s, a.player)} 打出❓质疑，声称手里有「${label}」，其余玩家可质疑`),
    }; // 回合不推进，等其余玩家表态
  }

  const isWild = card.color === "w";
  if (isWild && !a.chooseColor) return s; // 变色牌必须选色

  const newHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
  const ns: UnoState = {
    ...s,
    v: s.v + 1,
    hands: { ...s.hands, [a.player]: newHand },
    discard: [...s.discard, card],
    curColor: isWild ? a.chooseColor! : (card.color as UnoColor),
    justDrew: false,
    drawnCardId: undefined,
    log: log(s, `${nameOf(s, a.player)} 出了 ${cardLabel(card, a.chooseColor)}`),
  };

  // 赢：清空手牌
  if (newHand.length === 0) {
    return { ...ns, status: "over", winner: a.player, log: log(ns, `🎉 ${nameOf(s, a.player)} 获胜！`) };
  }

  // 侵袭角标：普通数字牌带 inv，正常落地后发动侵袭判定（其他人轮流应招）
  if (card.inv) {
    return {
      ...ns,
      invasion: { color: ns.curColor, value: card.value, from: a.player },
      turn: advance(ns, 1), // 转到第一个应招者（外层 resolver 自动跳过无匹配者）
      log: log(ns, `${nameOf(s, a.player)} 发动侵袭（${cardLabel(card)}）！其他人需打出同色或同点，否则摸 ${INVASION_DRAW} 张`),
    };
  }

  // 功能效果 → 决定下一手
  switch (card.value) {
    case "skip":
      return { ...ns, turn: advance(ns, 2), log: log(ns, `${nameOf(ns, ns.players[advance(ns, 1)].id)} 被跳过`) };
    case "rev":
    case "wrev": { // 四色反转：效果与普通反转一致（颜色已在上面按 chooseColor 设好）
      if (n === 2) return { ...ns, turn: ns.turn, log: log(ns, "2 人局，反转=再出一张") };
      const flipped = { ...ns, dir: (ns.dir * -1) as 1 | -1 };
      return { ...flipped, turn: advance(flipped, 1), log: log(ns, "方向逆转") };
    }
    case "d2":
    case "wd4": {
      // 叠牌：累加待罚摸牌数，传给下家（下家可继续接同类、或一次摸完）
      const add = card.value === "d2" ? 2 : 4;
      const total = ns.pendingDraw + add;
      return {
        ...ns,
        pendingDraw: total,
        turn: advance(ns, 1),
        log: log(ns, `${cardLabel(card, a.chooseColor)}！累计待罚 ${total} 张，下家接同类或摸牌`),
      };
    }
    default:
      return { ...ns, turn: advance(ns, 1) };
  }
}

/**
 * 侵袭入场判定：侵袭进行中，沿出牌顺序逐个应招者推进——
 * 无同色同点者自动摸 INVASION_DRAW 张并跳到下一位（循环处理连续多个）；有匹配者停下交其交互打出。
 * 回合转回侵袭者即判定结束：清除侵袭态，从侵袭者下家继续正常出牌。
 */
function resolveInvasionOnEntry(_prev: UnoState, ns: UnoState): UnoState {
  let st = ns;
  let guard = 0;
  while (st.status === "playing" && st.invasion && guard++ < 50) {
    const inv = st.invasion;
    const curId = st.players[st.turn].id;
    if (curId === inv.from) {
      // 一圈应招完毕：结束判定，从侵袭者下家继续正常出牌
      return { ...st, invasion: undefined, turn: advance(st, 1), log: log(st, "侵袭判定结束，继续出牌") };
    }
    const hand = st.hands[curId] || [];
    if (hand.some((c) => matchesInvasion(c, inv))) return st; // 有匹配 → 停下，等其交互打出
    // 无匹配 → 自动摸 INVASION_DRAW 张（途中同样会触发炸弹/电击），跳到下一应招者
    const pile = [...st.drawPile];
    const disc = [...st.discard];
    const h = [...hand];
    const before = h.length;
    const ev = drawReal(pile, disc, h, INVASION_DRAW);
    let lg = log(st, `${nameOf(st, curId)} 无同色同点，摸 ${h.length - before} 张`);
    const traps = trapLog(ev);
    if (traps.length) lg = [...lg, ...traps].slice(-20);
    st = {
      ...st, v: st.v + 1, drawPile: pile, discard: disc,
      hands: { ...st.hands, [curId]: h }, turn: advance(st, 1), log: lg,
    };
  }
  return st;
}

/**
 * 闪电入场判定：动作让回合「换人」后，若新的当前玩家头上挂着闪电，自动判定一次。
 * 命中(unoRoll()===LIGHTNING_HIT_ON)→该玩家摸 LIGHTNING_DRAW 张、闪电消失；未中→闪电顺位移到下家。
 * 判定完该玩家照常进行本回合。注意：放置闪电那一刻回合移到下家(≠被挂者)，故天然延迟一圈才首判。
 */
function resolveLightningOnEntry(prev: UnoState, ns: UnoState): UnoState {
  if (ns.status !== "playing" || !ns.lightning) return ns;
  if (ns.turn === prev.turn) return ns; // 回合没换人（如摸到能出停留、2 人反转再出），不触发
  const curId = ns.players[ns.turn]?.id;
  if (ns.lightning.onPlayer !== curId) return ns; // 闪电不在当前回合玩家头上
  const roll = unoRoll();
  if (roll === LIGHTNING_HIT_ON) {
    // 命中：被劈中者摸 4 张（摸牌过程同样会触发炸弹/电击），闪电出场消失
    const pile = [...ns.drawPile];
    const disc = [...ns.discard];
    const hand = [...ns.hands[curId]];
    const before = hand.length;
    const ev = drawReal(pile, disc, hand, LIGHTNING_DRAW);
    let lg = log(ns, `⚡ 闪电劈中 ${nameOf(ns, curId)}（掷 ${roll} 命中）！摸 ${hand.length - before} 张`);
    const traps = trapLog(ev);
    if (traps.length) lg = [...lg, ...traps].slice(-20);
    return {
      ...ns, v: ns.v + 1, drawPile: pile, discard: disc,
      hands: { ...ns.hands, [curId]: hand },
      lightning: undefined, log: lg,
    };
  }
  // 未命中：闪电顺位移到下家头上（按当前方向）
  const nextId = ns.players[advance(ns, 1)].id;
  return {
    ...ns, v: ns.v + 1,
    lightning: { ...ns.lightning, onPlayer: nextId },
    log: log(ns, `⚡ 闪电在 ${nameOf(ns, curId)} 头上没炸（掷 ${roll}），移到 ${nameOf(ns, nextId)} 头上`),
  };
}

const COLOR_NAME: Record<UnoColor, string> = { r: "红", y: "黄", g: "绿", b: "蓝" };
const VALUE_NAME: Record<string, string> = {
  skip: "跳过", rev: "反转", d2: "+2", wild: "变色", wd4: "+4", lightning: "闪电", kbomb: "王炸", wrev: "反转", swap: "替换", challenge: "质疑",
};

/** 人类可读牌名（含变色牌选定的颜色） */
export function cardLabel(card: UnoCard, chosen?: UnoColor): string {
  if (card.color === "w") {
    const v = VALUE_NAME[card.value] || card.value;
    return chosen ? `${v}(${COLOR_NAME[chosen]})` : v;
  }
  const c = COLOR_NAME[card.color];
  const v = VALUE_NAME[card.value] || card.value;
  return `${c}${v}`;
}
