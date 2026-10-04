# リッチメニュー設定手順書（今回：Aのみ実装版）

今回は「プレ交際」タブ（A）のみを実装します。「真剣交際」タブ（B）への切り替え機能は後日追加します。
Postmanを使用します（Postmanのインストール・チャネルアクセストークンの準備は完了している前提です）。

---

## 今回やること／やらないこと

| 項目 | 今回 |
|---|---|
| リッチメニューA（プレ交際）の作成 | ✅ やる |
| Aへの画像アップロード | ✅ やる |
| デフォルトメニューにAを設定 | ✅ やる |
| ヘッダー右側「真剣交際」のタップ領域 | ❌ 入れない（Bがまだ存在しないため） |
| リッチメニューB（真剣交際）の作成 | ❌ 後日 |
| エイリアス作成（タブ切り替え機能） | ❌ 後日 |

---

## 事前に準備するもの

| 準備するもの | 入手方法 |
|---|---|
| チャネルアクセストークン | LINE Developers Console → 対象チャネル → 「Messaging API設定」タブ → 「チャネルアクセストークン（長期）」の「発行」 |
| Aの画像（1MB以下、2500×1686px） | `richmenu-pre.jpg` |
| 各カードのLIFF ID | LINE Developers Console → 該当のLINEミニアプリのチャネル → 「LIFF」タブ |

---

## 手順①：リッチメニューAを作成する

### Postmanでの設定
- メソッド：**POST**
- URL：
```
https://api.line.me/v2/bot/richmenu
```
- Headers：

| Key | Value |
|---|---|
| Authorization | Bearer {channel access token} |
| Content-Type | application/json |

- Body（raw / JSON）：

```json
{
    "size": { "width": 2500, "height": 1686 },
    "selected": true,
    "name": "richmenu-pre",
    "chatBarText": "メニュー",
    "areas": [
        {
            "bounds": { "x": 0, "y": 223, "width": 836, "height": 998 },
            "action": { "type": "uri", "uri": "https://miniapp.line.me/{自己開示Part1のliffId}" }
        },
        {
            "bounds": { "x": 836, "y": 223, "width": 827, "height": 998 },
            "action": { "type": "uri", "uri": "https://miniapp.line.me/{自己開示Part2のliffId}" }
        },
        {
            "bounds": { "x": 1663, "y": 223, "width": 837, "height": 998 },
            "action": { "type": "uri", "uri": "https://miniapp.line.me/{自己開示Part3のliffId}" }
        },
        {
            "bounds": { "x": 0, "y": 1221, "width": 1250, "height": 465 },
            "action": { "type": "uri", "uri": "https://miniapp.line.me/{婚活プロフィールのliffId}" }
        },
        {
            "bounds": { "x": 1250, "y": 1221, "width": 1250, "height": 465 },
            "action": { "type": "uri", "uri": "https://miniapp.line.me/{価値観すり合わせのliffId}" }
        }
    ]
}
```

※ `{◯◯のliffId}` の部分は、必ず実際のLIFF IDに書き換えてから送信してください。

### 送信後
- 「Send」をクリック
- 返ってきたレスポンスの中の `richMenuId` をメモ帳などに保存

```json
{"richMenuId":"richmenu-xxxxxxxxxxxxxxxxxxxx"}
```

👉 これを以後 `{richMenuId_A}` とします。

---

## 手順②：Aに画像をアップロードする

### Postmanでの設定
- メソッド：**POST**
- URL（`{richMenuId_A}` を実際のIDに置き換え）：
```
https://api-data.line.me/v2/bot/richmenu/{richMenuId_A}/content
```
- Headers：

| Key | Value |
|---|---|
| Authorization | Bearer {channel access token} |
| Content-Type | image/jpeg |

- Body：「binary」を選択し、`richmenu-pre.jpg` を選択

### 送信後
- 「Send」をクリック
- エラーが表示されなければ成功

---

## 手順③：デフォルトメニューにAを設定する

これで、友だち全員のトーク画面にAが表示されるようになります。

### Postmanでの設定
- メソッド：**POST**
- URL（`{richMenuId_A}` を実際のIDに置き換え）：
```
https://api.line.me/v2/bot/user/all/richmenu/{richMenuId_A}
```
- Headers：

| Key | Value |
|---|---|
| Authorization | Bearer {channel access token} |

- Body：なし（「none」を選択）

### 送信後
- 「Send」をクリック
- エラーが表示されなければ完了

---

## 動作確認

1. LINE公式アカウントのトーク画面を開き直す
2. リッチメニュー（プレ交際タブの5カード）が表示される
3. 各カードをタップ → 該当のLINEミニアプリが開く
4. ヘッダー右側の「真剣交際」の文字部分をタップ → 何も反応しない（これは想定通りの動作。エラーにはならない）

---

## 今後、Bを実装する際に必要になる作業（参考）

リッチメニューは中身を後から編集できないため、Bを追加する際は「Aを作り直して差し替える」形になります。当日改めて手順書をお渡ししますが、流れとしては以下の通りです。

1. リッチメニューB（6カード版）を新規作成し、画像をアップロード
2. リッチメニューA を**ヘッダー右側に切り替えアクションを追加した内容で作り直す**（新しい`richMenuId_A`が発行される）
3. 新しいAに画像を再アップロード
4. 新しい`richMenuId_A`を改めてデフォルトメニューに設定し直す
5. エイリアス（`richmenu-alias-pre` / `richmenu-alias-shinken`）を新しいID同士で作成する

今回作成する `richMenuId_A` や画像は、その際の土台としてそのまま使えますので、今回の作業が無駄になることはありません。
