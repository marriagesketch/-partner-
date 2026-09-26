/* ============================================================
   真剣交際パートナー管理 – GAS バックエンド (Code.gs)
   スプレッドシート名（想定）: konkatsuapp_partners_sheet
   ------------------------------------------------------------
   ・全ミニアプリ（自己開示Part1〜3／婚活プロフィール／すり合わせ）
     に共通の ownerHash（= sha256(LINEのuserId) ソルトなし）を
     キーに、「誰と誰が真剣交際中か」を一元管理する中央サービス。
   ・各ミニアプリのGAS(handleView)は、ここに ownerHash を問い合わせて
     「今このユーザーの共有物を見てよいのはパートナーだけか」を判定する。
   ・真剣交際が成立／終了すると、自己開示Part1〜3・すり合わせの
     4つのAnalyticsシートへ状態を同期（syncPartnerStatus）する。
   ------------------------------------------------------------
   【シート構成】シート名「Partners」（初回のみ setupPartnersSheet() を
   スクリプトエディタから手動実行してヘッダー行を作成してください）

   列: id / userAHash / userBHash / userADisplayName / userBDisplayName /
       status(pending|active|ended) / inviteToken /
       createdAt / confirmedAt / endedAt / endedBy / updatedAt
   ------------------------------------------------------------
   【エンドポイント】
   GET  ?action=status&ownerHash=...&secret=...
        → サーバー間限定。他ミニアプリのhandleViewから呼ばれる。
   POST { action:'start',   ownerHash, displayName }
        → 真剣交際登録を開始し、招待リンク用トークンを発行する
          （ユーザー本人のLIFFから直接呼び出す想定。secret不要）
   POST { action:'confirm', inviteToken, viewerHash, displayName }
        → 招待リンクを開いた相手が確認登録する（secret不要）
   POST { action:'end',     ownerHash }
        → 交際終了・パートナー解除（secret不要）
   POST { action:'cancel',  ownerHash }
        → 相手が確認する前に招待を取り消す（secret不要）
   POST { action:'syncPartnerStatus', ... , secret }
        → このシート自身が使う想定はなし（他アプリ側の同名アクション用。
          Partners側には実装不要）
   ------------------------------------------------------------
   【デプロイ手順】
   1. 新規スプレッドシートを作成し「拡張機能 > Apps Script」でこの
      コードを貼り付ける。
   2. 下記 SPREADSHEET_ID にスプレッドシートIDを設定する。
   3. スクリプトエディタから setupPartnersSheet() を一度手動実行し、
      「Partners」シートとヘッダー行を作成する。
   4. 「プロジェクトの設定 > スクリプト プロパティ」で
      INTERNAL_SECRET に任意のランダム文字列を設定する
      （他5アプリのスクリプトプロパティにも “同じ値” を設定すること。
       これはサーバー間通信専用の合言葉で、ユーザーには見えない）。
   5. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分 / アクセスできるユーザー: 全員
      でデプロイし、発行された /exec URL を控える。
   6. 5.のURLを、他5アプリの PARTNERS_ENDPOINT に設定する。
   7. 下記 APP_ENDPOINTS に、Analyticsシートを持つ4アプリ
      （自己開示Part1〜3・すり合わせ）の /exec URLを設定し、
      このPartnersプロジェクトを再デプロイする。
      （婚活プロフィールはAnalyticsシートが無いため含めない）
   ============================================================ */

var SPREADSHEET_ID = '1c3hRUtvJ6dY_hZZmPXhAxHt8WmLd_f57xZDjkahdHxs'; // ← Partners用スプレッドシートのIDを設定
var SHEET_NAME      = 'Partners';
var DATA_START_ROW  = 2; // 1行目=見出し, 2行目以降がデータ

var INTERNAL_SECRET = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

// syncPartnerStatus の送信先（Analyticsシートを持つ4アプリのみ。婚活プロフィールは対象外）
var APP_ENDPOINTS = [
  'https://script.google.com/macros/s/AKfycbwa7x1G4dHYRNUkfizGSXBcyxUemJzjIfKAtpfkeMJ8YQWYFtG_Om3kwltys85oamai/exec', // 自己開示 Part1
  'https://script.google.com/macros/s/AKfycby68Ftif3vL0zULDk0kuP55jsIWCs5EcIFJr_sEz2f4X6NVZTJ4-4wzie04zTbR4TvA/exec', // 自己開示 Part2
  'https://script.google.com/macros/s/AKfycbyP0doHt4EODuHGMTHbTIEFiDxuuMKVeNN67hgrlg67ZezcZr3Elb0h6zGmaz4tytee/exec', // 自己開示 Part3
  'https://script.google.com/macros/s/AKfycbzyvzON4-aCxsV1T37MZhDpIvHj-bGhC2ODfHiSgRifompdUN7o_XYivh2VErYMm-v0/exec'  // すり合わせ
];

// Partners シートの列番号（1-indexed）
var PCOL = {
  ID: 1, USER_A_HASH: 2, USER_B_HASH: 3,
  USER_A_DISPLAY_NAME: 4, USER_B_DISPLAY_NAME: 5,
  STATUS: 6, INVITE_TOKEN: 7,
  CREATED_AT: 8, CONFIRMED_AT: 9, ENDED_AT: 10, ENDED_BY: 11, UPDATED_AT: 12,
  // ↓ 真剣交際後の各種ミニアプリ（プロポーズプラン等）で共通して使う「暗号キー」
  PAIR_KEY: 13, PAIR_KEY_HASH: 14
};


/* ------------------------------------------------------------
   初回セットアップ用（手動実行）
   ------------------------------------------------------------ */
function setupPartnersSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, 14).setValues([[
    'id', 'userAHash', 'userBHash', 'userADisplayName', 'userBDisplayName',
    'status', 'inviteToken', 'createdAt', 'confirmedAt', 'endedAt', 'endedBy', 'updatedAt',
    'pairKey', 'pairKeyHash'
  ]]);
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'status') {
      return handleStatus(e.parameter.ownerHash, e.parameter.secret);
    }
    if (action === 'myStatus') {
      return handleMyStatus(e.parameter.ownerHash);
    }
    if (action === 'inviteInfo') {
      return handleInviteInfo(e.parameter.token);
    }
    if (action === 'validatePairKeyHash') {
      return handleValidatePairKeyHash(e.parameter.pairKeyHash, e.parameter.secret);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'start')   return handleStart(body);
    if (body.action === 'confirm') return handleConfirm(body);
    if (body.action === 'end')     return handleEnd(body);
    if (body.action === 'cancel')  return handleCancel(body);
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

function getSheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
}

/* GAS上でのSHA-256（16進文字列）計算。
   各ミニアプリのクライアント側 sha256Hex("lookup:" + pairKey) と
   必ず同じプレフィックス・同じアルゴリズムで揃えること。 */
function sha256HexGS(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/* 真剣交際後の各ミニアプリ（プロポーズプラン等）で共通して使う
   「暗号キー」を発行する。紛らわしい文字（0/O, 1/I/L）を除いた
   32文字の英数字から、4文字×4グループ（合計約80bit）を生成する。
   このキー自体は答えの暗号化キーの材料にもなるため、Partners以外の
   サーバーには常にハッシュ化してから送る運用とする。 */
function generatePairKey() {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var groups = [];
  for (var g = 0; g < 4; g++) {
    var chars = [];
    for (var i = 0; i < 4; i++) {
      chars.push(alphabet.charAt(Math.floor(Math.random() * alphabet.length)));
    }
    groups.push(chars.join(''));
  }
  return groups.join('-');
}


/* ------------------------------------------------------------
   action=status（サーバー間限定・secret必須）
   各ミニアプリのhandleViewから、対象ownerHashの
   「今パートナー閲覧のみに制限すべきか」を問い合わせるためのAPI。
   ・active:true          → 現在真剣交際中。partnerHashのみ閲覧可。
   ・active:false かつ
     everPartnered:true   → 過去に交際していたが現在パートナー不在
                             （交際終了後など）。本人以外は不可。
   ・両方false             → 一度も真剣交際登録をしていない。
                             各アプリは従来の「初回閲覧者固定」ロジックを使う。
   ------------------------------------------------------------ */
function handleStatus(ownerHash, secret) {
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    return jsonResponse({ ok: false, reason: 'forbidden' });
  }
  var full = computeFullStatus(ownerHash);
  return jsonResponse({
    ok: true,
    active: full.status === 'active',
    everPartnered: (full.status === 'active' || full.status === 'ended'),
    partnerHash: full.partnerHash,
    partnerDisplayName: full.partnerDisplayName,
    startedAt: full.startedAt,
    // active中のみ、真剣交際限定ミニアプリの暗号化に使う鍵材料を含める。
    // サーバー間限定（secret必須）のこのレスポンスでのみ渡し、
    // ユーザーが直接目にする画面には表示しない。
    pairKey: full.status === 'active' ? (full.pairKey || '') : ''
  });
}


/* ------------------------------------------------------------
   action=myStatus（ユーザー本人のLIFFから直接呼ばれる。secret不要）
   secretを要求しない代わりに、返す情報は「自分自身の状態」のみ。
   ・status: 'none' | 'pending_sent' | 'active' | 'ended'
   ・pending_sent の場合のみ inviteToken を含める
   ・active の場合のみ pairKey を含める
     （真剣交際後の各ミニアプリ共通の「暗号キー」。本人・パートナー
     以外には見せないため、この本人限定エンドポイントでのみ返す）
   ------------------------------------------------------------ */
function handleMyStatus(ownerHash) {
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });
  var full = computeFullStatus(ownerHash);
  return jsonResponse(Object.assign({ ok: true }, full));
}

function computeFullStatus(ownerHash) {
  var rows = getAllRows(getSheet());
  var activeRow = null, pendingRow = null, lastEndedRow = null;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var isParty = (r.userAHash === ownerHash || r.userBHash === ownerHash);
    if (!isParty) continue;
    if (r.status === 'active') {
      activeRow = r;
    } else if (r.status === 'pending' && r.userAHash === ownerHash) {
      // pending_sent とみなすのは招待した本人（userA）のみ。
      pendingRow = r;
    } else if (r.status === 'ended') {
      if (!lastEndedRow || new Date(r.endedAt) > new Date(lastEndedRow.endedAt)) lastEndedRow = r;
    }
  }

  if (activeRow) {
    var isA = activeRow.userAHash === ownerHash;
    return {
      status: 'active',
      partnerHash: isA ? activeRow.userBHash : activeRow.userAHash,
      partnerDisplayName: isA ? activeRow.userBDisplayName : activeRow.userADisplayName,
      startedAt: activeRow.confirmedAt,
      endedAt: '',
      pairKey: activeRow.pairKey || ''
    };
  }
  if (pendingRow) {
    return {
      status: 'pending_sent',
      inviteToken: pendingRow.inviteToken,
      partnerHash: '', partnerDisplayName: '', startedAt: '', endedAt: ''
    };
  }
  if (lastEndedRow) {
    var isA2 = lastEndedRow.userAHash === ownerHash;
    return {
      status: 'ended',
      partnerHash: isA2 ? lastEndedRow.userBHash : lastEndedRow.userAHash,
      partnerDisplayName: isA2 ? lastEndedRow.userBDisplayName : lastEndedRow.userADisplayName,
      startedAt: lastEndedRow.confirmedAt,
      endedAt: lastEndedRow.endedAt
    };
  }
  return { status: 'none', partnerHash: '', partnerDisplayName: '', startedAt: '', endedAt: '' };
}


/* ------------------------------------------------------------
   action=inviteInfo（招待リンクを開いた相手が、確認前にプレビューする用。
   secret不要。トークンさえ知っていれば閲覧できる、共有リンク方式と
   同じ考え方。ハッシュなど個人特定情報は一切返さない）
   ------------------------------------------------------------ */
function handleInviteInfo(token) {
  if (!token) return jsonResponse({ ok: false, reason: 'invalid_params' });
  var rowIndex = findRowIndexByToken(getSheet(), token);
  if (!rowIndex) return jsonResponse({ ok: false, reason: 'invalid_or_expired_token' });
  var row = getRowObject(getSheet(), rowIndex);
  if (row.status !== 'pending') return jsonResponse({ ok: false, reason: 'invalid_or_expired_token' });
  return jsonResponse({ ok: true, inviterDisplayName: row.userADisplayName || '' });
}


/* ------------------------------------------------------------
   action=validatePairKeyHash（サーバー間限定・secret必須）
   プロポーズプラン等、真剣交際後限定の各ミニアプリから呼ばれる。
   クライアントは生の暗号キーを一切サーバーに送らず、
   sha256Hex("lookup:" + pairKey) をここに渡して照合する。
   ・見つからない                → {ok:false, reason:'invalid_key'}
   ・見つかったが現在active以外  → {ok:true, active:false}
     （交際終了後は同じキーが使えなくなる）
   ・見つかってactive            → {ok:true, active:true, userAHash, userBHash}
   ------------------------------------------------------------ */
function handleValidatePairKeyHash(pairKeyHash, secret) {
  if (!pairKeyHash) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    return jsonResponse({ ok: false, reason: 'forbidden' });
  }

  var rows = getAllRows(getSheet());
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.pairKeyHash && r.pairKeyHash === pairKeyHash) {
      if (r.status === 'active') {
        return jsonResponse({ ok: true, active: true, userAHash: r.userAHash, userBHash: r.userBHash });
      }
      return jsonResponse({ ok: true, active: false });
    }
  }
  return jsonResponse({ ok: false, reason: 'invalid_key' });
}


/* ------------------------------------------------------------
   action=start（ユーザー本人のLIFFから直接呼ばれる。secret不要）
   すでに有効／保留中のパートナー関係がある場合は拒否する
   （1人につき同時に1組まで）。
   ------------------------------------------------------------ */
function handleStart(body) {
  var ownerHash   = body.ownerHash;
  var displayName = body.displayName || '';
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rows = getAllRows(sheet);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if ((r.userAHash === ownerHash || r.userBHash === ownerHash) &&
          (r.status === 'active' || r.status === 'pending')) {
        return jsonResponse({ ok: false, reason: r.status === 'active' ? 'already_active' : 'already_pending' });
      }
    }

    var now = new Date();
    var inviteToken = Utilities.getUuid();
    sheet.appendRow([
      Utilities.getUuid(), ownerHash, '', displayName, '',
      'pending', inviteToken, now, '', '', '', now
    ]);
    return jsonResponse({ ok: true, inviteToken: inviteToken });
  } finally {
    lock.releaseLock();
  }
}


/* ------------------------------------------------------------
   action=confirm（招待リンクを開いた相手のLIFFから呼ばれる。secret不要）
   ------------------------------------------------------------ */
function handleConfirm(body) {
  var inviteToken = body.inviteToken;
  var viewerHash  = body.viewerHash;
  var displayName = body.displayName || '';
  if (!inviteToken || !viewerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rowIndex = findRowIndexByToken(sheet, inviteToken);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'invalid_or_expired_token' });

    var row = getRowObject(sheet, rowIndex);
    if (row.status !== 'pending') {
      return jsonResponse({ ok: false, reason: 'invalid_or_expired_token' });
    }
    if (row.userAHash === viewerHash) {
      return jsonResponse({ ok: false, reason: 'cannot_partner_self' });
    }

    var rows = getAllRows(sheet);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if ((r.userAHash === viewerHash || r.userBHash === viewerHash) &&
          (r.status === 'active' || r.status === 'pending')) {
        return jsonResponse({ ok: false, reason: r.status === 'active' ? 'already_active' : 'already_pending' });
      }
    }

    var now = new Date();
    var pairKey = generatePairKey();
    var pairKeyHash = sha256HexGS('lookup:' + pairKey);
    sheet.getRange(rowIndex, PCOL.USER_B_HASH).setValue(viewerHash);
    sheet.getRange(rowIndex, PCOL.USER_B_DISPLAY_NAME).setValue(displayName);
    sheet.getRange(rowIndex, PCOL.STATUS).setValue('active');
    sheet.getRange(rowIndex, PCOL.INVITE_TOKEN).setValue(''); // トークンは1回限り。以後無効化
    sheet.getRange(rowIndex, PCOL.CONFIRMED_AT).setValue(now);
    sheet.getRange(rowIndex, PCOL.UPDATED_AT).setValue(now);
    sheet.getRange(rowIndex, PCOL.PAIR_KEY).setValue(pairKey);
    sheet.getRange(rowIndex, PCOL.PAIR_KEY_HASH).setValue(pairKeyHash);

    syncAnalyticsForBothUsers({
      userAHash: row.userAHash,
      userBHash: viewerHash,
      status: 'active',
      confirmedAt: now,
      endedAt: ''
    });

    return jsonResponse({
      ok: true,
      partnerHash: row.userAHash,
      partnerDisplayName: row.userADisplayName,
      pairKey: pairKey
    });
  } finally {
    lock.releaseLock();
  }
}


/* ------------------------------------------------------------
   action=end（交際終了・パートナー解除。secret不要）
   ------------------------------------------------------------ */
function handleEnd(body) {
  var ownerHash = body.ownerHash;
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rows = getAllRows(sheet);
    var targetIdx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].status === 'active' &&
          (rows[i].userAHash === ownerHash || rows[i].userBHash === ownerHash)) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) return jsonResponse({ ok: false, reason: 'no_active_partnership' });

    var target = rows[targetIdx];
    var rowIndex = DATA_START_ROW + targetIdx;
    var now = new Date();

    sheet.getRange(rowIndex, PCOL.STATUS).setValue('ended');
    sheet.getRange(rowIndex, PCOL.ENDED_AT).setValue(now);
    sheet.getRange(rowIndex, PCOL.ENDED_BY).setValue(ownerHash);
    sheet.getRange(rowIndex, PCOL.UPDATED_AT).setValue(now);

    syncAnalyticsForBothUsers({
      userAHash: target.userAHash,
      userBHash: target.userBHash,
      status: 'ended',
      confirmedAt: target.confirmedAt,
      endedAt: now
    });

    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}


/* ------------------------------------------------------------
   action=cancel（相手が確認する前に、招待を出した本人が取り消す。secret不要）
   ------------------------------------------------------------ */
function handleCancel(body) {
  var ownerHash = body.ownerHash;
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rows = getAllRows(sheet);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].status === 'pending' && rows[i].userAHash === ownerHash) {
        sheet.deleteRow(DATA_START_ROW + i);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ ok: false, reason: 'no_pending_invite' });
  } finally {
    lock.releaseLock();
  }
}


/* ------------------------------------------------------------
   Analytics同期（4アプリへpush）
   ・片方ずつ2回POSTする（各アプリのAnalyticsは1人1行のため）。
   ・通信失敗はログのみ。Partnersシート本体の更新は既に成功させて
     いるので、ここで失敗しても真剣交際の判定（handleStatus）自体は
     正しく機能する。Analyticsは分析用の付随情報という位置づけ。
   ------------------------------------------------------------ */
function syncAnalyticsForBothUsers(row) {
  var payloadA = {
    action: 'syncPartnerStatus', secret: INTERNAL_SECRET,
    ownerHash: row.userAHash, status: row.status,
    partnerHash: row.userBHash || '',
    startedAt: row.confirmedAt || '', endedAt: row.endedAt || ''
  };
  var payloadB = row.userBHash ? {
    action: 'syncPartnerStatus', secret: INTERNAL_SECRET,
    ownerHash: row.userBHash, status: row.status,
    partnerHash: row.userAHash || '',
    startedAt: row.confirmedAt || '', endedAt: row.endedAt || ''
  } : null;

  for (var i = 0; i < APP_ENDPOINTS.length; i++) {
    postToAppSafely(APP_ENDPOINTS[i], payloadA);
    if (payloadB) postToAppSafely(APP_ENDPOINTS[i], payloadB);
  }
}

function postToAppSafely(url, payload) {
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('syncAnalytics failed: ' + url + ' / ' + err);
  }
}


/* ------------------------------------------------------------
   ヘルパー関数
   ------------------------------------------------------------ */
function getAllRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return [];
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, PCOL.PAIR_KEY_HASH).getValues();
  return values.map(function (v) {
    return {
      id: v[PCOL.ID - 1],
      userAHash: v[PCOL.USER_A_HASH - 1],
      userBHash: v[PCOL.USER_B_HASH - 1],
      userADisplayName: v[PCOL.USER_A_DISPLAY_NAME - 1],
      userBDisplayName: v[PCOL.USER_B_DISPLAY_NAME - 1],
      status: v[PCOL.STATUS - 1],
      inviteToken: v[PCOL.INVITE_TOKEN - 1],
      createdAt: v[PCOL.CREATED_AT - 1],
      confirmedAt: v[PCOL.CONFIRMED_AT - 1],
      endedAt: v[PCOL.ENDED_AT - 1],
      endedBy: v[PCOL.ENDED_BY - 1],
      updatedAt: v[PCOL.UPDATED_AT - 1],
      pairKey: v[PCOL.PAIR_KEY - 1],
      pairKeyHash: v[PCOL.PAIR_KEY_HASH - 1]
    };
  });
}

function findRowIndexByToken(sheet, token) {
  if (!token) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, PCOL.INVITE_TOKEN).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][PCOL.INVITE_TOKEN - 1] === token) return DATA_START_ROW + i;
  }
  return null;
}

function getRowObject(sheet, rowIndex) {
  var v = sheet.getRange(rowIndex, 1, 1, PCOL.UPDATED_AT).getValues()[0];
  return {
    userAHash: v[PCOL.USER_A_HASH - 1],
    userBHash: v[PCOL.USER_B_HASH - 1],
    userADisplayName: v[PCOL.USER_A_DISPLAY_NAME - 1],
    userBDisplayName: v[PCOL.USER_B_DISPLAY_NAME - 1],
    status: v[PCOL.STATUS - 1]
  };
}
