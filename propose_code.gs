/* ============================================================
   プロポーズプラン – GAS バックエンド (Code.gs)
   スプレッドシートID: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ------------------------------------------------------------
   【方式：自動ペア判定＋自動暗号鍵取得】
   ・ユーザーは暗号キーの入力も、個別の招待リンクも一切扱わない。
   ・クライアントが送るのは ownerHash（LINE userIdのSHA-256）だけ。
   ・このサーバーは、受け取った ownerHash を毎回 Partners中央API
     （サーバー間限定・INTERNAL_SECRET必須）に問い合わせて、
     「現在の真剣交際パートナー」と「ペア専用の暗号鍵材料
     （Partners側で真剣交際成立時に発行済みのpairKey）」を取得する。
   ・pairKeyは常にPartners側が真実の情報源（single source of truth）
     であり、クライアントから送られてきた値を信用することはしない
     （なりすまし・古い値の使い回しを防ぐため）。
   ・回答本体は、pairKeyから導出したAES鍵でクライアント側で暗号化
     してから保存する。pairKeyの生値はこのシートには保存しない
     （sha256("lookup:"+pairKey) をシート内の行の特定キーとして使う）。
   ・「入力完了」ボタンを押すまでは、相手はこちらの回答を見られない。
     入力完了後に「編集する」を押すと未完了状態に戻り、再度入力完了
     するまでまた見られなくなる。
   ・交際終了後は、Partners側でそのpairKeyがactive以外になるため、
     自動的に回答画面自体が開けなくなる。
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
   Partners中央APIとの連携（ownerHash → 現在のパートナー＋暗号鍵材料）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';
var PARTNER_CACHE_SECONDS = 120; // 2分キャッシュ（Partnersへの往復回数を減らす）

/* ownerHashからPartnersに真剣交際の状態を問い合わせる。
   戻り値: { ok, active, everPartnered, partnerHash, pairKey } */
function resolvePartner(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { ok: false, active: false, everPartnered: false, partnerHash: '', pairKey: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        ok: true,
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || '',
        pairKey: body.pairKey || ''
      };
    }
  } catch (err) {
    Logger.log('resolvePartner failed: ' + err);
  }
  // activeな場合のみキャッシュする（交際終了直後の反映を遅らせすぎないため）
  if (result.ok && result.active) {
    cache.put(cacheKey, JSON.stringify(result), PARTNER_CACHE_SECONDS);
  }
  return result;
}

/* GAS上でのSHA-256（16進文字列）。クライアント側の
   sha256Hex("lookup:" + pairKey) と必ず同じ計算方法で揃えること。 */
function sha256HexGS(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'fetchPair') {
      return handleFetchPair(e.parameter.ownerHash);
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

/* reasonの共通判定。「そもそも真剣交際していない」のか
   「していたが終了した」のかでUI側の案内文を変えられるようにする。 */
function partnerReason(resolved) {
  if (!resolved.ok) return 'server_error';
  if (resolved.active) return null; // 問題なし
  if (resolved.everPartnered) return 'partner_ended';
  return 'no_partner';
}


/* ------------------------------------------------------------
   action=submit（回答の保存。「入力完了」操作、および
   「編集する」による未完了への差し戻し、両方をこれで扱う）
   body: { ownerHash, cipherText, completed, analytics }
   ※ pairKeyHashはクライアントから受け取らない。必ずPartnersへの
     問い合わせ結果から自分で導出する（なりすまし防止）。
   ------------------------------------------------------------ */
function handleSubmit(body) {
  var ownerHash  = body.ownerHash;
  var cipherText = body.cipherText;
  var completed  = !!body.completed;
  var analytics  = body.analytics || {};

  if (!ownerHash || !cipherText) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var resolved = resolvePartner(ownerHash);
  var reason = partnerReason(resolved);
  if (reason) return jsonResponse({ ok: false, reason: reason });

  var pairKeyHash = sha256HexGS('lookup:' + resolved.pairKey);

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
   action=fetchPair（現在のパートナー情報＋暗号鍵材料＋
   自分の回答状況＋相手の回答状況を、一度にまとめて返す）
   ・自分の回答は completed に関わらず常に返す
   ・相手の回答は completed === true の場合のみ cipherText を含める
   ・pairKey（暗号鍵材料の生値）はここで初めてクライアントに渡る。
     ユーザーが目にすることはなく、ブラウザのメモリ上でAES鍵の
     導出にのみ使われる想定。
   ------------------------------------------------------------ */
function handleFetchPair(ownerHash) {
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var resolved = resolvePartner(ownerHash);
  var reason = partnerReason(resolved);
  if (reason) return jsonResponse({ ok: false, reason: reason });

  var pairKeyHash = sha256HexGS('lookup:' + resolved.pairKey);

  var sheet = getSheet();
  var own = readAnswerRow(sheet, pairKeyHash, ownerHash);
  var partner = readAnswerRow(sheet, pairKeyHash, resolved.partnerHash);

  return jsonResponse({
    ok: true,
    pairKey: resolved.pairKey,
    partnerHash: resolved.partnerHash,
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
