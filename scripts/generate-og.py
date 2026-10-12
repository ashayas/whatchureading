import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630

# Base dark forest green canvas
base = Image.new("RGBA", (W, H), (22, 42, 35, 255)) # deep editorial green #162a23

# Radial ambient glow behind the logo
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow)
center_x, center_y = 960, 300
for r in range(450, 0, -4):
    alpha = int(38 * (1 - r / 450.0) ** 1.6)
    glow_draw.ellipse(
        (center_x - r, center_y - r, center_x + r, center_y + r),
        fill=(220, 231, 155, alpha) # chartreuse ambient light
    )
base = Image.alpha_composite(base, glow)

# Secondary ambient glow on bottom left
glow2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
glow2_draw = ImageDraw.Draw(glow2)
for r in range(400, 0, -5):
    alpha = int(24 * (1 - r / 400.0) ** 2)
    glow2_draw.ellipse(
        (120 - r, 520 - r, 120 + r, 520 + r),
        fill=(52, 98, 82, alpha)
    )
base = Image.alpha_composite(base, glow2)

draw = ImageDraw.Draw(base)

# Sparkle drawing function
def draw_sparkle(draw_ctx, cx, cy, r_outer, r_inner, color):
    pts = [
        (cx, cy - r_outer),
        (cx + r_inner, cy - r_inner),
        (cx + r_outer, cy),
        (cx + r_inner, cy + r_inner),
        (cx, cy + r_outer),
        (cx - r_inner, cy + r_inner),
        (cx - r_outer, cy),
        (cx - r_inner, cy - r_inner),
    ]
    draw_ctx.polygon(pts, fill=color)

# Outer delicate frame
inset = 34
draw.rounded_rectangle(
    (inset, inset, W - inset, H - inset),
    radius=18,
    outline=(220, 231, 155, 55),
    width=1
)

# Corner 4-point stars
for (cx, cy) in [
    (inset + 18, inset + 18),
    (W - inset - 18, inset + 18),
    (inset + 18, H - inset - 18),
    (W - inset - 18, H - inset - 18)
]:
    draw_sparkle(draw, cx, cy, 7, 2, (220, 231, 155, 140))

# Fonts
font_logo = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", 36)
font_badge = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 13)
font_eyebrow = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 13)
font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 62)
font_title_italic = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Italic.ttf", 62)
font_sub = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 20)
font_pill = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 14)
font_footer = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Italic.ttf", 15)

# 1. Top Bar: Brand & Badges
# Brand text: "whatchu reading."
draw.text((76, 68), "whatchu", font=font_logo, fill=(250, 247, 242, 255))
w_w = draw.textlength("whatchu", font=font_logo)
draw.text((76 + w_w + 8, 68), "reading", font=font_logo, fill=(250, 247, 242, 255))
w_r = draw.textlength("reading", font=font_logo)
draw.text((76 + w_w + 8 + w_r, 68), ".", font=font_logo, fill=(220, 231, 155, 255))

# Top-right pill badge: "OPEN SOURCE · NO ADS · NO AMAZON"
badge_text = "OPEN SOURCE  ·  NO ADS  ·  NO AMAZON"
bw = draw.textlength(badge_text, font=font_badge)
bx = W - 76 - bw - 32
by = 70
draw.rounded_rectangle(
    (bx, by, W - 76, by + 34),
    radius=17,
    fill=(28, 56, 47, 220),
    outline=(220, 231, 155, 80),
    width=1
)
draw.text((bx + 16, by + 9), badge_text, font=font_badge, fill=(220, 231, 155, 255))

# 2. Main Content
# Eyebrow
eyebrow_text = "A LITTLE LESS SCROLLING. A LITTLE MORE READING."
draw.text((76, 172), eyebrow_text, font=font_eyebrow, fill=(220, 231, 155, 220))

# Headline: "Find your next chapter."
draw.text((76, 206), "Find your next ", font=font_title, fill=(252, 250, 247, 255))
w_find = draw.textlength("Find your next ", font=font_title)
draw.text((76 + w_find, 206), "chapter.", font=font_title_italic, fill=(220, 231, 155, 255))

# Line 2 of Headline: "Own your reading life."
draw.text((76, 280), "Own your reading life.", font=font_title, fill=(252, 250, 247, 255))

# Subtitle / description lines
sub_lines = [
    "A calm, reader-first alternative to Goodreads. Track shelves, read research",
    "papers, share thoughts with friends, and discover your next great read",
    "— powered by Open Library data and zero algorithmic noise."
]
sy = 368
for line in sub_lines:
    draw.text((76, sy), line, font=font_sub, fill=(196, 212, 202, 255))
    sy += 29

# 3. Right side: Artwork / Recolored light logo
try:
    raw_logo = Image.open("public/logo.png").convert("RGBA")
    datas = raw_logo.getdata()
    new_data = []
    for r, g, b, a in datas:
        if a < 8:
            new_data.append((0, 0, 0, 0))
        elif r > 150: # The chartreuse sparkle
            new_data.append((220, 231, 155, a)) # #dce79b
        else: # The book pages - soft warm ivory
            new_data.append((248, 244, 236, int(a * 0.95)))
    
    light_logo = Image.new("RGBA", raw_logo.size)
    light_logo.putdata(new_data)
    
    logo_sz = 270
    light_logo = light_logo.resize((logo_sz, logo_sz), Image.Resampling.LANCZOS)
    
    base.paste(light_logo, (850, 180), light_logo)
except Exception as e:
    print("Could not load logo:", e)

# 4. Feature Pills across the bottom
pills = [
    ("Open Library Catalog", 12),
    ("Monthly Edge Sync", 10),
    ("Research Papers Radar", 12),
    ("100% Free & Open Source", 14)
]

px = 76
py = 492
pill_height = 40

for label, sparkle_size in pills:
    pw = draw.textlength(label, font=font_pill) + 52
    draw.rounded_rectangle(
        (px, py, px + pw, py + pill_height),
        radius=10,
        fill=(30, 58, 49, 235),
        outline=(58, 102, 88, 190),
        width=1
    )
    # Draw tiny sparkle star before label
    draw_sparkle(draw, px + 20, py + 20, 5, 2, (220, 231, 155, 240))
    draw.text((px + 34, py + 11), label, font=font_pill, fill=(244, 247, 245, 255))
    px += pw + 12

# 5. Footer subtle signature
draw_sparkle(draw, 84, 572, 5, 2, (220, 231, 155, 180))
draw.text((96, 563), "whatchureading.com", font=font_footer, fill=(220, 231, 155, 200))

footer_right = "MIT Licensed  ·  Powered by Cloudflare Workers, D1 & R2"
fr_w = draw.textlength(footer_right, font=font_footer)
draw.text((W - 76 - fr_w, 563), footer_right, font=font_footer, fill=(162, 188, 175, 190))

base.convert("RGB").save("public/og.png", "PNG", optimize=True)
print("Updated public/og.png generated successfully!")
