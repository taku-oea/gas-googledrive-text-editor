# アプリのアイコン

全体の説明は [README](../README.md) を参照してください。

「アイコン」と呼ばれるものが 3 種類あり、変更の手間がまったく違います。

| 対象 | どこに出るか | 変更 |
|---|---|---|
| **favicon** | ブラウザのタブ、ブックマーク、Chrome の［アプリとしてインストール］、ホーム画面に追加 | **コードで対応済み**（スクリプトプロパティで URL を指定） |
| **OAuth 同意画面のロゴ** | 初回アクセス時の権限確認画面 | GCP プロジェクトの紐付けが必要（手間がかかる方） |
| Apps Script プロジェクトのアイコン | Drive 上でのファイルアイコン、script.google.com の一覧 | **変更できない**（Google が固定） |

## favicon

### わかっている制約（配信 HTML を実際に取得して確認したもの）

| # | 事実 |
|---|---|
| 1 | **データ URI は使えない。** `setFaviconUrl` は例外も投げずに黙って無視し、`<link rel="shortcut icon">` がまったく出力されない |
| 2 | `https://` の URL なら出力される。ただし `type` は `image/x-icon` 固定 |
| 3 | **Drive に置いたファイルは使えない。** ドメイン限定共有だと `lh3.googleusercontent.com/d/…` も `uc?export=view` も `uc?export=download` も、画像ではなくログイン画面の HTML を返す |

3 は「ブラウザが favicon を取りに行く時点では認証が効かない」ためです。
つまり **認証なしで取得できる `https` の URL** が必要になります。

### 設定方法

Apps Script エディタ →［プロジェクトの設定］→［スクリプト プロパティ］で

| プロパティ | 値 |
|---|---|
| `FAVICON_URL` | 画像の https URL（例: `https://assets.oea.jp/apps/editor/favicon.ico`） |

を設定します。未設定ならアイコンは既定のままです（実害はありません）。

スクリプトプロパティは実行時に読むので、**値を変えるだけなら再デプロイは不要**です
（`Code.gs` を触ったときは `clasp push` ＋新バージョンのデプロイが必要）。
反映されたかは、ウェブアプリの URL に `?diag=favicon` を付けてアクセスすると確認できます。

### アイコン画像

`assets/favicon.ico`（16 / 32 / 48 / 64 / 128 / 256px を 1 ファイルに同梱、約 94KB）です。
元画像は `assets/app-icon.png`（1254×1254）で、`tools/make-icons.py` が

- 角丸四角形のまわりの黒い余白を切り落とし、外側を透過にする
  （余白を残すと 16px でアイコンが小さく潰れる）
- 各サイズを LANCZOS で縮小し、PNG のまま ICO に詰める
- あわせて PWA 用の PNG とマニフェストも出力する（[PWA](#アプリとしてインストールしたときのアイコンpwa)）

という処理で生成します。図柄を変えるときは **`assets/app-icon.png` を差し替えて
再実行するだけ**です。

```bash
python3 tools/make-icons.py
```

**256px を必ず含めている**のは、Chrome の［アプリとしてインストール］が
favicon の中の一番大きいサイズをアプリアイコンに使うためです。
16px で判別できることも引き続き制約になります（細い線や文字を入れない）。

### 置き場所の候補

| 置き場所 | 可否 | 備考 |
|---|---|---|
| GitHub Pages（独自ドメイン） | ◎ | 推奨。無料で HTTPS。ライブラリのバンドルと同じ場所に置ける（下記） |
| 自分のウェブサーバ | ◎ | https で認証なしに取得できれば何でもよい |
| S3（＋CloudFront） | ○ | すでに AWS を使っているなら（[下記](#別の置き場所s3--cloudfront)） |
| Google Drive | ✕ | 制約 3 のとおり |
| データ URI | ✕ | 制約 1 のとおり |

favicon の**画像そのものにリスクはありません**（約 94KB の図形だけで、情報を含みません）。
注意すべきなのは、置き場所に**公開してはいけないものを一緒に置いてしまう**事故のほうです。

## GitHub Pages に置く（推奨）

ライブラリのバンドル（`vendor`）を配信しているのと同じリポジトリに置きます。
リポジトリ・独自ドメイン・DNS の設定は [docs/hosting.md](hosting.md) にまとめてあり、
favicon のために追加でやることはファイルを 1 つ置くだけです。

実例の構成は次のとおりです。

| 項目 | 値 |
|---|---|
| リポジトリ | `taku-oea/assets`（GitHub Pages を有効化） |
| 独自ドメイン | `https://assets.oea.jp` |
| DNS（Cloudflare） | CNAME `assets` → `taku-oea.github.io`。**DNS only（グレーの雲）** |
| Pages の設定 | **Enforce HTTPS** を ON |
| favicon の置き場所 | リポジトリの `apps/editor/favicon.ico` |
| `FAVICON_URL` | `https://assets.oea.jp/apps/editor/favicon.ico` |

```bash
# assets リポジトリの作業コピーで
mkdir -p apps/editor
cp <このリポジトリ>/assets/favicon.ico apps/editor/favicon.ico
git add apps/editor/favicon.ico
git commit -m "Add editor favicon"
git push
```

数分で公開されます。画像が返ることを確認します（HTML やエラーページでないこと）。
GitHub Pages は `.ico` を `image/vnd.microsoft.icon` で返します。GAS が宣言する `image/x-icon` とは違いますが、ブラウザはどちらでも表示します。

```bash
curl -s -o /tmp/fav.ico -w "%{http_code} %{content_type} %{size_download}\n" \
  "https://assets.oea.jp/apps/editor/favicon.ico"
file /tmp/fav.ico
# 200 image/vnd.microsoft.icon 95810
# /tmp/fav.ico: MS Windows icon resource - 6 icons, 16x16 with PNG image data ...
```

### アイコンを変えるとき

ブラウザは favicon を強くキャッシュします。上書きしただけでは既存ユーザーのタブに
古いアイコンが残るので、次のどちらかで URL を変えます。

- `FAVICON_URL` の末尾に `?v=2`（次は `?v=3`…）を付ける
- パスにバージョンを入れる（`apps/editor/v2/favicon.ico`）

どちらもブラウザから見れば別の URL なので、古いキャッシュは使われません。
GitHub Pages 側のキャッシュは 10 分（`max-age=600`）なので、上書きは 10 分ほどで行き渡ります。
CloudFront のように長期キャッシュする CDN を挟む構成では事情が違うので、次の節の注意を見てください。

### 公開すること自体のリスク評価

| 懸念 | 評価 |
|---|---|
| アイコン画像から情報が漏れる | **なし**。図形のみで、テキストもメタデータも含みません |
| URL がアプリの HTML に載る | 問題ありません。URL はもともと秘密ではありません |
| 誤って他のファイルを公開してしまう | **これが唯一の実質的リスク。** 公開専用のリポジトリ（またはバケット）に、公開してよいものだけを置くことで防ぎます |
| 書き換え・改ざん | リポジトリ（またはバケット）の書き込み権限を絞っていれば起きません |

## 別の置き場所（S3 + CloudFront）

すでに AWS を使っている場合の選択肢です。手順の細部は AWS のドキュメントに譲り、
ここでは踏みやすい落とし穴だけを挙げます。`<your-bucket>`、`<your-domain>`、
`ACCOUNT_ID`、`DIST_ID` は自分の環境の値に読み替えてください。

### 構成の要点

- **静的公開アセット専用のバケットを新しく作る。** 既存のバケットに相乗りさせると、
  あとから置いた別のファイルが公開範囲に巻き込まれます
- バケットは**完全に非公開のまま**（ブロックパブリックアクセス 4 項目すべて ON、ACL 無効）にして、
  CloudFront の **OAC（Origin Access Control）** 経由でだけ読ませる
- Origin domain は**候補リストから REST エンドポイント**（`<your-bucket>.s3.<region>.amazonaws.com`）を選ぶ。
  ウェブサイトエンドポイント（`*.s3-website-*.amazonaws.com`）は HTTP のみで、OAC も効きません
- Viewer protocol policy は **Redirect HTTP to HTTPS**
- 作成ウィザードが勧める **WAF は無効にしてよい**（有料で、静的な画像の配信には不要）
- **バージョニングを有効にする**（誤って上書き・削除しても戻せる）

バケットポリシーは CloudFront のコンソールが生成するものをそのまま貼ります。
**`Principal` が `*` ではなく CloudFront のサービスプリンシパルである**ことを確認してください。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<your-bucket>/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DIST_ID"
        }
      }
    }
  ]
}
```

アップロード時は `Content-Type` と `Cache-Control` を明示します（Content-Type は省略しても
ブラウザは表示しますが、GAS が宣言する `image/x-icon` に揃えておくと切り分けが楽です）。

```bash
aws s3 cp assets/favicon.ico "s3://<your-bucket>/apps/editor/favicon.ico" \
  --content-type image/x-icon \
  --cache-control "public, max-age=31536000, immutable"
```

### 独自ドメインを使う場合

CNAME を登録するだけでは動きません。次の 3 つが揃って初めて機能します。

1. **CloudFront に代替ドメイン名（`<your-domain>`）を登録する。**
   無いと、知らないホスト名のリクエストを拒否します（`The request could not be satisfied`）
2. **ACM の証明書を us-east-1（バージニア北部）で発行する。**
   CloudFront は us-east-1 の証明書しか受け付けません。バケットがどのリージョンでも同じです
3. **DNS に CNAME を 2 本入れる。** ACM の DNS 検証用と、`<your-domain>` → ディストリビューションのドメイン名（`dxxxx.cloudfront.net`）の本番用

DNS が Cloudflare なら、**両方とも「DNS only」（グレーの雲）**にしてください。
プロキシ ON だと ACM の DNS 検証が通らないことがあり、本番用は Cloudflare → CloudFront の
二重 CDN になって障害の切り分けが面倒になります。また Cloudflare の Name 欄は
ゾーン名を自動補完するので、末尾にゾーン名を付けると二重になります。

### 検証

```bash
curl -sI "https://<your-domain>/apps/editor/favicon.ico"     # 200 / image/x-icon
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<your-bucket>.s3.<region>.amazonaws.com/apps/editor/favicon.ico"   # 403 であること
```

**最後の 403 は必ず確認してください。** 200 ならバケットが直接公開されており、
CloudFront を挟んだ意味がありません。

### アイコンを変えるとき（CloudFront の場合）

`immutable` を付けた固定名を上書きするなら、**次の 2 つが両方必要**です。

1. CloudFront のキャッシュを無効化する
   （`aws cloudfront create-invalidation --distribution-id DIST_ID --paths "/apps/editor/*"`）
2. `FAVICON_URL` の末尾に `?v=2` を付けてブラウザ側のキャッシュを切る

マネージドキャッシュポリシー `CachingOptimized` は**クエリ文字列をキャッシュキーに含めない**ため、
`?v=` を変えても CloudFront は同じキャッシュを返します（2 だけでは効かない）。
逆にブラウザは `immutable` を信じて再取得しないため、無効化だけでも既存ユーザーには効きません。
パスにバージョンを入れる方式（`apps/editor/v2/favicon.ico`）なら、どちらも不要です。

> S3 を CloudFront なしで直接公開する方法もありますが、ブロックパブリックアクセスを
> 一部 OFF にする必要があり、設定ミスがそのまま公開事故になります。
> やる場合も `s3:GetObject` だけを `public/*` のような専用プレフィックスに限って許可し、
> `s3:ListBucket` は公開しないでください。

## OAuth 同意画面のロゴ（手間がかかる方）

初回アクセス時に出る権限確認の画面にアプリ名とロゴを出すには、
**Apps Script プロジェクトに標準の GCP プロジェクトを紐付ける**必要があります。
既定では Apps Script が管理する非表示のプロジェクトが使われており、
そちらの同意画面は編集できません。

1. [Google Cloud Console](https://console.cloud.google.com/) で新しいプロジェクトを作成
   （Workspace の組織の下に作ること）
2. ［API とサービス］→［OAuth 同意画面］を開き、**User Type は「内部」**を選ぶ
   - 内部なら**アプリの審査は不要**で、ロゴもすぐ反映されます
   - 「外部」にすると審査が必要になり、ロゴの承認に数日〜数週間かかります
3. アプリ名・サポートメール・**アプリのロゴ**（120×120 の PNG、1MB 以下）を設定
4. プロジェクト番号（プロジェクト ID ではなく**番号**）をコピー
5. Apps Script エディタ →［プロジェクトの設定］→［Google Cloud Platform プロジェクト］
   →［プロジェクトを変更］に番号を貼り付け

**注意点:**

- 紐付けると、**既存ユーザーは次回アクセス時に再承認**を求められます
- GCP プロジェクトを削除するとスクリプトが動かなくなります
- 「内部」で作ると、その Workspace の組織外のユーザーは使えなくなります
  （ドメイン内限定でデプロイしているなら問題ありません。デプロイ設定は [README](../README.md) 参照）

ロゴを出す必要が無ければ、紐付けない方が管理対象が増えず楽です。
承認画面は 1 ユーザーにつき初回だけなので、実用上の影響は小さいです。

## アプリとしてインストールしたときのアイコン（PWA）

Chrome の［アプリとしてインストール］やスマホの［ホーム画面に追加］で使われるのは
**favicon**です。`assets/app-icon.png` から作った ICO には 256px を含めてあるので、
タブでもインストール後のアイコンでも同じ絵が出ます。

| 操作 | アイコン | 名前 |
|---|---|---|
| Chrome（PC）［アプリとしてインストール］ | favicon の 256px | `APP_TITLE`（タブのタイトル） |
| Chrome（Android）［ホーム画面に追加］ | favicon の最大サイズ | 同上 |
| Safari（iOS）［ホーム画面に追加］ | favicon（無ければページのスクリーンショット） | 同上 |

`Code.gs` の `META_TAGS` で `mobile-web-app-capable` と
`apple-mobile-web-app-capable` を `yes` にしてあります。ホーム画面のアイコンから
開いたときにブラウザの UI を出さず、アプリのウィンドウとして表示させるためのものです。

### GAS では本物の PWA にはできない

`HtmlService` が上位ページ（`script.google.com`）の `<head>` に差し込めるのは
**favicon と 4 種類のメタタグだけ**です（`addMetaTag` の許可リスト。`Code.gs` の
`META_TAGS` のコメント参照）。`<link rel="manifest">` を入れる API はありません。
アプリの HTML は下位のサンドボックス iframe（`*.googleusercontent.com`）に入るため、
そこに `manifest` や `apple-touch-icon` を書いてもブラウザは見てくれません。

したがって次はできません。

| できないこと | 理由 |
|---|---|
| マニフェストの指定（`name` / `display` / `theme_color` / アイコン一覧） | `<link rel="manifest">` を出力できない |
| Service Worker の登録 | スコープが iframe のオリジンになり、上位ページを制御できない |
| オフライン動作 | 上記のとおり（[docs/limitations.md](limitations.md) の「オフライン非対応」も参照） |
| インストール可能バナー（beforeinstallprompt） | マニフェストが無いと出ない |

### どうしても本物の PWA にしたい場合

**自分のドメインに薄いラッパーページを置く**しかありません。マニフェストと
Service Worker はそのページ（＝自分のオリジン）のものとして登録し、中身は GAS の
ウェブアプリを iframe で読み込みます。

そのための素材は生成済みです（`tools/make-icons.py` の出力）。

```
assets/manifest.webmanifest    start_url / scope をラッパーページの URL に書き換える
assets/icon-192.png            purpose: any
assets/icon-512.png            purpose: any
assets/icon-maskable-512.png   purpose: maskable（内側 80% に図形を収めてある）
assets/apple-touch-icon.png    iOS 用 180px（透過なし）
```

必要な作業:

1. 上記 5 ファイルとラッパー HTML を favicon と同じ場所
   （例: `https://assets.oea.jp/apps/editor/`）に置く
2. ラッパー HTML に `<link rel="manifest">` と `<link rel="apple-touch-icon">` を書く
3. `doGet` に `.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` を足す
   （既定の `DEFAULT` では他ドメインからの iframe 埋め込みが拒否される）

**ただし未検証で、おすすめもしません。** GAS のウェブアプリは
`executeAs: USER_ACCESSING` でユーザー自身の認証を要求しますが、他ドメインの
iframe（サードパーティ Cookie 扱い）ではログインが通らず、ログイン画面が
表示されないまま空白になる可能性が高いためです。

現状の「favicon ＋［アプリとしてインストール］」で、見た目の目的
（専用ウィンドウ・独自アイコン）はほぼ満たせます。
