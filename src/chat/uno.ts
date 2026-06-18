// UNO 游戏引擎（纯函数，不依赖 React / 网络 / Tauri，可单测）。
// 设计：房主持权威 UnoState，应用动作后广播快照；其余端只渲染收到的快照。
// 规则：标准 108 张；跳过/反转/+2/变色/+4变色；反转在 2 人局当跳过；+4 随时可出（不校验无同色）；不做未喊 UNO 罚牌。
//       **+2/+4 同类叠牌**：被 +2 罚时可接 +2 把累计罚牌甩给下家(+4 接 +4)；接不住就一次摸完累计的牌、跳过自己。
//       **摸到能出为止**：出不了牌时摸牌动作会一直摸到摸出能压的牌（或牌摸光），摸到的能出牌可打或过。
//       **炸弹**：牌堆里的陷阱，摸到引爆（摇骰子多摸真牌）；不进手不可出。
//       回合倒计时是 UI 侧的（超时只闪烁提醒，不在引擎里做任何自动操作）。

export type UnoColor = "r" | "y" | "g" | "b";
/** 牌面值：0-9 数字，或 skip(跳过) rev(反转) d2(+2) wild(变色) wd4(+4变色) */
export type UnoValue =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "skip" | "rev" | "d2" | "wild" | "wd4"
  | "bomb"; // 炸弹：埋在牌堆里的陷阱，摸到即引爆（摇骰子摸几张），不进手、不可出

export interface UnoCard {
  id: string; // 每张物理牌唯一，用于 React key / 动作引用
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
  winner?: string; // 清空手牌者 id
  log: string[]; // 简短事件日志（末尾最新，最多留 20 条）
}

const COLORS: UnoColor[] = ["r", "y", "g", "b"];

/** 炸弹张数（掺进牌堆的陷阱） */
const BOMB_COUNT = 6;

/** 标准 108 张 + 6 张炸弹（id 唯一） */
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
  if (card.value === "bomb") return false; // 炸弹永不可出（只是摸牌陷阱，正常也不会进手）
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
  if (s.pendingDraw > 0) {
    // 叠牌中：只能接同类（+2 接 +2、+4 接 +4），否则只能摸牌
    for (const card of hand) if (card.value === top.value) out.add(card.id);
    return out;
  }
  for (const card of hand) {
    if (s.justDrew && card.id !== s.drawnCardId) continue;
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
  // 发牌跳过炸弹：起手牌里不放炸弹（炸弹留在牌堆里当陷阱）。从牌堆按序取 7 张非炸弹。
  for (const p of players) {
    const h: UnoCard[] = [];
    while (h.length < 7) {
      const idx = deck.findIndex((c) => c.value !== "bomb");
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
  | { type: "play"; player: string; cardId: string; chooseColor?: UnoColor }
  | { type: "draw"; player: string }
  | { type: "pass"; player: string };

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

/** 抽 count 张真牌进 hand；途中摸到炸弹→摇骰子、炸弹移除、count += 点数（连环可叠）。返回各次骰子点数（记日志用）。 */
function drawReal(pile: UnoCard[], discard: UnoCard[], hand: UnoCard[], count: number): number[] {
  const rolls: number[] = [];
  let need = count;
  let guard = 0;
  while (need > 0 && guard++ < 400) {
    const c = takeOne(pile, discard);
    if (!c) break;
    if (c.value === "bomb") {
      const r = unoRoll();
      rolls.push(r);
      need += r; // 炸弹移除（不进手不进堆）
    } else {
      hand.push(c);
      need--;
    }
  }
  return rolls;
}

/** 摸到能出为止：一张张摸进 hand，摸到炸弹就引爆（摇骰多摸真牌），直到摸出能压的牌或牌摸光。
 *  返回 { playableId?, rolls }。 */
function drawUntilPlayable(
  pile: UnoCard[],
  discard: UnoCard[],
  hand: UnoCard[],
  top: UnoCard,
  curColor: UnoColor,
): { playableId?: string; rolls: number[] } {
  const rolls: number[] = [];
  let guard = 0;
  while (guard++ < 400) {
    const c = takeOne(pile, discard);
    if (!c) break;
    if (c.value === "bomb") {
      const r = unoRoll();
      rolls.push(r);
      rolls.push(...drawReal(pile, discard, hand, r)); // 引爆：多摸 r 张真牌（嵌套炸弹也处理）
      continue;
    }
    hand.push(c);
    if (canPlay(c, top, curColor)) return { playableId: c.id, rolls };
  }
  return { rolls };
}

/** 把炸弹骰子点数拼成日志串 */
function bombLog(rolls: number[]): string {
  if (!rolls.length) return "";
  const sum = rolls.reduce((a, b) => a + b, 0);
  return `💣 摸到炸弹！摇骰子 ${rolls.join("+")}，多摸 ${sum} 张`;
}

/**
 * 应用一个动作，返回新状态（版本 +1）。非法动作原样返回（房主端据此忽略）。
 * 房主收到任意端的动作后调用它，再广播新快照。
 */
export function applyAction(s: UnoState, a: UnoAction): UnoState {
  if (s.status !== "playing") return s;
  if (s.players[s.turn]?.id !== a.player) return s; // 不是该玩家回合
  const n = s.players.length;
  const top = s.discard[s.discard.length - 1];

  if (a.type === "draw") {
    const pile = [...s.drawPile];
    const disc = [...s.discard];
    const hand = [...s.hands[a.player]];
    const before = hand.length;
    // 叠牌中摸牌 = 接不住，一次摸完累计罚牌（含炸弹引爆）、跳过自己
    if (s.pendingDraw > 0) {
      const rolls = drawReal(pile, disc, hand, s.pendingDraw);
      let lg = log(s, `${nameOf(s, a.player)} 接不住，摸 ${hand.length - before} 张`);
      if (rolls.length) lg = [...lg, bombLog(rolls)].slice(-20);
      return {
        ...s, v: s.v + 1, drawPile: pile, discard: disc,
        hands: { ...s.hands, [a.player]: hand },
        pendingDraw: 0, justDrew: false, drawnCardId: undefined,
        turn: advance(s, 1), log: lg,
      };
    }
    if (s.justDrew) return s; // 本回合已摸过
    // 「摸到能出为止」（含炸弹引爆）：摸到能压的牌或牌摸光为止
    const { playableId, rolls } = drawUntilPlayable(pile, disc, hand, top, s.curColor);
    if (hand.length === before && !rolls.length) return s; // 实在没牌可摸
    let lg = log(s, `${nameOf(s, a.player)} 摸了 ${hand.length - before} 张${playableId ? "（摸到能出的）" : ""}`);
    if (rolls.length) lg = [...lg, bombLog(rolls)].slice(-20);
    const ns: UnoState = {
      ...s, v: s.v + 1, drawPile: pile, discard: disc,
      hands: { ...s.hands, [a.player]: hand }, log: lg,
    };
    if (playableId) return { ...ns, justDrew: true, drawnCardId: playableId }; // 摸到能出 → 打或过
    return { ...ns, justDrew: false, drawnCardId: undefined, turn: advance(ns, 1) };
  }

  if (a.type === "pass") {
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
  if (s.pendingDraw > 0) {
    if (card.value !== top.value) return s; // 叠牌中只能接同类（+2/+4）
  } else {
    if (s.justDrew && a.cardId !== s.drawnCardId) return s; // 摸牌后只能出摸到那张
    if (!canPlay(card, top, s.curColor)) return s;
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

  // 功能效果 → 决定下一手
  switch (card.value) {
    case "skip":
      return { ...ns, turn: advance(ns, 2), log: log(ns, `${nameOf(ns, ns.players[advance(ns, 1)].id)} 被跳过`) };
    case "rev": {
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

const COLOR_NAME: Record<UnoColor, string> = { r: "红", y: "黄", g: "绿", b: "蓝" };
const VALUE_NAME: Record<string, string> = {
  skip: "跳过", rev: "反转", d2: "+2", wild: "变色", wd4: "+4",
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
