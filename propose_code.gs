/* ============================================================
   プロポーズプラン – GAS バックエンド (Code.gs)
   スプレッドシートID: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ------------------------------------------------------------
   【方式（暗号キー方式）】
   ・共有はshareTargetPickerによるリンク送付ではなく、真剣交際
     登録時にPartners側で発行される「暗号キー」で行う。
   ・ユーザーはこのアプリを開くとき、暗号キー（パートナー登録画面
     で確認できる）を入力する。以後はローカルに保存され、次回から
     自動入力される（ただし開くには毎回ワンクリックの確認が要る）。
   ・入力した回答は、暗号キーから導出したAES鍵でクライアント側で
     暗号化してから送信する。暗号キーの生データはこのサーバーは
     おろかPartnersサーバーにも送らない。送るのは
     sha256Hex("lookup:" + 暗号キー) というハッシュ値のみ。
     （AES鍵は sha256("cipher:" + 暗号キー) から導出するため、
     このハッシュ値だけを知っていてもAES鍵は導出できない）
   ・「入力完了」ボタンを押すまでは、相手はこちらの回答を見られない。
     入力完了後に「編集する」を押すと未完了状態に戻り、再度入力完了
     するまでまた見られなくなる。
   ・交際終了後は、同じ暗号キーを入力しても回答画面自体を開けない
     （Partners側でその暗号キーのpairKeyHashがactive以外になるため）。
   ------------------------------------------------------------
   シート構成:
   ・「Answers」   … 暗号化済みの回答本体（1人 × 1組につき1行）
   ・「Analytics」 … 集計用の平文データ（選択肢の全文）
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」でこのコードを貼り付ける。
   2. 下記 SPREADSHEET_ID にスプレッドシートIDを設定する。
   3. スクリプトプロパティに INTERNAL_SECRET を設定する
      （Partners用GASと同じ値にすること）。
   4. 下記 PARTNERS_ENDPOINT に、Partners用GASの /exec URLを設定する。
   5. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」でデプロイし、
      発行された /exec URL を propose_app.js の GAS_ENDPOINT に設定する。
   ============================================================ */

var SPREADSHEET_ID       = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // ← プロポーズプラン用スプレッドシートIDに差し替えてください
var SHEET_NAME            = 'Answers';
var ANALYTICS_SHEET_NAME  = 'Analytics';
var DATA_START_ROW        = 2; // 1行目=見出し, 2行目以降がデータ

// Answers シートの列番号（1-indexed）
var COL = {
  ID: 1, PAIR_KEY_HASH: 2, OWNER_HASH: 3, CIPHER_TEXT: 4,
  COMPLETED: 5, CREATED_AT: 6, UPDATED_AT: 7, COMPLETED_AT: 8
};

// Analytics シートの列番号（1-indexed）
// ※ 平文で保存する統計用データ。cipherText とは異なり運営者が閲覧できる。
var ACOL = {
  ID: 1, PAIR_KEY_HASH: 2, OWNER_HASH: 3, COMPLETED: 4,
  Q1_1: 5, Q1_1_OTHER: 6, Q1_2: 7, Q1_2_OTHER: 8,
  Q2: 9, Q2_OTHER: 10, Q3: 11, Q3_OTHER: 12,
  Q4: 13, Q5: 14,
  CREATED_AT: 15, UPDATED_AT: 16, COMPLETED_AT: 17
};

var ANSWERS_HEADER = [
  'id', 'pairKeyHash', 'ownerHash', 'cipherText',
  'completed', 'createdAt', 'updatedAt', 'completedAt'
];

var ANALYTICS_HEADER = [
  'id', 'pairKeyHash', 'ownerHash', 'completed',
  'q1_1', 'q1_1_other', 'q1_2', 'q1_2_other',
  'q2', 'q2_other', 'q3', 'q3_other',
  'q4', 'q5',
  'createdAt', 'updatedAt', 'completedAt'
];

/* ------------------------------------------------------------
   Partners中央APIとの連携（暗号キーの検証）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';
var PAIR_VALIDATION_CACHE_SECONDS = 300; // 5分キャッシュ

/* pairKeyHash を Partners に照会する。
   戻り値: { ok, active, userAHash, userBHash, reason } */
function validatePairKeyHash(pairKeyHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'pairkey_' + pairKeyHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { ok: false, reason: 'server_error' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=validatePairKeyHash'
      + '&pairKeyHash=' + encodeURIComponent(pairKeyHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    result = JSON.parse(res.getContentText());
  } catch (err) {
    Logger.log('validatePairKeyHash failed: ' + err);
    result = { ok: false, reason: 'server_error' };
  }
  // invalid_key（そもそも存在しない）や active:false（交際終了済み）は
  // 短くキャッシュしすぎない方が安全なので、成功時のみ・短めにキャッシュする
  if (result.ok) {
    cache.put(cacheKey, JSON.stringify(result), PAIR_VALIDATION_CACHE_SECONDS);
  }
  return result;
}

/* pairKeyHashを検証し、かつ ownerHash がその2人のどちらかであることも
   確認する。共通の前処理としてすべてのアクションの先頭で呼ぶ。
   戻り値: { ok, partnerHash, reason } */
function validatePairKeyHashForOwner(pairKeyHash, ownerHash) {
  var v = validatePairKeyHash(pairKeyHash);
  if (!v.ok) return { ok: false, reason: v.reason || 'invalid_key' };
  if (!v.active) return { ok: false, reason: 'partner_ended' };
  if (v.userAHash !== ownerHash && v.userBHash !== ownerHash) {
    return { ok: false, reason: 'not_a_party' };
  }
  var partnerHash = (v.userAHash === ownerHash) ? v.userBHash : v.userAHash;
  return { ok: true, partnerHash: partnerHash };
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'fetchPair') {
      return handleFetchPair(e.parameter.pairKeyHash, e.parameter.ownerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'submit') {
      return handleSubmit(body);
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
  return getOrCreateSheet_(SHEET_NAME, ANSWERS_HEADER);
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
   action=submit（回答の保存。下書き保存ではなく「入力完了」操作、
   および「編集する」による未完了への差し戻し、両方をこれで扱う）
   body: { pairKeyHash, ownerHash, cipherText, completed, analytics }
   ------------------------------------------------------------ */
function handleSubmit(body) {
  var pairKeyHash = body.pairKeyHash;
  var ownerHash   = body.ownerHash;
  var cipherText  = body.cipherText;
  var completed   = !!body.completed;
  var analytics   = body.analytics || {};

  if (!pairKeyHash || !ownerHash || !cipherText) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var check = validatePairKeyHashForOwner(pairKeyHash, ownerHash);
  if (!check.ok) return jsonResponse({ ok: false, reason: check.reason });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet          = getSheet();
    var analyticsSheet = getAnalyticsSheet();
    var now = new Date();

    var rowIndex = findAnswerRow(sheet, pairKeyHash, ownerHash);
    var id = rowIndex ? sheet.getRange(rowIndex, COL.ID).getValue() : Utilities.getUuid();
    var createdAt = now;
    var completedAt = completed ? now : '';

    if (rowIndex) {
      createdAt = sheet.getRange(rowIndex, COL.CREATED_AT).getValue() || now;
      if (completed) {
        // すでに一度入力完了していた場合は、その最初のcompletedAtは
        // 上書きせず、今回新たに完了した場合のみ現在時刻にする
        var prevCompleted = sheet.getRange(rowIndex, COL.COMPLETED).getValue();
        var prevCompletedAt = sheet.getRange(rowIndex, COL.COMPLETED_AT).getValue();
        completedAt = (prevCompleted && prevCompletedAt) ? prevCompletedAt : now;
      }
      sheet.getRange(rowIndex, 1, 1, ANSWERS_HEADER.length).setValues([[
        id, pairKeyHash, ownerHash, cipherText, completed, createdAt, now, completedAt
      ]]);
    } else {
      sheet.appendRow([id, pairKeyHash, ownerHash, cipherText, completed, createdAt, now, completedAt]);
    }

    upsertAnalyticsRow(analyticsSheet, pairKeyHash, ownerHash, completed, analytics, createdAt, now, completedAt);

    return jsonResponse({ ok: true, completed: completed });
  } finally {
    lock.releaseLock();
  }
}

function upsertAnalyticsRow(sheet, pairKeyHash, ownerHash, completed, analytics, createdAt, now, completedAt) {
  var rowIndex = findAnalyticsRow(sheet, pairKeyHash, ownerHash);
  var id = rowIndex ? sheet.getRange(rowIndex, ACOL.ID).getValue() : Utilities.getUuid();

  var rowValues = [
    id, pairKeyHash, ownerHash, completed,
    analytics.q1_1 || '', analytics.q1_1_other || '',
    analytics.q1_2 || '', analytics.q1_2_other || '',
    analytics.q2 || '', analytics.q2_other || '',
    analytics.q3 || '', analytics.q3_other || '',
    analytics.q4 || '', analytics.q5 || '',
    createdAt, now, completedAt
  ];

  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}


/* ------------------------------------------------------------
   action=fetchPair（自分の回答状況＋相手の回答状況を取得）
   ・自分の回答は completed に関わらず常に返す（下書き復元用ではなく、
     他端末からでも自分の最新の入力完了内容を確認できるようにするため）
   ・相手の回答は completed === true の場合のみ cipherText を含める
   ------------------------------------------------------------ */
function handleFetchPair(pairKeyHash, ownerHash) {
  if (!pairKeyHash || !ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var check = validatePairKeyHashForOwner(pairKeyHash, ownerHash);
  if (!check.ok) return jsonResponse({ ok: false, reason: check.reason });

  var sheet = getSheet();
  var own = readAnswerRow(sheet, pairKeyHash, ownerHash);
  var partner = readAnswerRow(sheet, pairKeyHash, check.partnerHash);

  return jsonResponse({
    ok: true,
    own: own
      ? { cipherText: own.cipherText, completed: own.completed, updatedAt: own.updatedAt }
      : null,
    partner: (partner && partner.completed)
      ? { cipherText: partner.cipherText, completed: true, updatedAt: partner.updatedAt }
      : { completed: false }
  });
}

function readAnswerRow(sheet, pairKeyHash, ownerHash) {
  var rowIndex = findAnswerRow(sheet, pairKeyHash, ownerHash);
  if (!rowIndex) return null;
  var v = sheet.getRange(rowIndex, 1, 1, COL.COMPLETED_AT).getValues()[0];
  return {
    cipherText: v[COL.CIPHER_TEXT - 1],
    completed: !!v[COL.COMPLETED - 1],
    updatedAt: v[COL.UPDATED_AT - 1]
  };
}


/* ------------------------------------------------------------
   検索ヘルパー（pairKeyHash + ownerHash で一意な行を探す）
   ------------------------------------------------------------ */
function findAnswerRow(sheet, pairKeyHash, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][COL.PAIR_KEY_HASH - 1] === pairKeyHash && values[i][COL.OWNER_HASH - 1] === ownerHash) {
      return DATA_START_ROW + i;
    }
  }
  return null;
}

function findAnalyticsRow(sheet, pairKeyHash, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][ACOL.PAIR_KEY_HASH - 1] === pairKeyHash && values[i][ACOL.OWNER_HASH - 1] === ownerHash) {
      return DATA_START_ROW + i;
    }
  }
  return null;
}
