// 生成 Nobi 应用图标：黄色吊牌 + 黑色星光（透明底 1024×1024）
// 完全沿 ↗↙ 对角轴镜像对称：正置圆角方形（角即在对角线上）、
// 打孔圆心在对角轴上且完整嵌在右上角内、星光中心也在对角轴上。
// 用法: node scripts/make-icon.cjs → app-icon.png（再 `npm run tauri icon app-icon.png` 生成全套）
const sharp = require("sharp");

const svg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="hole">
      <rect width="1024" height="1024" fill="white"/>
      <!-- 孔心 = 右上圆角的圆心 (682,342)，在对角轴 (512+t,512-t) 上 -->
      <circle cx="682" cy="342" r="54" fill="black"/>
    </mask>
  </defs>
  <!-- 吊牌：正置圆角方形 -->
  <g mask="url(#hole)">
    <rect x="232" y="232" width="560" height="560" rx="112" fill="#F6C445"/>
  </g>
  <!-- 星光：四角凹边星，中心 (492,532) 在对角轴上，与孔呼应平衡 -->
  <path fill="#1F1F1F" d="
    M 492 392
    C 506 482 542 518 632 532
    C 542 546 506 582 492 672
    C 478 582 442 546 352 532
    C 442 518 478 482 492 392
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
