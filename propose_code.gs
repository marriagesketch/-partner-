/* ============================================================
   プロポーズプラン – GAS バックエンド (Code.gs)
   スプレッドシートID: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ------------------------------------------------------------
   ・シート「Shares」    … 共有リンク本体（暗号化済み回答）
   ・シート「Analytics」 … 集計用の平文データ（選択肢の全文）
     ※ Shares の1行につき、同じ id の Analytics 行が1つ対応する。
   ------------------------------------------------------------
   共有リンクの扱い（ハイブリッド方式。selfintroductionと同様）:
   ・まだ誰にも開かれていない間は、同じid・同じリンクのまま
     中身だけ上書き更新する（＝編集してもリンクは変わらない）。
   ・誰かがそのリンクを一度開いた後にプロフィールを更新すると、
     その行は履歴として残したまま、新しいid・新しいリンクを
     発行する（＝閲覧済みのリンクの中身は勝手に変わらない）。
   ・Analytics行も、上記のShares行の状態遷移に完全に追従させる
     （同じidの行が上書きされる場合はAnalyticsも上書き、
     新しい行が発行される場合はAnalyticsも新しい行を発行）。
   ・アクセス制御（本人／初回閲覧者／真剣交際パートナー）は
     selfintroductionと同様のロジックを使用する。
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」でこのコードを貼り付ける。
   2. スプレッドシートに「Shares」シートと「Analytics」シートを
      作成する（無ければ初回アクセス時に自動作成されます）。
   3. スクリプトプロパティに INTERNAL_SECRET を設定する
      （Partners用GASと共有する秘密文字列。Partners側と一致させること）。
   4. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイし、発行された /exec URL を propose_app.js の
      GAS_ENDPOINT に設定する。
   ============================================================ */

var SPREADSHEET_ID       = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // ← プロポーズプラン用スプレッドシートIDに差し替えてください
var SHEET_NAME            = 'Shares';
var ANALYTICS_SHEET_NAME  = 'Analytics';
var SCHEMA_VERSION        = 1;

// Shares シートの列番号（1-indexed）
var COL = {
  ID: 1, CIPHER_TEXT: 2, ENCRYPTED_KEY: 3, OWNER_HASH: 4, VIEWER_HASH: 5,
  STATUS: 6, SCHEMA_VERSION: 7, CREATED_AT: 8, UPDATED_AT: 9,
  FIRST_VIEWED_AT: 10, LAST_VIEWED_AT: 11, VIEW_COUNT: 12
};

// Analytics シートの列番号（1-indexed）
// ※ 平文で保存する統計用データ。cipherText とは異なり運営者が閲覧できる。
var ACOL = {
  ID: 1, OWNER_HASH: 2,
  Q1_1: 3, Q1_1_OTHER: 4, Q1_2: 5, Q1_2_OTHER: 6,
  Q2: 7, Q2_OTHER: 8, Q3: 9, Q3_OTHER: 10,
  Q4: 11, Q5: 12,
  CREATED_AT: 13, UPDATED_AT: 14
};

var SHARES_HEADER = [
  'id', 'cipherText', 'encryptedKey', 'ownerHash', 'viewerHash',
  'status', 'schemaVersion', 'createdAt', 'updatedAt',
  'firstViewedAt', 'lastViewedAt', 'viewCount'
];

var ANALYTICS_HEADER = [
  'id', 'ownerHash',
  'q1_1', 'q1_1_other', 'q1_2', 'q1_2_other',
  'q2', 'q2_other', 'q3', 'q3_other',
  'q4', 'q5',
  'createdAt', 'updatedAt'
];

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ・ selfintroductionと同じ仕組みを使用する。
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

var PARTNER_STATUS_CACHE_SECONDS = 900; // 15分キャッシュ（外部fetchの頻度を抑えるため）

function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { active: false, everPartnered: false, partnerHash: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || ''
      };
    }
  } catch (err) {
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), PARTNER_STATUS_CACHE_SECONDS);
  return result;
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'view') {
      return handleView(e.parameter.id, e.parameter.viewerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'share') {
      return handleShare(body);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* シートが無ければ見出し付きで自動作成して返す */
function getSheet() {
  return getOrCreateSheet_(SHEET_NAME, SHARES_HEADER);
}

function getAnalyticsSheet() {
  return getOrCreateSheet_(ANALYTICS_SHEET_NAME, ANALYTICS_HEADER);
}

function getOrCreateSheet_(name, header) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}


/* ------------------------------------------------------------
   共有登録／更新（ハイブリッド方式）
   ・cipherText はクライアント側で AES-GCM 暗号化済みのため、
     このサーバー（および管理者）は復号鍵を一切受け取らない。
   ・analytics は集計用の平文データ（選択肢の全文）で、
     Shares行の状態遷移（上書き／新規発行）に完全に追従させて
     Analyticsシートへ書き込む。
   ・id が既存行に存在し、かつ ownerHash が一致する場合：
     - その行がまだ誰にも開かれていない（VIEWER_HASH が空）
       → その行を上書き更新する（同じリンクのまま。従来通り）
     - その行はすでに誰かに開かれている
       → その行は履歴として残し、新しいidを発行して新しい行を
         追加する（＝閲覧済みのリンクの中身は変えない）
   ・id が存在しない場合（初回共有、または新しいidでの共有）：
     → 同じ ownerHash の「未閲覧」の古い行があれば、その行の
       内容（idを含む）を新しい内容で上書きしたうえで使う
       （1人につき未閲覧の行は常に最大1つ）。
   ・戻り値の id は実際に使われた（更新／追加された）行の id。
     クライアント側は、送信した id と異なる id が返ってきた場合、
     新しいリンクが発行されたと判断して保存し直す必要がある。
   ------------------------------------------------------------ */
function handleShare(body) {
  var id         = body.id;
  var cipherText = body.cipherText;
  var ownerHash  = body.ownerHash;
  var analytics  = body.analytics || {};

  if (!id || !cipherText || !ownerHash) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet          = getSheet();
    var analyticsSheet = getAnalyticsSheet();
    var now = new Date();

    var rowIndex = findRowById(sheet, id);

    if (rowIndex) {
      // 既存行（本人確認のためownerHashを照合）
      var existingOwnerHash  = sheet.getRange(rowIndex, COL.OWNER_HASH).getValue();
      var existingViewerHash = sheet.getRange(rowIndex, COL.VIEWER_HASH).getValue();
      if (existingOwnerHash !== ownerHash) {
        return jsonResponse({ ok: false, reason: 'forbidden' });
      }

      if (!existingViewerHash) {
        // まだ誰にも開かれていない → 同じ行・同じリンクのまま上書き
        sheet.getRange(rowIndex, COL.CIPHER_TEXT).setValue(cipherText);
        sheet.getRange(rowIndex, COL.UPDATED_AT).setValue(now);
        sheet.getRange(rowIndex, COL.STATUS).setValue('active');
        upsertAnalyticsRow(analyticsSheet, id, id, ownerHash, analytics, now);
        return jsonResponse({ ok: true, id: id });
      }
      // すでに誰かに開かれている → この行はそのまま残し、下で新しい行を作る
    }

    // 新しい行を追加する（id未発見、または既存行が閲覧済みだったため新規発行）。
    var newId = rowIndex ? Utilities.getUuid() : id;
    var newRow = [
      newId, cipherText, '', ownerHash, '', 'active', SCHEMA_VERSION,
      now, now, '', '', 0
    ];
    var oldId = upsertUnviewedRow(sheet, ownerHash, newRow);
    upsertAnalyticsRow(analyticsSheet, oldId, newId, ownerHash, analytics, now);
    return jsonResponse({ ok: true, id: newId });
  } finally {
    lock.releaseLock();
  }
}

/* 同じ ownerHash の既存行のうち、まだ誰にも開かれていない
   （VIEWER_HASH が空の）行があれば、その行をそのまま上書きする
   （idも含めて新しい内容に置き換える）。該当行が無ければ新規行
   として追加する。すでに誰かが開いた行は履歴として残すため
   対象にしない。
   戻り値：上書きされた行の「元の」id（新規追加の場合は null）。
   これをAnalytics側の対応行を同期させるために使う。
   ※通常運用では該当行は0または1件のみのはず（複数残る場合は最初の
     1件だけを上書きし、残りは履歴として残る）。 */
function upsertUnviewedRow(sheet, ownerHash, rowValues) {
  var lastRow = sheet.getLastRow();
  var targetRow = null;
  var oldId = null;
  if (lastRow >= DATA_START_ROW) {
    var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.VIEWER_HASH).getValues();
    for (var i = 0; i < values.length; i++) {
      var rowOwnerHash  = values[i][COL.OWNER_HASH - 1];
      var rowViewerHash = values[i][COL.VIEWER_HASH - 1];
      if (rowOwnerHash === ownerHash && !rowViewerHash) {
        targetRow = DATA_START_ROW + i;
        oldId = values[i][COL.ID - 1];
        break;
      }
    }
  }
  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  return oldId;
}

/* Analyticsシートの対応行をShares側の状態遷移に追従させて書き込む。
   ・oldId が指定され、その id の行が見つかれば → その行を上書き
     （idをnewIdに更新。createdAtは元の値を保持）
   ・見つからなければ（oldIdがnull、または該当行が無い） → 新規追加 */
function upsertAnalyticsRow(sheet, oldId, newId, ownerHash, analytics, now) {
  var rowIndex = oldId ? findRowById(sheet, oldId) : null;

  var createdAt = now;
  if (rowIndex) {
    var existingCreatedAt = sheet.getRange(rowIndex, ACOL.CREATED_AT).getValue();
    if (existingCreatedAt) createdAt = existingCreatedAt;
  }

  var rowValues = [
    newId, ownerHash,
    analytics.q1_1 || '', analytics.q1_1_other || '',
    analytics.q1_2 || '', analytics.q1_2_other || '',
    analytics.q2 || '', analytics.q2_other || '',
    analytics.q3 || '', analytics.q3_other || '',
    analytics.q4 || '', analytics.q5 || '',
    createdAt, now
  ];

  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}


/* ------------------------------------------------------------
   閲覧（共有リンクを開いたとき）
   アクセス制御:
   ・本人（ownerHash と一致） → 常に許可
   ・真剣交際パートナーが登録済み → パートロックス（active）
     の場合はパートナーのみ許可、過去に交際していた
     （everPartnered、現在は不在）場合は本人以外は許可しない
   ・パートナー未登録（従来ロジック）:
     - viewerHash が未登録 → この人を初回閲覧者として登録し許可
     - viewerHash が登録済み → 一致すれば許可、不一致なら拒否
   ------------------------------------------------------------ */
function handleView(id, viewerHash) {
  if (!id) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!viewerHash) return jsonResponse({ ok: false, reason: 'login_required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rowIndex = findRowById(sheet, id);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'not_found' });

    var row = sheet.getRange(rowIndex, 1, 1, COL.VIEW_COUNT).getValues()[0];
    var cipherText          = row[COL.CIPHER_TEXT - 1];
    var ownerHash            = row[COL.OWNER_HASH - 1];
    var existingViewerHash   = row[COL.VIEWER_HASH - 1];
    var status               = row[COL.STATUS - 1];

    if (status !== 'active') {
      return jsonResponse({ ok: false, reason: status === 'active' ? 'not_found' : status });
    }

    var now = new Date();
    var allowed = false;
    var partnerInfo = getPartnerStatus(ownerHash);

    if (viewerHash === ownerHash) {
      allowed = true;
    } else if (partnerInfo.active) {
      allowed = (viewerHash === partnerInfo.partnerHash);
    } else if (partnerInfo.everPartnered) {
      allowed = false;
    } else if (!existingViewerHash) {
      allowed = true;
      sheet.getRange(rowIndex, COL.VIEWER_HASH).setValue(viewerHash);
      sheet.getRange(rowIndex, COL.FIRST_VIEWED_AT).setValue(now);
    } else if (existingViewerHash === viewerHash) {
      allowed = true;
    } else {
      allowed = false;
    }

    if (!allowed) {
      return jsonResponse({ ok: false, reason: (partnerInfo.active || partnerInfo.everPartnered) ? 'partner_locked' : 'forbidden' });
    }

    sheet.getRange(rowIndex, COL.LAST_VIEWED_AT).setValue(now);
    var viewCountCell = sheet.getRange(rowIndex, COL.VIEW_COUNT);
    viewCountCell.setValue((Number(viewCountCell.getValue()) || 0) + 1);

    return jsonResponse({ ok: true, cipherText: cipherText });
  } finally {
    lock.releaseLock();
  }
}

/* id (A列) からデータ行番号を探す。見つからなければ null */
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return DATA_START_ROW + i;
  }
  return null;
}
