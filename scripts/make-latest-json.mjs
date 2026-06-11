#!/usr/bin/env node
// 生成自动更新用的 latest.json（发版三步之二）：
//   1. 签名构建（bash 里执行；密钥带密码，两个变量都要，密码用单引号包）：
//        export TAURI_SIGNING_PRIVATE_KEY="$(cat /c/Users/huobingli/.tauri/nobi-updater.key)"
//        export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<你的密钥密码>'
//        npm run tauri build
//   2. node scripts/make-latest-json.mjs "更新说明（可选）"
//   3. 在 GitHub 新建 Release（tag 形如 v0.2.0），上传两个文件：
//        - src-tauri/target/release/bundle/nsis/nobi_<版本>_x64-setup.exe
//        - src-tauri/target/release/bundle/nsis/latest.json（本脚本产物）
//      老版本应用启动时即会提示更新。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
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
      `请先用签名密钥构建（bash）：\n` +
      `  export TAURI_SIGNING_PRIVATE_KEY="$(cat /c/Users/huobingli/.tauri/nobi-updater.key)"\n` +
      `  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<你的密钥密码>"\n` +
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

// 把发布所需的两个文件拷到项目根目录 release\（免得在 target 深处找）
const relDir = join(root, "release");
mkdirSync(relDir, { recursive: true });
copyFileSync(setup, join(relDir, `nobi_${version}_x64-setup.exe`));
copyFileSync(out, join(relDir, "latest.json"));
console.log(`发布文件已就绪：${relDir}`);
console.log(`  - nobi_${version}_x64-setup.exe`);
console.log(`  - latest.json`);
console.log(`上传到 GitHub Release（tag v${version}）这两个文件即可。`);
