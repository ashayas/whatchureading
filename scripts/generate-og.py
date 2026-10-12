from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630

# Load AI image
ai_img = Image.open('public/og-illustration.jpg').convert('RGBA')

# Shift crop to the right so the open book and star are on the right 60% of the banner
# ai_img is 1376x768.
# Let's crop from x=120 to 1376, y=20 to 740
crop_box = (140, 25, 1376, 735)
cropped = ai_img.crop(crop_box)
resized = cropped.resize((W, H), Image.Resampling.LANCZOS)

# Create a smooth dark gradient overlay on the left
overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ov_draw = ImageDraw.Draw(overlay)

# Left gradient from solid #152820 to transparent across the book
for x in range(W):
    if x < 400:
        alpha = 248
    elif x < 720:
        t = (x - 400) / (720 - 400)
        alpha = int(248 * (1 - t)**1.6)
    else:
        alpha = 0
    ov_draw.line([(x, 0), (x, H)], fill=(18, 36, 29, alpha))

# Top and bottom subtle vignettes
for y in range(70):
    alpha = int(120 * (1 - y/70.0))
    ov_draw.line([(0, y), (W, y)], fill=(14, 28, 23, alpha))

for y in range(H - 60, H):
    alpha = int(140 * ((y - (H - 60)) / 60.0))
    ov_draw.line([(0, y), (W, y)], fill=(14, 28, 23, alpha))

composite = Image.alpha_composite(resized, overlay)
draw = ImageDraw.Draw(composite)

# Draw elegant framing
border_color = (220, 231, 155, 60)
draw.rounded_rectangle((28, 28, W - 28, H - 28), radius=16, outline=border_color, width=1)

# Fonts
font_logo = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", 36)
font_eyebrow = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 13)
font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 54)
font_title_italic = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Italic.ttf", 54)
font_sub = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 19)
font_pill = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 13)
font_badge = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 12)

# Top brand
draw.text((64, 56), "whatchu", font=font_logo, fill=(250, 247, 242, 255))
w1 = draw.textlength("whatchu", font=font_logo)
draw.text((64 + w1 + 8, 56), "reading", font=font_logo, fill=(250, 247, 242, 255))
w2 = draw.textlength("reading", font=font_logo)
draw.text((64 + w1 + 8 + w2, 56), ".", font=font_logo, fill=(220, 231, 155, 255))

# Top pill
badge_text = "OPEN SOURCE  ·  NO ADS  ·  NO AMAZON"
bw = draw.textlength(badge_text, font=font_badge)
draw.rounded_rectangle((W - 64 - bw - 28, 58, W - 64, 58 + 32), radius=16, fill=(24, 46, 38, 230), outline=(220, 231, 155, 90), width=1)
draw.text((W - 64 - bw - 14, 66), badge_text, font=font_badge, fill=(220, 231, 155, 255))

# Eyebrow
draw.text((64, 150), "A LITTLE LESS SCROLLING. A LITTLE MORE READING.", font=font_eyebrow, fill=(220, 231, 155, 230))

# Headline
draw.text((64, 182), "Find your next ", font=font_title, fill=(252, 250, 247, 255))
wf = draw.textlength("Find your next ", font=font_title)
draw.text((64 + wf, 182), "chapter.", font=font_title_italic, fill=(220, 231, 155, 255))

draw.text((64, 248), "Own your reading life.", font=font_title, fill=(252, 250, 247, 255))

# Subtitle
sub_lines = [
    "A calm, reader-first alternative to Goodreads.",
    "Track shelves, read papers, share thoughts with",
    "friends — backed by open data, with zero ads."
]
sy = 332
for line in sub_lines:
    draw.text((64, sy), line, font=font_sub, fill=(205, 218, 210, 255))
    sy += 28

# Sparkle helper
def draw_sparkle(ctx, cx, cy, r_outer, r_inner, color):
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
    ctx.polygon(pts, fill=color)

# Corner stars
for (cx, cy) in [(44, 44), (W - 44, 44), (44, H - 44), (W - 44, H - 44)]:
    draw_sparkle(draw, cx, cy, 6, 2, (220, 231, 155, 140))

# Bottom Pills
pills = [
    "Open Library Catalog",
    "Monthly Edge Sync",
    "Research Papers Radar",
    "100% Free & Open Source"
]
px = 64
py = 464
pill_h = 38
for label in pills:
    pw = draw.textlength(label, font=font_pill) + 48
    draw.rounded_rectangle((px, py, px + pw, py + pill_h), radius=9, fill=(24, 46, 38, 235), outline=(58, 102, 88, 210), width=1)
    draw_sparkle(draw, px + 18, py + 19, 4, 2, (220, 231, 155, 230))
    draw.text((px + 30, py + 11), label, font=font_pill, fill=(244, 247, 245, 255))
    px += pw + 10

# Bottom URL
draw.text((64, 552), "whatchureading.com  ·  MIT Licensed  ·  Powered by Cloudflare Workers, D1 & R2", font=font_badge, fill=(185, 205, 195, 200))

composite.convert("RGB").save("public/og.png", "PNG", optimize=True)
print("Updated public/og.png")
