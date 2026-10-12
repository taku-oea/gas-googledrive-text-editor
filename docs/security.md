# セキュリティと OAuth スコープ

[README](../README.md) から切り出した、スコープと認証情報の扱いの詳細です。

## OAuth スコープ

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/script.external_request"
]
```

`appsscript.json` の `dependencies.enabledAdvancedServices` で Drive の拡張サービス
（Drive API v3）を有効にしています。一覧取得を 1 リクエストにまとめるためで、
これ自体で OAuth スコープは増えません。

`script.external_request` は **`UrlFetchApp` で Drive API を直接叩くため**のものです
（`src/DriveRest.gs`）。DriveApp も拡張サービスも 1 呼び出し = 1 往復で必ず直列に走りますが、
`UrlFetchApp.fetchAll` なら独立した取得（ルートの検証・一覧・本文）を同時に投げられます。
送信先は `www.googleapis.com` だけで、トークンは実行ユーザー自身のもの（`ScriptApp.getOAuthToken()`）です。
このスコープが承認されていない・ネットワークで遮断されている環境では、同じ実行の中で
DriveApp 経路（`*Legacy_` 関数）に自動で切り替わり、遅くなるだけで動作は変わりません。

### なぜ `drive.file` ではなく `drive`（フルスコープ）が必要か

`https://www.googleapis.com/auth/drive.file` は「このアプリが作成したファイル」と
「ユーザーが Google Picker で明示的に選んだファイル」しか触れません。
本アプリは **既存のフォルダを一覧し、既存ファイルを読み書きする** のが目的なので、
`drive.file` では

- `DriveApp.getFolderById()` でのフォルダ取得
- `folder.getFiles()` での一覧
- `file.getBlob().getDataAsString()` / `file.setContent()` での読み書き

がいずれもできません。したがってフルの `drive` スコープが必須です。

`userinfo.email` はヘッダーにログインユーザーを表示するためだけに使っています。
不要なら `src/appsscript.json` から削り、`Code.gs` の `Session.getActiveUser().getEmail()`
も外してください（`try/catch` してあるので、消さなくても空文字になるだけで動作します）。

> **注意**: `oauthScopes` を明示すると、GAS はそのリストしか要求しません。
> 機能を足してスコープが増えたときは必ずここに追記してください（不足すると実行時エラーになります）。
> 現在のスクリプトが実際に必要とするスコープは、Apps Script エディタの
> ［プロジェクトの設定］→［OAuth スコープ］で確認できます。

---

## 認証情報の扱い

**このアプリは API キー・シークレットを一切持ちません。** コードにもクライアント側 JS にも
埋め込む秘密情報はありません。Drive アクセスは実行ユーザー自身の OAuth 権限だけで完結します。

### 5-1. ブラウザに渡している唯一のもの: 本人の OAuth トークン

速度のため、読む・書く・一覧・検索は **ブラウザから Drive API v3 を直接**呼んでいます
（`client/app/050-drive-api.js` の `DriveApi`、`070-direct.js` の `Direct`）。`google.script.run` はサーバーの処理が 100ms でも
往復に 1〜2 秒かかる（GAS インスタンスの起動 + 転送）ためで、直接呼ぶと 0.2〜0.5 秒になります。

そのために、サーバーの `getBootstrap` / `getToken` が **アクセス中ユーザー自身の**
OAuth トークン（`ScriptApp.getOAuthToken()`）をクライアントへ返します。

| 項目 | 扱い |
|---|---|
| 誰のトークンか | 呼び出した本人のもの（`executeAs: USER_ACCESSING`）。他人の権限で動くことはない |
| 置き場所 | `DriveApi` のクロージャ内のメモリだけ。`window` / `localStorage` / URL には出さない。`doGet` の HTML（スナップショット）にも埋めない |
| 寿命 | 約 1 時間。45 分で取り直し、401 が返ったときも 1 回だけ取り直す |
| 送信先 | `www.googleapis.com` のみ |
| 止め方 | スクリプトプロパティ `DIRECT_DRIVE_ENABLED` に `false` を設定（再デプロイ不要・次回起動から全員 GAS 経由） |
| 到達できないとき | ネットワーク層で失敗したら、その画面では自動的に GAS 経由に戻る |

**リスクを正直に書くと**、トークンはこの iframe で動く JavaScript から読めます。
以前から esm.sh の第三者コードが同じ iframe で動き `google.script.run` を呼べた（＝本人が触れる
任意のファイルの読み書き・ゴミ箱移動が可能だった）ので信頼境界は変わりませんが、
トークンがあると **完全削除・共有設定の変更・共有ドライブの管理操作**まで可能になり、
タブを閉じても 1 時間は有効です。そのため次を前提にしています。

- CodeMirror・mermaid 等のライブラリは esm.sh ではなく自前の配信先から、**SRI 付きで**配信する（[hosting.md](hosting.md)）。
  第三者の実行時コードを起動経路から外し、配信元が差し替えられても実行させない。
  esm.sh へのフォールバックは `ESM_FALLBACK_ENABLED=true` のときだけ
- Markdown プレビューは DOMPurify を通し（`<style>`・フォーム部品は落とす）、外部の画像は既定で止める。
  mermaid の SVG も DOMPurify を通し、残した `<style>` はその図の中にしか効かない規則に絞る
  （`url()`・`@import` も落とす。`%%{init}%%` から CSS へ入る設定は書き換えさせない）。HTML プレビューは `allow-same-origin` 無しの `sandbox` iframe に隔離し、
  スクリプトは利用者が明示的に動かしたときだけ実行する（[architecture.md](architecture.md) の「プレビュー」）
- スコープは `drive`（フル）。任意のフォルダを一覧する要件上 `drive.file` には狭められない
- 監査ログは従来どおり、この GAS プロジェクトの OAuth クライアント名で Drive に記録される
- ユーザーは Google アカウントの［アカウントへのアクセスを持つアプリ］からいつでも失効できる

### 5-2. それ以外の秘密情報

将来、外部 API 連携などで認証情報が必要になった場合は、**コードに直書きせず**
`PropertiesService` から読み込んでください。

```javascript
// 悪い例（絶対にやらない）
var API_KEY = 'sk-xxxxxxxxxxxx';

// 良い例
function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) throw new Error('スクリプトプロパティ API_KEY が未設定です。');
  return key;
}
```

設定手順: Apps Script エディタ →［プロジェクトの設定］→［スクリプト プロパティ］
→［スクリプト プロパティを追加］でキーと値を登録します。
**取得した値をクライアント（`js.html`）へ渡さないこと。** ブラウザに渡した時点で
利用者から見えます。外部 API を叩く必要があるなら、サーバー側関数の中で
`UrlFetchApp` を使い、結果だけをクライアントへ返す設計にしてください
（その場合は `script.external_request` スコープの追加も必要です）。

---

