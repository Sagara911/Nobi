// 文档编辑器（Word 式富文本）。Dock 面板，自研不内嵌——基于 TipTap(ProseMirror)。
// 多文档存 SQLite（docs 表，内容为 HTML）；改动防抖自动保存。
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextStyle from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import * as api from "../api";
import "./DocEditor.css";

const COLORS = ["#1a1a1a", "#e03131", "#e8590c", "#f1ac4b", "#2f9e44", "#1971c2", "#9c36b5"];

export default function DocEditor() {
  const [docs, setDocs] = useState<api.DocMeta[]>([]);
  const [docId, setDocId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(true);
  const loading = useRef(false); // 程序化载入内容时别触发自动保存
  const saveTimer = useRef(0);
  const nameRef = useRef("");
  const idRef = useRef<number | null>(null);
  nameRef.current = name;
  idRef.current = docId;

  const editor = useEditor({
    extensions: [StarterKit, Underline, TextStyle, Color],
    content: "<p></p>",
    onUpdate: () => {
      if (loading.current) return;
      setSaved(false);
      scheduleSave();
    },
  });

  const doSave = useCallback(async () => {
    const id = idRef.current;
    if (id == null || !editor) return;
    try {
      await api.saveDoc(id, nameRef.current || "未命名文档", editor.getHTML());
      setSaved(true);
    } catch {
      /* ignore */
    }
  }, [editor]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), 700);
  }, [doSave]);

  const openDoc = useCallback(
    async (meta: api.DocMeta) => {
      if (!editor) return;
      loading.current = true;
      const html = await api.loadDoc(meta.id).catch(() => null);
      editor.commands.setContent(html || "<p></p>");
      setDocId(meta.id);
      setName(meta.name);
      setSaved(true);
      loading.current = false;
    },
    [editor],
  );

  const refresh = useCallback(async () => {
    const list = await api.listDocs().catch(() => [] as api.DocMeta[]);
    setDocs(list);
    return list;
  }, []);

  // 首次：拉列表，打开最近一篇
  useEffect(() => {
    if (!editor) return;
    void (async () => {
      const list = await refresh();
      if (list[0]) await openDoc(list[0]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const newDoc = async () => {
    await doSave(); // 存掉当前
    const id = await api.createDoc("未命名文档").catch(() => null);
    if (id == null) return;
    const list = await refresh();
    const meta = list.find((d) => d.id === id) || { id, name: "未命名文档", updated_at: 0 };
    await openDoc(meta);
    editor?.commands.focus();
  };

  const delDoc = async () => {
    if (docId == null) return;
    if (!window.confirm(`删除文档「${name || "未命名文档"}」？不可恢复。`)) return;
    await api.deleteDoc(docId).catch(() => {});
    const list = await refresh();
    if (list[0]) await openDoc(list[0]);
    else {
      // 删光了：列表命令会自动重建默认文档，再拉一次
      const l2 = await refresh();
      if (l2[0]) await openDoc(l2[0]);
    }
  };

  const onName = (v: string) => {
    setName(v);
    setSaved(false);
    scheduleSave();
  };

  // 切文档下拉
  const onPick = (id: number) => {
    const meta = docs.find((d) => d.id === id);
    if (meta) void openDoc(meta);
  };

  // 卸载前存一把
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      void doSave();
    };
  }, [doSave]);

  if (!editor) return <div className="doc-root" />;

  const can = editor.can();
  const btn = (active: boolean, on: () => void, label: string, title: string, disabled = false) => (
    <button
      className={"doc-tb-btn" + (active ? " on" : "")}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // 别让按钮抢走编辑器选区
      onClick={on}
    >
      {label}
    </button>
  );

  return (
    <div className="doc-root">
      {/* 顶栏：文档切换 + 标题 + 保存态 */}
      <div className="doc-head">
        <select className="doc-pick" value={docId ?? ""} onChange={(e) => onPick(Number(e.target.value))}>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>{d.name || "未命名文档"}</option>
          ))}
        </select>
        <input
          className="doc-title"
          value={name}
          placeholder="文档标题"
          onChange={(e) => onName(e.target.value)}
        />
        <span className="doc-saved">{saved ? "已保存" : "保存中…"}</span>
        <button className="doc-act" title="新建文档" onClick={() => void newDoc()}>＋ 新建</button>
        <button className="doc-act danger" title="删除当前文档" onClick={() => void delDoc()}>删除</button>
      </div>

      {/* 工具栏 */}
      <div className="doc-toolbar">
        {btn(false, () => editor.chain().focus().undo().run(), "↶", "撤销", !can.undo())}
        {btn(false, () => editor.chain().focus().redo().run(), "↷", "重做", !can.redo())}
        <span className="doc-tb-sep" />
        <select
          className="doc-tb-sel"
          title="段落 / 标题"
          value={
            editor.isActive("heading", { level: 1 }) ? "h1"
            : editor.isActive("heading", { level: 2 }) ? "h2"
            : editor.isActive("heading", { level: 3 }) ? "h3"
            : "p"
          }
          onChange={(e) => {
            const v = e.target.value;
            const c = editor.chain().focus();
            if (v === "p") c.setParagraph().run();
            else c.toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
          }}
        >
          <option value="p">正文</option>
          <option value="h1">标题 1</option>
          <option value="h2">标题 2</option>
          <option value="h3">标题 3</option>
        </select>
        <span className="doc-tb-sep" />
        {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "B", "加粗 (Ctrl+B)")}
        {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "I", "斜体 (Ctrl+I)")}
        {btn(editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "U", "下划线 (Ctrl+U)")}
        {btn(editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), "S", "删除线")}
        <span className="doc-colors">
          {COLORS.map((c) => {
            const cur = (editor.getAttributes("textStyle").color || COLORS[0]).toLowerCase();
            const on = cur === c.toLowerCase();
            return (
              <button
                key={c}
                className={"doc-color" + (on ? " on" : "")}
                style={{ background: c }}
                title={on ? "当前字色" : "字色"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.chain().focus().setColor(c).run()}
              />
            );
          })}
        </span>
        <span className="doc-tb-sep" />
        {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "•≡", "无序列表")}
        {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "1.≡", "有序列表")}
        {btn(editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), "❝", "引用")}
        {btn(editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run(), "</>", "代码块")}
      </div>

      <div className="doc-scroll">
        <EditorContent editor={editor} className="doc-page" />
      </div>
    </div>
  );
}
