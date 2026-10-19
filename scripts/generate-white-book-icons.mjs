import { chromium } from "playwright";
import fs from "fs";
import path from "path";

async function generateIcons() {
  const browser = await chromium.launch();
  
  // 1. Generate 1024x1024 App Icon (White Book on Deep Velvet Forest Green)
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });

  const iconHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1024px;
    height: 1024px;
    background: radial-gradient(circle at 50% 35%, #1e3d31 0%, #162a23 60%, #0d1a15 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  
  /* Subtle ambient lighting */
  .glow {
    position: absolute;
    width: 700px;
    height: 700px;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.08) 0%, rgba(0,0,0,0) 70%);
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .book-container {
    position: relative;
    width: 620px;
    height: 620px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* SVG illustration of crisp white open book with golden star/bookmark */
  svg {
    width: 100%;
    height: 100%;
    filter: drop-shadow(0 28px 45px rgba(0, 0, 0, 0.55));
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="book-container">
    <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Outer book pages glow/shadow -->
      <path d="M72 176 C 160 136, 230 184, 256 196 C 282 184, 352 136, 440 176 L 440 384 C 352 344, 282 392, 256 404 C 230 392, 160 344, 72 384 Z" fill="#e8ebe8"/>
      
      <!-- Main Crisp White Book Pages -->
      <path d="M80 186 C 164 148, 232 192, 256 204 C 280 192, 348 148, 432 186 L 432 376 C 348 338, 280 382, 256 394 C 232 382, 164 338, 80 376 Z" fill="#ffffff"/>
      
      <!-- Subtle Page Curvature Shade & Spine Depth -->
      <path d="M256 204 L 256 394" stroke="#162a23" stroke-width="10" stroke-linecap="round" opacity="0.85"/>
      <path d="M246 208 C 220 196, 160 160, 92 196 L 92 208 C 160 172, 220 208, 246 220 Z" fill="#f0f4f1" opacity="0.6"/>
      <path d="M266 208 C 292 196, 352 160, 420 196 L 420 208 C 352 172, 292 208, 266 220 Z" fill="#f0f4f1" opacity="0.6"/>

      <!-- Embossed editorial reading lines on left page -->
      <path d="M120 236 C 160 216, 205 232, 226 242" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>
      <path d="M120 268 C 160 248, 205 264, 226 274" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>
      <path d="M120 300 C 160 280, 205 296, 226 306" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>

      <!-- Embossed editorial reading lines on right page -->
      <path d="M286 242 C 307 232, 352 216, 392 236" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>
      <path d="M286 274 C 307 264, 352 248, 392 268" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>
      <path d="M286 306 C 307 296, 352 280, 392 300" stroke="#d5dfd9" stroke-width="6" stroke-linecap="round"/>

      <!-- Golden Four-Point Sparkle / Discovery Star Above Book -->
      <path d="M330 64 L 337 98 L 371 105 L 337 112 L 330 146 L 323 112 L 289 105 L 323 98 Z" fill="#e5c07b"/>
      <circle cx="330" cy="105" r="4" fill="#fff7d6"/>

      <!-- Small companion star -->
      <path d="M395 130 L 399 148 L 417 152 L 399 156 L 395 174 L 391 156 L 373 152 L 391 148 Z" fill="#e5c07b" opacity="0.8"/>
    </svg>
  </div>
</body>
</html>
  `;

  await page.setContent(iconHtml, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // Preview file first
  const previewPath = path.resolve("mobile-app/assets/icon-white-preview.png");
  await page.screenshot({ path: previewPath, type: "png" });
  console.log("Generated white book icon preview:", previewPath);

  await browser.close();
}

generateIcons().catch(err => {
  console.error(err);
  process.exit(1);
});
