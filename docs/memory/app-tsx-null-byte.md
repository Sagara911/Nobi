---
name: app-tsx-null-byte
description: 【已解决 v0.3.6】src/App.tsx 曾嵌裸 NUL(0x00)→git/Grep 当二进制；已换成 \0 转义,文件恢复纯文本
metadata: 
  node_type: memory
  type: project
  originSessionId: cc873711-fed4-4187-a82e-8175b7ba82ae
---

`src/App.tsx` 第 194 行有一个**真正的 NUL 字节（0x00）直接嵌在源码**里，当作 key 分隔符：

```js
= (pid: string, room: string) => `${pid}<NUL>${room}`;   // <NUL> 是裸 0x00，不是转义
```

是聊天([[chat-system]])拼 `pid + room` 复合 key 用的分隔符（防两段拼接撞键），写法上本该用转义 `\0` 却嵌了裸字节。

**它带来的麻烦（不是 bug，运行正常，但很脆）**：
- git 把**整个 App.tsx 当二进制** → diff 显示 `Bin xxxx -> yyyy bytes`，看不到改了哪行，review/合并难搞。
- ripgrep / Grep 工具**跳过它**，搜 App.tsx 必须加 `-a` 才出结果（多次踩到）。
- 编辑器/格式化工具可能吞掉或报错，哪天 NUL 被悄悄抹掉，chat 的 key 就会撞。

**安全修法（零行为变化）**：把裸 NUL 换成 `\0` 转义——`=> \`${pid}\0${room}\``。JS 运行期生成的字符串字节完全一致，不用迁移、不影响已有数据，只是让源码回归纯文本，git diff / 搜索恢复正常。

**状态**：2026-06-18 发现，**2026-06-22 已修复（v0.3.6）**——查任务栏闪烁 bug 时因为这个 NUL 让 Grep 一直搜不到 App.tsx 的通知器代码、绕了一圈,顺手按字节把裸 0x00 换成了 `\0`（`Buffer.from([0x5c,0x30])` 精确替换,模板串里运行期仍是同一个 NUL,零行为改变）。App.tsx 现已是纯文本,git diff / Grep 正常,**不再需要 `-a`**。
