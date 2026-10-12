# ライブラリのバンドルと配信先

[README](../README.md) の「セットアップとデプロイ」の詳細です。

## 仕組み

CodeMirror 6 一式・marked・DOMPurify・fuzzysort・mermaid は esbuild で 1 本にまとめ、
Apps Script とは別の静的ファイルの配信先から読み込みます。
ファイル名に content-hash が入るので長期キャッシュ（`immutable`）で置け、
2 回目以降の起動ではネットワークに出ません。
比較ビューの `@codemirror/merge` と mermaid（数 MB）は同じバンドルに入っていますが、`import()` で
切り出した別チャンクなので、比較を開くまで／` ```mermaid ` のブロックが現れるまで取得されません
（起動時に取るのはエントリと起動用チャンクの約 400KB だけです）。

**すべてのファイルに SRI（SHA-384）を付けています。** `--apply` が import map の `"integrity"` と
`modulepreload` の `integrity` 属性に書き込み、配信先の中身が build の出力と 1 バイトでも違えば
ブラウザは実行しません。ブラウザは Drive フルスコープのトークンを持つので（[security.md](security.md)）、
配信先が差し替えられたときに被害を出さないためのものです。
配信先そのものを信頼する必要はなく、公開リポジトリに置いても問題ありません。

## 配信先の条件

| 条件 | 理由 |
|---|---|
| 認証なしで `https` から取得できる | ブラウザが直接取りに行くため |
| `Access-Control-Allow-Origin: *` が付く | モジュールスクリプトは cross-origin だと CORS 必須。GAS のサンドボックス iframe のオリジンは毎回変わりうるので `*` にする |
| `.js` が `text/javascript` で返る | モジュールスクリプトは MIME を厳密に検査する |
| 長期キャッシュ（`Cache-Control: immutable`）が効く | 任意。効かなくても動くが、起動のたびに再検証の通信が出る |

GitHub Pages・Cloudflare Pages / R2・S3 + CloudFront のどれでも条件を満たせます。

## ビルドとアップロード

```bash
npm install                       # 初回のみ（esbuild と CodeMirror 群。版は package.json で固定）
export VENDOR_BASE_URL=https://assets.example.com/apps/editor/vendor
npm run build -- --apply          # dist/vendor/ を作り、src/importmap.html の vendor:begin〜end を書き換える
# dist/vendor/ を VENDOR_BASE_URL の場所へアップロード（manifest.json は不要）
npm run check                     # import map の SRI と dist/vendor/ の中身が一致するか
npm run push                      # clasp push
```

- `VENDOR_BASE_URL` を付けずに実行すると、`tools/build.mjs` の既定値（リポジトリ作者の配信先）が使われます
- **順番を守る**: `build -- --apply` → アップロード → `npm run check` → `clasp push`。
  アップロードの前に `clasp push` すると、新しい hash のファイルが見つからず全員が起動できなくなります
- 古い hash のファイルは消さなくてよい（immutable なので参照されなくなるだけ）
- 版を上げるときは `package.json` と `tools/build.mjs` の `ESM_SH`（フォールバック用 URL）の両方を直し、
  `npm run check:esm` でフォールバック側の URL が生きているか確かめる（普段は使われない経路なので腐りやすい）

## 例: GitHub Pages ＋ 独自ドメイン

リポジトリ作者は `https://assets.oea.jp`（リポジトリ `taku-oea/assets`）でこの構成を使っています。
GitHub Pages は CORS `*` と JS の Content-Type を最初から付けます。
キャッシュは 10 分固定で `immutable` にはできませんが、実用上は問題ありません。

```bash
# 1. 配信用のリポジトリを作る（無料プランの Pages は公開リポジトリが必要）
mkdir assets && cd assets
mkdir -p apps/editor/vendor
rsync -a --exclude manifest.json ../gas-googledrive-text-editor/dist/vendor/ apps/editor/vendor/
echo assets.example.com > CNAME
touch .nojekyll               # Jekyll に処理させない（_ で始まるファイルも配信させる）
git init -b main && git add -A && git commit -m "Add vendor bundle"
gh repo create <owner>/assets --public --source . --push

# 2. Pages を有効にして独自ドメインを設定
gh api -X POST repos/<owner>/assets/pages -f 'source[branch]=main' -f 'source[path]=/'
gh api -X PUT  repos/<owner>/assets/pages -f cname=assets.example.com
```

3. DNS に CNAME を追加します。

   | 種類 | 名前 | 値 |
   |---|---|---|
   | CNAME | `assets` | `<owner>.github.io` |

   Cloudflare で管理している場合は **プロキシをオフ（DNS のみ・グレーの雲）** にします。
   プロキシを通すと GitHub が証明書を発行できません。

4. 証明書の発行（数分〜1 時間ほど）を待ち、HTTPS を強制します。

   ```bash
   gh api repos/<owner>/assets/pages --jq '.https_certificate.state'   # approved になるまで待つ
   gh api -X PUT repos/<owner>/assets/pages -F https_enforced=true
   ```

5. 確かめます。

   ```bash
   curl -sI https://assets.example.com/apps/editor/vendor/vendor.XXXXXXXX.js \
     -H 'Origin: https://n-xxxx-script.googleusercontent.com' \
     | grep -iE '^(HTTP|content-type|access-control-allow-origin)'
   ```

   `200`・`application/javascript`（または `text/javascript`）・`access-control-allow-origin: *` が出れば OK です。

バンドルを作り直したら、`dist/vendor/` の中身を同じ場所にコピーして push するだけです。

## 配信先に届かないとき

既定では**起動を止めて**原因を画面に出します。
esm.sh（import map の残りの項目）へ落とすのは、スクリプトプロパティ `ESM_FALLBACK_ENABLED` を
`true` にしたときだけです（再デプロイ不要・次回起動から有効）。esm.sh はリクエスト時にビルドする
第三者 CDN で SRI を付けられないため、配信先の障害時に一時的に逃がす用途に限り、復旧したら消してください。

ネットワーク上どの配信先にも届かない環境向けには `npm run build:inline` で `src/vendor.html` を作り、
`index.html` で include する同梱版が用意できます（毎回 800KB 余計に流れるので既定では使わない。
同梱版には mermaid が入らないので、図は `ESM_FALLBACK_ENABLED=true` のときだけ描けます）。
