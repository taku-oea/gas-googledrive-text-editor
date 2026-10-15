# Drive テキストエディタ（Google Apps Script Web アプリ）

Google ドライブ上のテキストファイルを、ローカルエディタに近い体感で編集する
Apps Script Web アプリです。CodeMirror 6 をエディタに使い、編集操作はすべて
クライアント側で完結させています。

## できること

- **スマホ対応**（iPhone / Android。ファイル一覧はドロワー、ヘッダーに元に戻す・保存・新規メモのボタン、
  長押しでメニュー、ドラッグの代わりに「移動…」。PC と同じセッションを使い、PC の分割は崩さない）
- **一時メモ**（タブバーの空白をダブルクリック／`Mod+Alt+N`。保存先はあとで決める。
  置き場所は初回の選択画面と設定から変えられる）
- **ピン留め**（よく使うファイルをサイドバー最上段に置き、深い階層へ行き直さずに 1 クリックで開く）
- **複数のフォルダを同時に開ける**（マイドライブと共有ドライブを混ぜてもよい・最大 8 個）
- フォルダ選択（マイドライブと参加中の共有ドライブを遅延ロードツリーで選択）
- フォルダツリーサイドバー（1 階層ずつ遅延ロード、開閉状態を記憶、ファイル名で絞り込み）
- ドラッグ＆ドロップでファイル／フォルダを移動
- 右クリックメニュー（新規作成・コピー／貼り付け・複製・名前を変更・ゴミ箱へ移動）
- 埋め込みビューア（PDF・画像・音声・動画・Office・Google ドキュメント／スプレッドシート／スライド／図形描画）
- drawio（`.drawio`）のプレビュー（読み取り専用・中身の XML はエディタで編集できる）
- Markdown のライブプレビュー（**別タブで開くので好きなペインに置ける**・
  スクロール連動・Mermaid の図に対応）
- Markdown の入力バー（見出し・太字・表・チェックリストなどをボタンで挿入）
- HTML のライブプレビュー（sandbox iframe に隔離して表示・1 ファイル完結の HTML 向け）
- **CSV / TSV の表プレビュー**（見出しの固定・並べ替え・絞り込み。**表の上でセルを直接編集でき**、
  行や列の追加と削除、Excel からの範囲の貼り付けもできる。数万行でも固まらない）
- 複数タブ（Undo 履歴・カーソル・折りたたみ・スクロール位置をタブごとに保持）
- **エディタの分割**（左右・上下に最大 6 ペイン、入れ子も可。`Mod+\` かタブのドラッグ。
  同じファイルを 2 つのペインには出せない）
- リロードしても開いていたタブ・ペインの分割・サイドバーの位置が復元される
- 行番号、シンタックスハイライト、検索置換（日本語 UI）、複数カーソル、VS Code 風キーマップ
- サイドバーの幅変更（ドラッグ）と表示切り替え（`Mod+B`）
- 配色は VS Code Dark Modern / Light Modern に合わせ、インデントガイドを表示
- ライト / ダーク / システム（OS 追従）の切り替え（ヘッダーのアイコン・設定・コマンドパレット）
- アイコンは SVG スプライトを同梱（Lucide / ISC・実行時の外部依存なし）
- コマンドパレット（`Mod+Shift+P`）とクイックオープン（`Mod+P`。**開いていないサブフォルダの中のファイルも出る**）
- ツリー内でのインライン改名・インライン新規作成、キーボード操作（↑↓→← Enter F2 Delete）
- 複数選択（Cmd/Ctrl・Shift クリック）と一括移動・一括削除
- OS からファイルをドラッグ＆ドロップしてアップロード（1 件 2MB まで）
- アクティビティバー（エクスプローラ / 全体検索 / 変更履歴 / 設定）
- ファイルの中身を全体検索（`Mod+Shift+F`）
- Drive のリビジョンから過去の版を読み込む
- **ターミナル**（`Ctrl+\`` / `Mod+Alt+T`。Drive をパスで辿って `ls` `cd` `mv` `rm`、
  `grep` で横断検索、`sed -i` で複数ファイルの一括置換。`Tab` でファイル名を補完）
- **比較ビュー**（WinMerge 相当。並列／インライン・ブロック単位のコピー・片側だけ保存）。
  比べる材料はファイルに限らず、編集中のタブ・Drive 上の保存済み内容・過去の版・
  貼り付けた文字列・空のどれでも組み合わせられる
- 設定（自動保存の ON/OFF と間隔・**フォント**・フォントサイズ・折り返し）。フォントは端末にインストール済みのもの（HackGen など）を
  名前で使うだけでダウンロードしないので、アプリは重くならない。入っていない端末では既定の等幅フォントになる
- 仮タブ（シングルクリックで開き、次のクリックで入れ替わる）・タブのドラッグ並べ替え
## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/hosting.md](docs/hosting.md) | ライブラリのバンドルの作り方と配信先（GitHub Pages など）の用意 |
| [docs/security.md](docs/security.md) | OAuth スコープと、ブラウザに渡している認証情報の扱い |
| [docs/architecture.md](docs/architecture.md) | ファイル構成・サーバー関数一覧・動作の仕組み |
| [docs/icons.md](docs/icons.md) | favicon・OAuth 同意画面のロゴ・PWA のアイコン |
| [docs/limitations.md](docs/limitations.md) | 既知の制限 |

---

## 必要なもの

- Google Workspace（または個人の Google アカウント）と Google ドライブ
- Node.js 22 以上と npm
- [clasp](https://github.com/google/clasp)（`npm install -g @google/clasp`）
- ライブラリのバンドルを置く、認証なしで取得できる `https` の配信先
  （GitHub Pages が手軽です。[docs/hosting.md](docs/hosting.md)）

## セットアップとデプロイ

### 1. 依存パッケージを入れる

```bash
npm install
```

### 2. ライブラリのバンドルを作って配信先に置く

CodeMirror 6 などのライブラリは esbuild で 1 本にまとめ、別の配信先から SRI 付きで読み込みます。
配信先の URL は環境変数 `VENDOR_BASE_URL` で指定します。

> **自分の配信先を用意してください。** 既定値（`https://assets.oea.jp/...`）はリポジトリ作者の配信先です。
> SRI で中身を検証するので安全面の問題はありませんが、作者が配信をやめたりバンドルを入れ替えたりすると、
> 既定値のままビルドしたアプリは起動しなくなります。

```bash
export VENDOR_BASE_URL=https://assets.example.com/apps/editor/vendor
npm run build -- --apply   # dist/vendor/ を作り、src/importmap.html を書き換える
# dist/vendor/ の中身（manifest.json 以外）を VENDOR_BASE_URL の場所にアップロード
npm run check              # 置いたファイルと import map の SRI が一致するか確かめる
```

配信先の条件と GitHub Pages での手順は [docs/hosting.md](docs/hosting.md) にあります。
**アップロードする前に `clasp push` しないでください。** 新しいファイルが見つからず、全員が起動できなくなります。

### 3. Apps Script プロジェクトを作ってプッシュする

```bash
clasp login                 # 初回のみ（ブラウザが開きます）
```

あらかじめ <https://script.google.com/home/usersettings> で **Google Apps Script API** をオンにしておきます。

新しいプロジェクトを作る場合:

```bash
cp src/appsscript.json /tmp/appsscript.json   # clasp create が上書きするので退避
clasp create --type webapp --title "Drive テキストエディタ" --rootDir src
cp /tmp/appsscript.json src/appsscript.json   # 元に戻す
```

既存のプロジェクトに向ける場合は、`.clasp.json` を作って `scriptId` を書きます。

```json
{
  "scriptId": "<スクリプト ID>",
  "rootDir": "src",
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"]
}
```

> `scriptExtensions` に `.gs` を入れてください。clasp 3.x の初期設定は `.js` のみで、
> このままだと `Code.gs` などがプッシュ対象から漏れます。
> `.clasp.json` はスクリプト ID を含むので `.gitignore` に入れてあります。

`src/js.html` は生成物なので、プッシュの前に必ず作ります。まとめて行うのが `npm run push` です。

```bash
npm run push    # = build:app（js.html を作る）→ check → test → clasp push
```

マニフェストを書き換えるときなど、clasp が確認を求めて止まった場合は `clasp push --force` で送ります。

個別に回すときは次のとおりです（GitHub Actions でも check と test が回ります）。

```bash
npm run build:app  # client/app/*.js を連結して src/js.html を作る
npm run check      # .gs と client/app の構文、js.html の生成し忘れ、import map の SRI（dist/ があれば中身とも）
npm test           # 単体テスト
```

### 4. Web アプリとしてデプロイする

```bash
clasp create-version "説明"
clasp create-deployment --versionNumber <番号> --description "説明"
```

`src/appsscript.json` に次の値を書いてあるので、そのまま次の設定でデプロイされます。

| 項目 | 設定値 |
|---|---|
| 次のユーザーとして実行 | **ウェブアプリにアクセスしているユーザー**（`USER_ACCESSING`） |
| アクセスできるユーザー | **同じドメイン内の全員**（`DOMAIN`） |

**「自分（スクリプト所有者）」で実行してはいけません。** 各ユーザーが自分のドライブを操作する
アプリなので、所有者権限で動かすと全員がデプロイした人のドライブを見てしまいます。
個人の Google アカウントで使う場合は `access` を `MYSELF` または `ANYONE` に変えてください。

2 回目以降は、同じデプロイを新しいバージョンに差し替えると URL が変わりません。

```bash
npm run push
clasp create-version "説明"
clasp update-deployment --versionNumber <番号> <デプロイ ID>
```

**マニフェストの値は既存デプロイには反映されません。** 設定を変えたときは新しいバージョンでデプロイし直してください。

### 5. 初回アクセスとスコープの承認

`executeAs: USER_ACCESSING` なので、**各ユーザーが初回アクセス時に自分で承認します。**
Google の審査を受けていないアプリなので「このアプリは Google で確認されていません」と出ます。
［詳細］→［（プロジェクト名）に移動］から続行してください。
スコープを増やしたバージョンをデプロイすると、既存ユーザーにも承認画面がもう一度出ます。

この警告を出したくない場合は、標準の GCP プロジェクトを紐付けて OAuth 同意画面を「内部」にします
（[docs/icons.md](docs/icons.md) の「OAuth 同意画面のロゴ」）。
要求するスコープとその理由は [docs/security.md](docs/security.md) にあります。

### スクリプトプロパティ（任意）

Apps Script エディタ →［プロジェクトの設定］→［スクリプト プロパティ］で設定します。実行時に読むので再デプロイは不要です。

| プロパティ | 用途 |
|---|---|
| `FAVICON_URL` | ブラウザのタブに出すアイコンの https URL（[docs/icons.md](docs/icons.md)） |
| `ESM_FALLBACK_ENABLED` | `true` で、配信先に届かないときに esm.sh へ逃がす（[docs/hosting.md](docs/hosting.md)） |
| `DIRECT_DRIVE_ENABLED` | `false` で、ブラウザから Drive API を直接呼ぶ経路を止める（[docs/security.md](docs/security.md)） |

---

## キーボードショートカット

ヘッダー右の ⌨ ボタンで一覧を表示できます。`Mod` は Mac では ⌘、それ以外では Ctrl です。

| 操作 | キー | 出どころ |
|---|---|---|
| 保存（即時／一時メモなら保存先を決める） | `Mod+S` | 自前 |
| 新しい一時メモ | `Mod+Alt+N` | 自前（`Mod+N` はブラウザが予約済みで奪えない） |
| クイックオープン（ファイルを開く） | `Mod+P` | 自前 |
| 閉じたタブを開き直す | `Alt+Shift+T` | 自前（`Mod+Shift+T` はブラウザが予約済みで奪えない） |
| コマンドパレット | `Mod+Shift+P` | 自前 |
| エクスプローラの絞り込みへ | `Mod+Shift+E` | 自前 |
| サイドバーの表示切り替え | `Mod+B` | 自前 |
| ペインを右／下に分割 | `Mod+\` / `Mod+Shift+\` | 自前 |
| そのペインへ移る | `Alt+1` 〜 `Alt+6` | 自前（`Mod+1`〜`9` はブラウザのタブ切り替え） |
| 全体検索（ファイルの中身） | `Mod+Shift+F` | 自前 |
| ターミナルを開く／エディタへ戻る | `Ctrl+\`` / `Mod+Alt+T` | 自前（JIS 配列で `\`` が IME に取られるため 2 つある） |
| ファイル名・コマンド名の補完（ターミナル） | `Tab` / `Shift+Tab` | 自前 |
| 入力の履歴（ターミナル） | `↑ / ↓` | 自前 |
| 実行中のコマンドを中断（ターミナル） | `Ctrl+C` | 自前（文字を選んでいるときはコピーに譲る） |
| 画面を消す／行を消す（ターミナル） | `Ctrl+L` / `Ctrl+U` | 自前 |
| プレビューを隣のペインに開く／閉じる | `Mod+Shift+V` | 自前 |
| 表プレビューでセル内の改行 | `Alt+Enter` | 自前（Excel と同じ） |
| 次／前の差分へ（比較ビューの中） | `F7 / Shift+F7` | 自前（`goToNextChunk`） |
| 比較ビューで編集した側を書き戻す | `Mod+S` | 自前 |
| 上／下の行にカーソルを追加 | `Mod+Alt+↑ / ↓` | 自前（CM6 に標準コマンドが無いため実装） |
| 行の折り返しを切り替え | `Alt+Z` | 自前 |
| インデントの増減 | `Tab / Shift+Tab` | `indentWithTab` |
| 検索・置換パネル | `Mod+F` | `searchKeymap` |
| 次／前の一致へ | `Mod+G / Shift+Mod+G`、`F3 / Shift+F3` | `searchKeymap` |
| 次の同じ語も選択 | `Mod+D` | `searchKeymap` |
| 同じ語をすべて選択 | `Mod+Shift+L` | `searchKeymap` |
| 行番号へジャンプ | `Mod+Alt+G` | `searchKeymap` |
| 行を上／下へ移動 | `Alt+↑ / ↓` | `defaultKeymap` |
| 行を上／下へ複製 | `Shift+Alt+↑ / ↓` | `defaultKeymap` |
| 行を削除 | `Mod+Shift+K` | `defaultKeymap` |
| 下に空行を挿入 | `Mod+Enter` | `defaultKeymap` |
| コメントの切り替え | `Mod+/` | `defaultKeymap` |
| 元に戻す／やり直し | `Mod+Z / Shift+Mod+Z` | `historyKeymap` |

`Tab` をインデントに割り当てているため、キーボードだけでエディタから抜けるには
`Escape` を押してから `Tab` を使ってください（CM6 が推奨する挙動です）。

---

## 扱えるファイル

拡張子のホワイトリスト（`src/DriveService.gs` の `TEXT_EXTENSIONS`）と MIME で判定します。
Drive は `.md` や `.ts` に `application/octet-stream` を付けることがあるため、
MIME より拡張子を優先しています。

`.txt .md .js .mjs .ts .tsx .json .html .css .scss .csv .tsv .py .rb .sh .bash
.yml .yaml .toml .ini .sql .xml .svg .log .java .kt .go .rs .php .c .h .cpp .cs
.swift .tf .vue .svelte Dockerfile Makefile .gitignore` など。追加したい拡張子は
`TEXT_EXTENSIONS` に 1 行足してください。

シンタックスハイライトは JavaScript / TypeScript / JSX / TSX / JSON / HTML / CSS /
Markdown / Python / YAML / SQL / XML / Shell に対応します。
それ以外の拡張子はプレーンテキストとして開きます。

### 編集はできないが開けるもの

いずれもビューアで閲覧できます（サイズ上限の対象外）。

| 種類 | 扱い |
|---|---|
| PDF | Drive のプレビューを埋め込み |
| 画像・音声・動画（`.png .jpg .gif .webp .heic .mp4 .mov .mp3` など） | 同上 |
| Office（`.docx .xlsx .pptx` など） | 同上 |
| Google ドキュメント／スプレッドシート／スライド／図形描画 | Docs のプレビューを埋め込み |

### 一覧に出るが開けないもの（グレー表示＋ツールチップで理由）

| 種類 | 理由 |
|---|---|
| Google フォーム／サイト／マイマップ／Apps Script など | プレビュー URL が無いため |
| ホワイトリスト外のバイナリ | テキストとしてもプレビューとしても扱えないため |
| 5MB 超のテキストファイル | サイズ上限を超えるため |
| ショートカット | 参照先を解決しないため |

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 全員が同じドライブの中身を見ている | デプロイ設定の「実行するユーザー」が所有者になっています。「ウェブアプリにアクセスしているユーザー」で再デプロイしてください |
| `Code.gs` の変更が反映されない | `.clasp.json` の `scriptExtensions` に `.gs` があるか確認。また、Web アプリは**新しいバージョンでデプロイし直す**まで旧コードのままです |
| 「エディタの読み込みに失敗しました」 | 配信先（`VENDOR_BASE_URL`）に届いていないか、置いたファイルが import map の SRI と合っていません。`npm run check` を通したうえで `dist/vendor/` をアップロードし直してください。配信先の障害なら一時的に `ESM_FALLBACK_ENABLED=true` で esm.sh に逃がせます |
| 「このフォルダにアクセスできません」 | 共有が外れているか削除されています。「フォルダを変更」から選び直してください |
| 保存が毎回競合する | 他の人が同じファイルを編集中か、Drive 同期クライアントが触っています |
| ファイルが一覧に出ない | 拡張子が `TEXT_EXTENSIONS` に無い可能性があります。`src/DriveService.gs` に追記してください |
| 共有ドライブが選択画面に出ない | Drive の拡張サービスが有効になっていない可能性があります。`appsscript.json` の `enabledAdvancedServices` を確認し、`clasp push` 後に新しいバージョンでデプロイしてください |
| 共有ドライブの最上位で新規作成できない | Drive 側の設定で制限されている場合があります。1 つ下のフォルダを対象にしてください |
| 開いていたフォルダが消えた | 権限が外れたか削除された可能性があります。起動時に理由をトーストで出し、残りのフォルダで続行します |
| ツリーの余白にドロップできない | ルートが複数あると対象が曖昧になるため無効にしています。フォルダ行に落としてください |
| タブのアイコンが変わらない | Chrome は favicon を強くキャッシュします。ハードリロード（`Cmd/Ctrl+Shift+R`）か新しいタブで開いてください |
| タブのアイコンが既定のまま | スクリプトプロパティ `FAVICON_URL` が未設定か値が壊れています。`?diag=favicon` を付けてアクセスすると実際の値が見られます。[docs/icons.md](docs/icons.md) を参照 |
| 承認画面にロゴを出したい | GCP プロジェクトの紐付けが必要です。[docs/icons.md](docs/icons.md) を参照 |
| 新規作成できない拡張子がある | 同じく `TEXT_EXTENSIONS` に無い拡張子です。追記すれば作成・改名の両方で通ります |
| 検索パネルに英語が残る | `client/app/190-codemirror.js` の `PHRASES` にキーが無い文字列です。該当パッケージを `grep 'phrase('` して追記してください |
| `Mod+P` がブラウザの印刷を開く | このアプリの iframe にフォーカスが無い状態です。エディタか一覧を一度クリックしてください |

---

## ライセンス

[MIT](LICENSE)

同梱しているアイコン（`src/icons.html`）は [Lucide](https://lucide.dev/) のパスを使っています（ISC License）。
ビルドでまとめるライブラリ（CodeMirror・marked・DOMPurify・mermaid・fuzzysort など）は、それぞれのライセンスに従います。
