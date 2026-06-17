// UNO 游戏引擎（纯函数，不依赖 React / 网络 / Tauri，可单测）。
// 设计：房主持权威 UnoState，应用动作后广播快照；其余端只渲染收到的快照。
// v1 规则：标准 108 张；跳过/反转/+2/变色/+4变色；摸牌后可打该牌或过；
//          反转在 2 人局当跳过；不做 +2/+4 叠加；不做未喊 UNO 罚牌；+4 不校验“无同色才可出”。

export type UnoColor = "r" | "y" | "g" | "b";
/** 牌面值：0-9 数字，或 skip(跳过) rev(反转) d2(+2) wild(变色) wd4(+4变色) */
export type UnoValue =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "skip" | "rev" | "d2" | "wild" | "wd4";

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
  winner?: string; // 清空手牌者 id
  log: string[]; // 简短事件日志（末尾最新，最多留 20 条）
}

const COLORS: UnoColor[] = ["r", "y", "g", "b"];

/** 标准 108 张牌堆（id 唯一） */
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
  return deck;
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
  for (const p of players) hands[p.id] = deck.splice(0, 7);
  // 起始牌不能是变色牌：把开头的变色牌移到牌堆底，直到翻到带色牌
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
    const firstP = s.players[0].id;
    const drawn = s.drawPile.splice(0, 2);
    return {
      ...s,
      hands: { ...s.hands, [firstP]: [...s.hands[firstP], ...drawn] },
      turn: (s.turn + 1) % n,
      log: log(s, `起始为+2，${nameOf(s, firstP)} 摸 2 张并被跳过`),
    };
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

/** 若牌堆空，把弃牌（除顶牌）洗回牌堆 */
function refillIfEmpty(drawPile: UnoCard[], discard: UnoCard[]): UnoCard[] {
  if (drawPile.length) return drawPile;
  const top = discard[discard.length - 1];
  const rest = discard.slice(0, -1);
  discard.length = 0;
  discard.push(top);
  return shuffle(rest);
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
    if (s.justDrew) return s; // 本回合已摸过
    const discardCopy = [...s.discard]; // refillIfEmpty 会就地把弃牌洗回牌堆
    const drawPile = refillIfEmpty([...s.drawPile], discardCopy);
    if (!drawPile.length) return s; // 实在没牌可摸
    const card = drawPile[0];
    const rest = drawPile.slice(1);
    const hand = [...s.hands[a.player], card];
    const playable = canPlay(card, discardCopy[discardCopy.length - 1], s.curColor);
    const ns: UnoState = {
      ...s,
      v: s.v + 1,
      drawPile: rest,
      discard: discardCopy,
      hands: { ...s.hands, [a.player]: hand },
      justDrew: true,
      drawnCardId: card.id,
      log: log(s, `${nameOf(s, a.player)} 摸了一张牌`),
    };
    if (playable) return ns; // 可出 → 等玩家决定打或过
    return { ...ns, turn: advance(ns, 1), justDrew: false, drawnCardId: undefined };
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
  if (s.justDrew && a.cardId !== s.drawnCardId) return s; // 摸牌后只能出摸到那张
  const hand = s.hands[a.player] || [];
  const idx = hand.findIndex((c) => c.id === a.cardId);
  if (idx < 0) return s;
  const card = hand[idx];
  if (!canPlay(card, top, s.curColor)) return s;
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
    case "d2": {
      const tgtIdx = advance(ns, 1);
      const tgt = ns.players[tgtIdx].id;
      const dp = refillIfEmpty([...ns.drawPile], [...ns.discard]);
      const drawn = dp.slice(0, 2);
      return {
        ...ns,
        drawPile: dp.slice(2),
        hands: { ...ns.hands, [tgt]: [...ns.hands[tgt], ...drawn] },
        turn: advance(ns, 2),
        log: log(ns, `${nameOf(ns, tgt)} 摸 2 张并被跳过`),
      };
    }
    case "wd4": {
      const tgtIdx = advance(ns, 1);
      const tgt = ns.players[tgtIdx].id;
      const dp = refillIfEmpty([...ns.drawPile], [...ns.discard]);
      const drawn = dp.slice(0, 4);
      return {
        ...ns,
        drawPile: dp.slice(4),
        hands: { ...ns.hands, [tgt]: [...ns.hands[tgt], ...drawn] },
        turn: advance(ns, 2),
        log: log(ns, `${nameOf(ns, tgt)} 摸 4 张并被跳过`),
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
