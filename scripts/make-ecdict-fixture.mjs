// 造一个与 ECDICT (skywind3000/ECDICT) 同结构的占位词库，供开发/验证用。
// 真库 ecdict-sqlite-28.zip 解压出的 stardict.db 表结构一致，可直接替换本文件。
// 用法: node --experimental-sqlite scripts/make-ecdict-fixture.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "resources", "ecdict.db");
mkdirSync(dirname(out), { recursive: true });
try { rmSync(out); } catch {}

const db = new DatabaseSync(out);
db.exec(`
CREATE TABLE stardict (
  id INTEGER PRIMARY KEY,
  word VARCHAR(64) NOT NULL UNIQUE COLLATE NOCASE,
  sw VARCHAR(64) NOT NULL DEFAULT '',
  phonetic VARCHAR(64) NOT NULL DEFAULT '',
  definition TEXT,
  translation TEXT,
  pos VARCHAR(16) NOT NULL DEFAULT '',
  collins INTEGER NOT NULL DEFAULT 0,
  oxford INTEGER NOT NULL DEFAULT 0,
  tag VARCHAR(64) NOT NULL DEFAULT '',
  bnc INTEGER NOT NULL DEFAULT 0,
  frq INTEGER NOT NULL DEFAULT 0,
  exchange TEXT,
  detail TEXT,
  audio TEXT
);
CREATE UNIQUE INDEX i_word ON stardict (word);
`);

// 占位词条：phonetic 不含外层斜杠（与 ECDICT 一致），translation 多行、行首带词性
const rows = [
  ["apple", "ˈæpl", "n. 苹果；苹果树；苹果公司", "n:100"],
  ["python", "ˈpaɪθən", "n. 蟒蛇；巨蟒\nn. [计] Python（计算机程序设计语言）", "n:100"],
  ["rain", "reɪn", "n. 雨；雨水；下雨\nvi. 下雨\nvt. 大量地给", "n:55/vi:35/vt:10"],
  ["cat", "kæt", "n. 猫；猫科动物", "n:100"],
  ["mat", "mæt", "n. 垫子；席子；衬边", "n:100"],
  ["sit", "sɪt", "vi. 坐；位于；栖息\nvt. 使就座", "vi:80/vt:20"],
  ["watch", "wɒtʃ", "n. 手表；监视；守护\nvt. 观看；注视；看守\nvi. 观看；守候", "vt:50/n:30/vi:20"],
  ["hello", "həˈləʊ", "int. 喂；你好；哈罗", "int:100"],
  ["world", "wɜːld", "n. 世界；领域；世俗", "n:100"],
  ["banana", "bəˈnɑːnə", "n. 香蕉；喜剧演员", "n:100"],
  ["render", "ˈrendə", "vt. 致使；提供；渲染\nn. 粉刷", "vt:90/n:10"],
  ["texture", "ˈtekstʃə", "n. 质地；纹理；结构\nvt. 使具有某种结构", "n:90/vt:10"],
];
const stmt = db.prepare(
  "INSERT INTO stardict (word, sw, phonetic, translation, pos) VALUES (?, ?, ?, ?, ?)",
);
for (const [word, phonetic, translation, pos] of rows) {
  stmt.run(word, word.toLowerCase(), phonetic, translation, pos);
}
db.close();
console.log(`wrote ${rows.length} entries -> ${out}`);
