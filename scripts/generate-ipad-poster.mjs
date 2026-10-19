import { chromium } from "playwright";
import fs from "fs";
import path from "path";

async function generate() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 2048, height: 2732 },
    deviceScaleFactor: 1,
  });

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap');
  
  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  body {
    width: 2048px;
    height: 2732px;
    background: radial-gradient(circle at 50% 15%, #1d382e 0%, #0d1a15 55%, #070e0b 100%);
    color: #f7f4ee;
    font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 140px;
  }

  /* Subtle background ambient mesh */
  .glow-1 {
    position: absolute;
    top: 5%;
    left: 20%;
    width: 1200px;
    height: 1200px;
    background: radial-gradient(circle, rgba(62, 134, 105, 0.18) 0%, rgba(0,0,0,0) 70%);
    filter: blur(100px);
    pointer-events: none;
  }
  .glow-2 {
    position: absolute;
    bottom: 5%;
    right: 15%;
    width: 1000px;
    height: 1000px;
    background: radial-gradient(circle, rgba(212, 175, 55, 0.08) 0%, rgba(0,0,0,0) 70%);
    filter: blur(120px);
    pointer-events: none;
  }

  .header {
    text-align: center;
    max-width: 1700px;
    z-index: 10;
  }

  .eyebrow {
    font-family: 'Cinzel', serif;
    font-size: 28px;
    letter-spacing: 0.35em;
    text-transform: uppercase;
    color: #e5c07b;
    margin-bottom: 30px;
    font-weight: 700;
  }

  .headline {
    font-family: 'Newsreader', Georgia, serif;
    font-size: 96px;
    line-height: 1.08;
    font-weight: 600;
    color: #ffffff;
    letter-spacing: -0.02em;
    margin-bottom: 32px;
    text-shadow: 0 4px 30px rgba(0,0,0,0.6);
  }

  .subhead {
    font-size: 38px;
    line-height: 1.45;
    color: #b5c7be;
    font-weight: 400;
    max-width: 1400px;
    margin: 0 auto 80px;
  }

  /* iPad Chassis */
  .ipad-frame {
    width: 1680px;
    height: 1980px;
    background: #111413;
    border-radius: 64px;
    padding: 32px;
    box-shadow: 
      0 0 0 4px #2c332e,
      0 0 0 8px #1a1e1b,
      0 40px 120px rgba(0, 0, 0, 0.9),
      0 10px 40px rgba(0, 0, 0, 0.8);
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
  }

  .camera-notch {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    width: 14px;
    height: 14px;
    background: #050605;
    border-radius: 50%;
    box-shadow: inset 0 0 3px rgba(255,255,255,0.2);
  }

  .screen {
    width: 100%;
    height: 100%;
    background: #0f1d17;
    border-radius: 40px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  /* iPad Navigation & Header Bar */
  .app-header {
    height: 110px;
    background: rgba(15, 29, 23, 0.95);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 48px;
  }

  .app-title-group {
    display: flex;
    align-items: center;
    gap: 18px;
  }

  .app-logo {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: #23483b;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    color: #e5c07b;
    border: 1px solid rgba(229, 192, 123, 0.3);
  }

  .app-brand {
    font-family: 'Cinzel', serif;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #f7f4ee;
  }

  .nav-tabs {
    display: flex;
    gap: 16px;
    background: rgba(255,255,255,0.06);
    padding: 6px;
    border-radius: 18px;
  }

  .tab-item {
    padding: 12px 28px;
    border-radius: 14px;
    font-size: 22px;
    font-weight: 500;
    color: #9cb5a8;
  }

  .tab-item.active {
    background: #23483b;
    color: #ffffff;
    font-weight: 600;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  }

  /* Split layout inside iPad */
  .app-content {
    flex: 1;
    display: grid;
    grid-template-columns: 460px 1fr;
    height: calc(100% - 110px);
  }

  /* Left sidebar: library shelves & papers */
  .sidebar {
    background: rgba(12, 22, 18, 0.85);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    padding: 40px 32px;
    display: flex;
    flex-direction: column;
    gap: 36px;
  }

  .shelf-heading {
    font-size: 18px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: #7b998b;
    font-weight: 700;
    margin-bottom: 16px;
  }

  .shelf-pill {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px;
    background: rgba(255,255,255,0.04);
    border-radius: 16px;
    font-size: 24px;
    color: #d1dfd7;
    margin-bottom: 12px;
  }

  .shelf-pill.selected {
    background: #1c382e;
    color: #ffffff;
    font-weight: 600;
    border: 1px solid rgba(229, 192, 123, 0.4);
  }

  .shelf-badge {
    background: rgba(255,255,255,0.1);
    padding: 4px 14px;
    border-radius: 12px;
    font-size: 20px;
    color: #e5c07b;
  }

  /* Right main: Research paper reader & book hero */
  .main-stage {
    padding: 48px;
    display: flex;
    flex-direction: column;
    gap: 36px;
    overflow: hidden;
  }

  .paper-card {
    background: linear-gradient(135deg, rgba(29, 56, 46, 0.9) 0%, rgba(20, 38, 31, 0.9) 100%);
    border: 1px solid rgba(229, 192, 123, 0.25);
    border-radius: 28px;
    padding: 40px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.35);
  }

  .paper-tag {
    display: inline-block;
    padding: 8px 18px;
    background: rgba(229, 192, 123, 0.15);
    border: 1px solid rgba(229, 192, 123, 0.4);
    color: #e5c07b;
    border-radius: 12px;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.05em;
    margin-bottom: 20px;
  }

  .paper-title {
    font-family: 'Newsreader', serif;
    font-size: 42px;
    font-weight: 600;
    color: #ffffff;
    line-height: 1.25;
    margin-bottom: 14px;
  }

  .paper-authors {
    font-size: 22px;
    color: #a4bea4;
    margin-bottom: 24px;
  }

  .paper-stats-row {
    display: flex;
    gap: 32px;
    border-top: 1px solid rgba(255,255,255,0.1);
    padding-top: 24px;
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .stat-val {
    font-size: 26px;
    font-weight: 700;
    color: #e5c07b;
  }

  .stat-lbl {
    font-size: 18px;
    color: #8da498;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Grid of books */
  .books-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 28px;
  }

  .book-item {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 20px;
    padding: 24px;
    display: flex;
    gap: 20px;
  }

  .book-cover {
    width: 90px;
    height: 135px;
    border-radius: 10px;
    box-shadow: 0 8px 18px rgba(0,0,0,0.5);
    background-size: cover;
    background-position: center;
    flex-shrink: 0;
  }

  .book-meta {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
  }

  .book-name {
    font-size: 22px;
    font-weight: 600;
    color: #f7f4ee;
    line-height: 1.25;
  }

  .book-author {
    font-size: 18px;
    color: #8da498;
  }

  .book-progress-bar {
    width: 140px;
    height: 6px;
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 6px;
  }

  .book-progress-fill {
    height: 100%;
    background: #e5c07b;
    border-radius: 3px;
  }
</style>
</head>
<body>
  <div class="glow-1"></div>
  <div class="glow-2"></div>

  <div class="header">
    <div class="eyebrow">Academic Preprints · Personal Library · Reading Focus</div>
    <h1 class="headline">A Sanctuary for Everything You Read.</h1>
    <p class="subhead">Seamlessly catalog literature, discover arXiv research papers, read with bespoke themes, and capture thoughts directly in the margins.</p>
  </div>

  <div class="ipad-frame">
    <div class="camera-notch"></div>
    <div class="screen">
      <div class="app-header">
        <div class="app-title-group">
          <div class="app-logo">W</div>
          <div class="app-brand">Whatchu Reading</div>
        </div>
        <div class="nav-tabs">
          <div class="tab-item active">Library</div>
          <div class="tab-item">arXiv Preprints</div>
          <div class="tab-item">Reading Feed</div>
          <div class="tab-item">Discover</div>
        </div>
      </div>

      <div class="app-content">
        <div class="sidebar">
          <div>
            <div class="shelf-heading">Reading Shelves</div>
            <div class="shelf-pill selected">
              <span>Currently Reading</span>
              <span class="shelf-badge">3</span>
            </div>
            <div class="shelf-pill">
              <span>Research & Papers</span>
              <span class="shelf-badge">8</span>
            </div>
            <div class="shelf-pill">
              <span>Favorites & Classic</span>
              <span class="shelf-badge">14</span>
            </div>
            <div class="shelf-pill">
              <span>Want to Read</span>
              <span class="shelf-badge">26</span>
            </div>
          </div>

          <div>
            <div class="shelf-heading">Active Themes</div>
            <div class="shelf-pill">
              <span>Paper & Manuscript</span>
              <span class="shelf-badge">Active</span>
            </div>
            <div class="shelf-pill">
              <span>Midnight OLED</span>
              <span class="shelf-badge">🌙</span>
            </div>
          </div>
        </div>

        <div class="main-stage">
          <div class="paper-card">
            <span class="paper-tag">arXiv:2307.09288 · Computer Science</span>
            <h2 class="paper-title">Llama 2: Open Foundation and Fine-Tuned Chat Models</h2>
            <div class="paper-authors">Hugo Touvron, Louis Martin, Kevin Stone, Peter Albert, Amjad Almahairi, et al.</div>
            <div class="paper-stats-row">
              <div class="stat-item">
                <span class="stat-val">77 Pages</span>
                <span class="stat-lbl">Full PDF</span>
              </div>
              <div class="stat-item">
                <span class="stat-val">Page 14</span>
                <span class="stat-lbl">Progress (18%)</span>
              </div>
              <div class="stat-item">
                <span class="stat-val">5 Thoughts</span>
                <span class="stat-lbl">Margin Notes</span>
              </div>
              <div class="stat-item">
                <span class="stat-val">Sepia Theme</span>
                <span class="stat-lbl">Reading Mode</span>
              </div>
            </div>
          </div>

          <div class="books-grid">
            <div class="book-item">
              <div class="book-cover" style="background: linear-gradient(135deg, #4a1525, #8a2846);"></div>
              <div class="book-meta">
                <div class="book-name">Dune Messiah</div>
                <div class="book-author">Frank Herbert</div>
                <div class="book-progress-bar"><div class="book-progress-fill" style="width: 72%;"></div></div>
              </div>
            </div>

            <div class="book-item">
              <div class="book-cover" style="background: linear-gradient(135deg, #16382b, #2b6e55);"></div>
              <div class="book-meta">
                <div class="book-name">The Left Hand of Darkness</div>
                <div class="book-author">Ursula K. Le Guin</div>
                <div class="book-progress-bar"><div class="book-progress-fill" style="width: 45%;"></div></div>
              </div>
            </div>

            <div class="book-item">
              <div class="book-cover" style="background: linear-gradient(135deg, #1c2b42, #395785);"></div>
              <div class="book-meta">
                <div class="book-name">Neuromancer</div>
                <div class="book-author">William Gibson</div>
                <div class="book-progress-bar"><div class="book-progress-fill" style="width: 90%;"></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  await page.setContent(html, { waitUntil: "networkidle" });
  // Wait extra 500ms for webfonts
  await page.waitForTimeout(600);

  const outPath = path.resolve("mobile-app/screenshots/ipad-01-main.png");
  await page.screenshot({ path: outPath, type: "png" });
  console.log("Saved iPad screenshot to:", outPath);

  await browser.close();
}

generate().catch(err => {
  console.error(err);
  process.exit(1);
});
