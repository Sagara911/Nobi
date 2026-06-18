---
name: app-tsx-null-byte
description: src/App.tsx 第194行嵌了个裸 NUL 字节(0x00)→git 当二进制、Grep 需 -a；待清(用户暂缓改)
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

**状态**：2026-06-18 发现（做金库模式时），已跟用户讲清，**用户明确暂时不改、只记着**。非本会话功能引入，是历史遗留。
