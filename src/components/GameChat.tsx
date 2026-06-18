// 游戏内聊天（弹幕版）：底部常驻输入条，新消息以弹幕从右往左飘过游戏区，飘完自动消失。
// 由 ChatRoom 在有游戏开着时渲染，浮在游戏面板之上；弹幕层 pointer-events:none 不挡游戏点击。
import { useEffect, useRef, useState } from "react";
import { type ChatMessage, EMOJIS, readableText } from "../chat";
import "./GameChat.css";

interface Fly {
  key: string;
  text: string;
  lane: number;
  mine: boolean;
  color: string; // 发送者广播的气泡颜色（各端按发送者的颜色染；空=默认，自己的弹幕回退金色）
}

const LANES = 5;

export default function GameChat({
  messages,
  myId,
  onSend,
}: {
  messages: ChatMessage[];
  myId: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [flying, setFlying] = useState<Fly[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const fired = useRef<Set<string> | null>(null); // 已飘过的消息 id；null=未初始化
  const lane = useRef(0);
  const seq = useRef(0);

  // 新消息 → 生成弹幕（首次挂载只记录历史、不回放）
  useEffect(() => {
    if (fired.current === null) {
      fired.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = messages.filter((m) => !fired.current!.has(m.id));
    if (!fresh.length) return;
    const add: Fly[] = fresh.map((m) => {
      fired.current!.add(m.id);
      const kind = m.kind === "image" ? "🖼️图片" : m.kind === "video" ? "🎬视频" : m.body || "";
      return {
        key: `${m.id}-${seq.current++}`,
        text: `${m.sender}：${kind}`,
        lane: lane.current++ % LANES,
        mine: m.clientId === myId,
        color: m.bubble || "", // 发送者广播的颜色，各端一致
      };
    });
    setFlying((f) => [...f, ...add]);
  }, [messages, myId]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    setShowEmoji(false);
  };

  return (
    <>
      <div className="dm-layer">
        {flying.map((d) => (
          <div
            key={d.key}
            className={"dm-item" + (d.mine ? " mine" : "")}
            style={
              d.color
                ? { top: 6 + d.lane * 26, background: d.color, color: readableText(d.color) }
                : { top: 6 + d.lane * 26 }
            }
            onAnimationEnd={() => setFlying((f) => f.filter((x) => x.key !== d.key))}
          >
            {d.text}
          </div>
        ))}
      </div>
      {showEmoji && (
        <div className="gchat-emoji">
          {EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => setText((t) => t + e)}>{e}</button>
          ))}
        </div>
      )}
      <div className="gchat-bar">
        <button
          className={"gchat-emoji-btn" + (showEmoji ? " on" : "")}
          title="表情"
          onClick={() => setShowEmoji((v) => !v)}
        >
          😊
        </button>
        <input
          value={text}
          placeholder="发条弹幕…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={!text.trim()}>发</button>
      </div>
    </>
  );
}
