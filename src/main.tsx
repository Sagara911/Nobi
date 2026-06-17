import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RefWindow from "./components/RefWindow";
import RefToolsWindow from "./components/RefToolsWindow";
import SelectionTranslateWindow from "./components/SelectionTranslateWindow";
import ChatWindow from "./components/ChatWindow";

// #ref 路由 → 渲染独立的悬浮参考浮窗（透明置顶小窗），否则正常渲染主程序
// （看球直开窗 web-d* 加载的是外部网址，不走本路由）
// 注意：#reftools 也以 "#ref" 开头，必须先判它。
const isRefTools = location.hash.startsWith("#reftools");
const isRef = location.hash.startsWith("#ref");
const isSelectionTranslate = location.hash.startsWith("#selection-translate");
const isChat = location.hash.startsWith("#chat");
if (isRef) {
  document.documentElement.classList.add("ref-window");
  document.body.classList.add("ref-window");
}
if (isSelectionTranslate) {
  document.documentElement.classList.add("selection-translate-window");
  document.body.classList.add("selection-translate-window");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSelectionTranslate ? (
      <SelectionTranslateWindow />
    ) : isChat ? (
      <ChatWindow />
    ) : isRefTools ? (
      <RefToolsWindow />
    ) : isRef ? (
      <RefWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
