// 从完整 ECDICT (ecdict.csv) 筛出"常用词"建精简离线词典 db（stardict 表，schema 同完整版，可直接换）。
// 常用判据：有考试标签(中考/高考/四六级/考研/托福…) 或 词频排名靠前(frq/bnc) 或牛津3000/柯林斯星级。
// 用法: node --experimental-sqlite scripts/build-ecdict-mini.mjs <ecdict.csv 路径> [输出db路径]
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = process.argv[2];
const outPath = process.argv[3] || join(root, "src-tauri", "resources", "ecdict.db");
if (!csvPath) {
  console.error("用法: node --experimental-sqlite scripts/build-ecdict-mini.mjs <ecdict.csv> [out.db]");
  process.exit(1);
}

const FRQ_MAX = 30000; // 词频排名阈值（越小越常用）

function parseLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const isCommon = (tag, collins, oxford, bnc, frq) => {
  if (tag && tag.trim()) return true;            // 任何考试标签
  if (oxford === 1) return true;                 // 牛津 3000 核心词
  if (collins >= 2) return true;                 // 柯林斯 2★+
  if (frq > 0 && frq <= FRQ_MAX) return true;    // 当代语料高频
  if (bnc > 0 && bnc <= FRQ_MAX) return true;    // BNC 高频
  return false;
};

const lines = readFileSync(csvPath, "utf8").split("\n");
const header = parseLine(lines[0]);
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

mkdirSync(dirname(outPath), { recursive: true });
try { rmSync(outPath); } catch {}
const db = new DatabaseSync(outPath);
db.exec(`
CREATE TABLE stardict (
  id INTEGER PRIMARY KEY, word VARCHAR(64) NOT NULL UNIQUE COLLATE NOCASE,
  sw VARCHAR(64) NOT NULL DEFAULT '', phonetic VARCHAR(64) NOT NULL DEFAULT '',
  definition TEXT, translation TEXT, pos VARCHAR(16) NOT NULL DEFAULT '',
  collins INTEGER DEFAULT 0, oxford INTEGER DEFAULT 0, tag VARCHAR(64) DEFAULT '',
  bnc INTEGER DEFAULT 0, frq INTEGER DEFAULT 0, exchange TEXT, detail TEXT, audio TEXT
);
CREATE UNIQUE INDEX i_word ON stardict (word);
`);
const ins = db.prepare(
  "INSERT OR IGNORE INTO stardict (word, sw, phonetic, translation, pos, tag, collins, oxford, bnc, frq) VALUES (?,?,?,?,?,?,?,?,?,?)",
);

let kept = 0, scanned = 0;
db.exec("BEGIN");
for (let i = 1; i < lines.length; i++) {
  const ln = lines[i];
  if (!ln) continue;
  scanned++;
  const f = parseLine(ln);
  const word = (f[col.word] || "").trim();
  const translation = (f[col.translation] || "").trim();
  if (!word || !translation) continue;
  const collins = parseInt(f[col.collins] || "0", 10) || 0;
  const oxford = parseInt(f[col.oxford] || "0", 10) || 0;
  const bnc = parseInt(f[col.bnc] || "0", 10) || 0;
  const frq = parseInt(f[col.frq] || "0", 10) || 0;
  const tag = f[col.tag] || "";
  if (!isCommon(tag, collins, oxford, bnc, frq)) continue;
  // 字面 \n → 真换行（前端按真换行拆义项）
  const tr = translation.split("\\n").join("\n");
  ins.run(word, word.toLowerCase(), f[col.phonetic] || "", tr, f[col.pos] || "", tag, collins, oxford, bnc, frq);
  kept++;
}
db.exec("COMMIT");
db.close();
const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`扫描 ${scanned} 条，保留常用词 ${kept} 条 → ${outPath} (${mb} MB)`);
