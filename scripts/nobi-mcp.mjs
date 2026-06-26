#!/usr/bin/env node
// Nobi MCP 服务器（stdio）：把 MCP 工具调用转发到运行中的 Nobi 应用
// （本地 API：http://127.0.0.1:21420/api/*，见 src-tauri/src/mcp_api.rs）。
//
// 注册方法：
//   Claude Code:  claude mcp add nobi -- node D:\Game\DB\scripts\nobi-mcp.mjs
//   Codex CLI:    ~/.codex/config.toml 加入
//                   [mcp_servers.nobi]
//                   command = "node"
//                   args = ["D:\\Game\\DB\\scripts\\nobi-mcp.mjs"]
//
// 前提：Nobi 应用正在运行（API 挂在应用内置的采集服务器上）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = "http://127.0.0.1:21420";

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    });
  } catch {
    throw new Error("连不上 Nobi —— 请先启动 Nobi 应用（本地 API 跟随应用运行）");
  }
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`非 JSON 响应（HTTP ${res.status}）`);
    throw e;
  }
}

const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "nobi", version: "0.1.0" });

server.tool(
  "nobi_status",
  "Nobi 素材库概况：素材总数、收藏数、画板数。也可用来探测应用是否在运行。",
  {},
  async () => text(await api("/api/status"))
);

server.tool(
  "nobi_list_assets",
  "列出/检索素材。query 同时匹配文件名与标签（子串，不区分大小写）；tag 精确匹配；folder 为父目录完整路径；返回含 id、路径、尺寸、标签等元数据。",
  {
    query: z.string().optional().describe("名称/标签子串"),
    tag: z.string().optional().describe("精确标签"),
    folder: z.string().optional().describe("父目录完整路径"),
    favorite: z.boolean().optional().describe("只看收藏"),
    limit: z.number().int().min(1).max(500).optional().describe("条数，默认 50"),
    offset: z.number().int().min(0).optional(),
  },
  async (a) => {
    const p = new URLSearchParams();
    if (a.query) p.set("query", a.query);
    if (a.tag) p.set("tag", a.tag);
    if (a.folder) p.set("folder", a.folder);
    if (a.favorite !== undefined) p.set("favorite", a.favorite ? "1" : "0");
    if (a.limit) p.set("limit", String(a.limit));
    if (a.offset) p.set("offset", String(a.offset));
    return text(await api(`/api/assets?${p}`));
  }
);

server.tool(
  "nobi_get_asset",
  "按 id 取单条素材的完整元数据（路径/尺寸/标签/主色调/来源等）。",
  { id: z.number().int() },
  async (a) => text(await api(`/api/asset?id=${a.id}`))
);

server.tool(
  "nobi_similar_assets",
  "找视觉相似的素材（CLIP 向量近邻）。需要素材已建立语义索引。返回相似素材 id 列表。",
  { id: z.number().int(), top: z.number().int().min(1).max(50).optional() },
  async (a) => text(await api(`/api/similar?id=${a.id}&top=${a.top ?? 12}`))
);

server.tool(
  "nobi_search",
  "语义搜图：用一句大白话/描述搜库里最贴近的素材（CLIP，AI 理解语义，不止匹配文件名）。返回素材 id 列表。需要 Nobi 主窗开着（向量在前端计算），且素材已建 CLIP 索引。",
  { query: z.string().min(1).describe("自然语言描述，如「夜晚赛博朋克街道」"), top: z.number().int().min(1).max(50).optional() },
  async (a) => text(await api(`/api/search?query=${encodeURIComponent(a.query)}&top=${a.top ?? 20}`))
);

server.tool(
  "nobi_list_tags",
  "列出库里所有标签及各自的素材数（按字母序）。用来了解有哪些标签、做整理前的盘点。",
  {},
  async () => text(await api("/api/tags"))
);

server.tool(
  "nobi_set_tags",
  "覆盖设置某素材的完整标签列表（传入的数组即最终标签，原有的被替换）。",
  { id: z.number().int(), tags: z.array(z.string()) },
  async (a) => text(await api("/api/tags/set", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_rename_tag",
  "全库重命名标签 from→to；若 to 已存在即等于合并（去重）。返回受影响的素材数。",
  { from: z.string().min(1), to: z.string().min(1) },
  async (a) => text(await api("/api/tag/rename", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_delete_tag",
  "全库删除某标签（只去掉标签，不删素材）。返回受影响的素材数。",
  { name: z.string().min(1) },
  async (a) => text(await api("/api/tag/delete", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_list_collections",
  "列出全部合集（手攒的具名素材集合）：id / 名称 / 成员数 / 创建时间。",
  {},
  async () => text(await api("/api/collections"))
);

server.tool(
  "nobi_create_collection",
  "新建合集并放入初始成员，返回新合集 id。",
  { name: z.string().min(1), ids: z.array(z.number().int()).optional() },
  async (a) => text(await api("/api/collection/create", { method: "POST", body: JSON.stringify({ name: a.name, ids: a.ids ?? [] }) }))
);

server.tool(
  "nobi_add_to_collection",
  "把一批素材加入已有合集（去重），返回新增数量。",
  { id: z.number().int(), ids: z.array(z.number().int()).min(1) },
  async (a) => text(await api("/api/collection/add", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_tag_assets",
  "给一批素材追加同一个标签（已有该标签的跳过）。",
  { ids: z.array(z.number().int()).min(1), tag: z.string().min(1) },
  async (a) => text(await api("/api/tags", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_set_favorite",
  "收藏 / 取消收藏某素材。",
  { id: z.number().int(), fav: z.boolean() },
  async (a) => text(await api("/api/favorite", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_remove_assets",
  "把素材从库中移除（只删库记录与缩略图缓存，不动磁盘原文件）。",
  { ids: z.array(z.number().int()).min(1) },
  async (a) => text(await api("/api/remove", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_import_folder",
  "递归导入一个本地文件夹的图片/视频到素材库（原位索引，不复制文件）。",
  { path: z.string().min(1).describe("文件夹绝对路径") },
  async (a) => text(await api("/api/import", { method: "POST", body: JSON.stringify(a) }))
);

server.tool(
  "nobi_list_boards",
  "列出全部参考画板（id / 名称 / 更新时间）。",
  {},
  async () => text(await api("/api/boards"))
);

server.tool(
  "nobi_add_to_board",
  "把一批素材按网格摆上当前打开的画板（应用内即时可见）。需要 Nobi 窗口处于打开状态。",
  { ids: z.array(z.number().int()).min(1) },
  async (a) => text(await api("/api/board/add", { method: "POST", body: JSON.stringify(a) }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
