// 生成 Nobi 应用图标：金黄圆角方块 + 右上角黑色星光（透明底 1024×1024）
// 用法: node scripts/make-icon.cjs → app-icon.png（再 `npm run tauri icon app-icon.png` 生成全套）
const sharp = require("sharp");

const svg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <!-- 便签方块：居中圆角方形 -->
  <rect x="192" y="192" width="640" height="640" rx="140" fill="#F7B500"/>
  <!-- 星光：四角凹边星，位于右上角；同色圆角描边把尖端磨圆 -->
  <path fill="#1F1F1F" stroke="#1F1F1F" stroke-width="22"
        stroke-linejoin="round" stroke-linecap="round" d="
    M 698 251
    C 707 304 728 325 780 333
    C 728 341 707 362 698 415
    C 689 362 668 341 616 333
    C 668 325 689 304 698 251
    Z"/>
</svg>`;

sharp(Buffer.from(svg))
  .resize(1024, 1024)
  .png()
  .toFile("app-icon.png")
  .then(() => console.log("app-icon.png 已生成"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
