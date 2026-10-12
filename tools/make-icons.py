#!/usr/bin/env python3
"""assets/app-icon.png から favicon と PWA 用アイコン一式を生成する。

    python3 tools/make-icons.py

出力（すべて assets/ 直下）:
    favicon.ico            16/32/48/64/128/256 を 1 ファイルに同梱（PNG 圧縮）
    icon-192.png           PWA の標準サイズ（purpose: any）
    icon-512.png           PWA の大サイズ・スプラッシュ用（purpose: any）
    icon-maskable-512.png  Android のマスク対応（purpose: maskable・余白付き）
    apple-touch-icon.png   iOS のホーム画面用 180px（透過なし）
    manifest.webmanifest   上記を参照するウェブアプリマニフェスト

元画像は角丸四角形のまわりに黒い余白があり、そのままでは 16px でアイコンが
小さくなってしまう。そこで

  1. 図形の外側（黒い余白）を外周からの塗りつぶしで特定して透過にする
     ※ 図形の内側にも真っ黒に近い影があるため、明るさのしきい値だけで
       抜くと穴が空く。外周からつながっている領域だけを外側と見なす。
  2. その境界で切り詰めて正方形に整える

という順で処理している。Pillow が必要（pip install Pillow）。
"""

import io
import json
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'app-icon.png'
OUT = ROOT / 'assets'

ICO_SIZES = (16, 32, 48, 64, 128, 256)
PNG_SIZES = {'icon-192.png': 192, 'icon-512.png': 512}
APPLE_SIZE = 180
MASKABLE_SIZE = 512
MASKABLE_SAFE = 0.8          # マスクで削られない内側の割合。図形をこの中に収める

# 図形の外側と見なす明るさのしきい値（RGB の最大値）。
# 実測では余白が 0〜3、図形の縁が 118 以上と差が大きいので 8 で十分。
OUTSIDE_MAX = 8
ALPHA_LO, ALPHA_HI = 2, 40   # 境界のアンチエイリアスをこの範囲で 0→255 に割り振る

APP_NAME = 'Drive テキストエディタ'
APP_SHORT_NAME = 'Drive エディタ'
APP_DESCRIPTION = 'Google ドライブのテキストファイルをブラウザで編集するエディタ'
THEME_COLOR = '#181818'      # css.html の --bg-1（ヘッダー・サイドバー）と同じ
BG_COLOR = '#1f1f1f'         # css.html の --bg-0（エディタ背景）と同じ


def cut_out_background(im):
    """角丸四角形の外側を透過にした RGBA を返す。"""
    w, h = im.size
    # しきい値以下（=黒に近い）を 0、それ以外を 255 にした二値マスク。
    solid = im.convert('RGB').point(lambda v: 255 if v > OUTSIDE_MAX else 0).convert('L')
    # 外周（0,0）から 0 の領域だけをたどって 128 で塗る = 図形の外側。
    # 内側の影は外周とつながっていないので塗られず、穴が空かない。
    ImageDraw.floodfill(solid, (0, 0), 128, thresh=0)
    outside = solid.point(lambda v: 255 if v == 128 else 0)

    # 境界の 1〜2px はアンチエイリアスされているので、明るさに応じた半透明にする。
    span = ALPHA_HI - ALPHA_LO
    ramp = im.convert('RGB').point(
        lambda v: 0 if v <= ALPHA_LO else (255 if v >= ALPHA_HI else (v - ALPHA_LO) * 255 // span)
    ).convert('L')

    alpha = Image.composite(ramp, Image.new('L', (w, h), 255), outside)
    rgba = im.convert('RGBA')
    rgba.putalpha(alpha)
    return rgba


def to_square(im):
    """不透明部分で切り詰め、中央に置いた正方形にする。"""
    box = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    art = im.crop(box)
    side = max(art.size)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(art, ((side - art.width) // 2, (side - art.height) // 2))
    return out


def scaled(art, size):
    return art.resize((size, size), Image.LANCZOS)


def flattened(art, size, bg=(0, 0, 0)):
    """透過を落として bg の上に重ねた RGB を返す（iOS は透過を黒にするため）。"""
    out = Image.new('RGB', (size, size), bg)
    small = scaled(art, size)
    out.paste(small, (0, 0), small)
    return out


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def write_ico(art, path, sizes):
    """各サイズを PNG で同梱した ICO を書き出す。

    Pillow の ICO 保存は縮小方法をこちらで指定できないため、
    サイズごとに LANCZOS で作った PNG を自分でコンテナに詰める。
    PNG を中身にできるのは Vista 以降の仕様で、主要ブラウザはすべて対応する。
    """
    images = [png_bytes(scaled(art, s)) for s in sizes]
    header = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries, blobs = b'', b''
    for size, data in zip(sizes, images):
        entries += struct.pack('<BBBBHHII',
                               0 if size >= 256 else size,   # 256 は 0 で表す
                               0 if size >= 256 else size,
                               0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(header + entries + blobs)
    return len(header + entries + blobs)


def write_manifest(path):
    manifest = {
        'name': APP_NAME,
        'short_name': APP_SHORT_NAME,
        'description': APP_DESCRIPTION,
        # 同一オリジンから配信したページでしか効かない。
        # 置き場所に合わせて書き換える（docs/icons.md の PWA の節を参照）。
        'start_url': './',
        'scope': './',
        'display': 'standalone',
        'orientation': 'any',
        'lang': 'ja',
        'dir': 'ltr',
        'background_color': BG_COLOR,
        'theme_color': THEME_COLOR,
        'icons': [
            {'src': 'icon-192.png', 'sizes': '192x192',
             'type': 'image/png', 'purpose': 'any'},
            {'src': 'icon-512.png', 'sizes': '512x512',
             'type': 'image/png', 'purpose': 'any'},
            {'src': 'icon-maskable-512.png', 'sizes': '512x512',
             'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
                    encoding='utf-8')


def main():
    if not SRC.exists():
        raise SystemExit(f'{SRC} が見つかりません。')

    src = Image.open(SRC)
    art = to_square(cut_out_background(src))
    print(f'{SRC.name}: {src.width}x{src.height} → 図形部分 {art.width}x{art.height} を切り出し')

    written = []

    size = write_ico(art, OUT / 'favicon.ico', ICO_SIZES)
    written.append(('favicon.ico', f'{"/".join(str(s) for s in ICO_SIZES)}px', size))

    for name, px in PNG_SIZES.items():
        data = png_bytes(scaled(art, px))
        (OUT / name).write_bytes(data)
        written.append((name, f'{px}px 透過', len(data)))

    # maskable は円などに切り抜かれる前提なので、図形を内側 80% に収めた上で
    # まわりを黒で埋める（切り抜かれても図形が欠けないようにする）。
    inner = round(MASKABLE_SIZE * MASKABLE_SAFE)
    canvas = Image.new('RGB', (MASKABLE_SIZE, MASKABLE_SIZE), (0, 0, 0))
    small = scaled(art, inner)
    pos = (MASKABLE_SIZE - inner) // 2
    canvas.paste(small, (pos, pos), small)
    data = png_bytes(canvas)
    (OUT / 'icon-maskable-512.png').write_bytes(data)
    written.append(('icon-maskable-512.png', f'{MASKABLE_SIZE}px 余白付き', len(data)))

    # iOS は透過部分を黒で塗り、角丸も OS 側でかけるので透過なしの図形を渡す。
    data = png_bytes(flattened(art, APPLE_SIZE))
    (OUT / 'apple-touch-icon.png').write_bytes(data)
    written.append(('apple-touch-icon.png', f'{APPLE_SIZE}px 不透過', len(data)))

    write_manifest(OUT / 'manifest.webmanifest')
    written.append(('manifest.webmanifest', 'マニフェスト',
                    (OUT / 'manifest.webmanifest').stat().st_size))

    width = max(len(n) for n, _, _ in written)
    for name, note, size in written:
        print(f'  {name.ljust(width)}  {note:<18} {size:>7,} バイト')


if __name__ == '__main__':
    main()
