#!/usr/bin/env node
// 生成自动更新用的 latest.json（发版三步之二）：
//   1. $env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\.tauri\nobi-updater.key"
//      npm run tauri build
//   2. node scripts/make-latest-json.mjs "更新说明（可选）"
//   3. 在 GitHub 新建 Release（tag 形如 v0.2.0），上传两个文件：
//        - src-tauri/target/release/bundle/nsis/nobi_<版本>_x64-setup.exe
//        - src-tauri/target/release/bundle/nsis/latest.json（本脚本产物）
//      老版本应用启动时即会提示更新。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const setup = join(nsisDir, `nobi_${version}_x64-setup.exe`);
const sig = `${setup}.sig`;

if (!existsSync(sig)) {
  console.error(
    `找不到签名文件：${sig}\n` +
      `请先用签名密钥构建：\n` +
      `  $env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\\.tauri\\nobi-updater.key"\n` +
      `  npm run tauri build`
  );
  process.exit(1);
}

const latest = {
  version,
  notes: process.argv[2] ?? `Nobi v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sig, "utf8").trim(),
      url: `https://github.com/Sagara911/Nobi/releases/download/v${version}/nobi_${version}_x64-setup.exe`,
    },
  },
};

const out = join(nsisDir, "latest.json");
writeFileSync(out, JSON.stringify(latest, null, 2));
console.log(`已生成 ${out}`);
console.log(`上传到 GitHub Release v${version}：setup.exe + latest.json`);
