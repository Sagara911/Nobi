import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RefWindow from "./components/RefWindow";

// #ref 路由 → 渲染独立的悬浮参考浮窗（透明置顶小窗），否则正常渲染主程序
const isRef = location.hash.startsWith("#ref");
if (isRef) document.body.classList.add("ref-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isRef ? <RefWindow /> : <App />}</React.StrictMode>,
);
