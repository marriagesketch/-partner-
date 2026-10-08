/* ============================================================
   パートナー登録画面 – app.js
   ・リッチメニュー「パートナー登録」から開く（新規登録・確認・状態表示）
   ・招待リンク（?token=...）から開く（相手の確認画面）
   ・Partners中央API（別デプロイ）とのみ通信し、各ミニアプリの
     スプレッドシートには一切触れない。
   ============================================================ */

const LIFF_ID = "2010312230-xUsYz0UB"; // 
const PARTNERS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec"; 
const PENDING_TOKEN_KEY = "true_relationship_pending_token_v1";

function getFormBaseURL(){
  return location.origin + location.pathname;
}

/* ---- LINE UserIDのハッシュ化（生IDはサーバーに送らない。他アプリと同一方式） ---- */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) throw new Error("ID token is not available (sub claim missing)");
  return idToken.sub;
}

/* ---- LINEの表示名を、名前入力欄の初期値として使う ----
   ・画面表示のためだけにブラウザ内で読み取り、入力欄に入れるだけ。
     サーバーに送られるのは、ユーザーが確認・編集して登録ボタンを押した
     ときの入力欄の値だけ（これまでと同じ）。
   ・LINEのプロフィールを取得できない場合（LIFFのprofileスコープが
     無効など）は、これまで通り空欄のまま（プレースホルダー表示）。 */
const DISPLAY_NAME_MAX = 20; // 入力欄のmaxlengthと合わせる

async function getLineDisplayName(){
  // ① IDトークンのnameクレーム（通信不要）
  try{
    const t = liff.getDecodedIDToken();
    if(t && t.name) return String(t.name);
  }catch(_){}
  // ② なければ liff.getProfile()
  try{
    const p = await liff.getProfile();
    if(p && p.displayName) return String(p.displayName);
  }catch(e){
    console.warn("LINE表示名の取得をスキップ:", e);
  }
  return "";
}

async function prefillDisplayNames(){
  let name = (await getLineDisplayName()).trim();
  if(!name) return;
  name = Array.from(name).slice(0, DISPLAY_NAME_MAX).join("");
  ["introDisplayName", "confirmDisplayName", "restartDisplayName"].forEach(id => {
    const el = document.getElementById(id);
    // すでに入力されている値（ユーザーが先に打ち始めた場合など）は上書きしない
    if(el && !el.value) el.value = name;
  });
}

async function checkFriendship(){
  try{
    const friendship = await liff.getFriendship();
    if(!friendship.friendFlag){
      try{ await liff.requestFriendship(); }
      catch(error){ console.warn("友だち追加リクエスト失敗:", error); }
    }
  }catch(error){ console.warn("友だち確認をスキップ:", error); }
}

/* ---- Partners API呼び出し ---- */
async function apiGet(params){
  const url = PARTNERS_ENDPOINT + "?" + new URLSearchParams(params).toString();
  const res = await fetch(url);
  return res.json();
}
async function apiPost(body){
  const res = await fetch(PARTNERS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // GAS doPostの制約回避のためtext/plainで送る
    body: JSON.stringify(body)
  });
  return res.json();
}

/* ---- UIヘルパー ---- */
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}
function showError(msg){
  const b = document.getElementById("errorBanner");
  b.textContent = msg;
  b.classList.remove("hidden");
}
function clearError(){
  document.getElementById("errorBanner").classList.add("hidden");
}
function showOnly(screenId){
  ["screen-intro","screen-pending","screen-confirm","screen-active","screen-ended"]
    .forEach(id => document.getElementById(id).classList.toggle("hidden", id !== screenId));
  document.getElementById("screen-loading").classList.add("hidden");
  document.getElementById("screen-body").classList.remove("hidden");
}
function setRingsState(state){
  const el = document.getElementById("ringsWrap");
  el.className = "rings state-" + state;
}
function formatDate(v){
  if(!v) return "—";
  const d = new Date(v);
  if(isNaN(d.getTime())) return "—";
  return d.getFullYear() + "年" + (d.getMonth()+1) + "月" + d.getDate() + "日";
}

/* ---- 確認モーダル（交際終了・招待取消などの破壊的操作用） ---- */
function confirmSheet(title, body, confirmLabel){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-sheet">
        <h2>${title}</h2>
        <p>${body}</p>
        <button class="btn btn-danger-outline" id="sheetConfirmBtn">${confirmLabel}</button>
        <button class="btn btn-ghost" id="sheetCancelBtn">やめておく</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#sheetConfirmBtn").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.querySelector("#sheetCancelBtn").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.addEventListener("click", (e) => { if(e.target === overlay){ overlay.remove(); resolve(false); } });
  });
}

/* ------------------------------------------------------------
   招待メッセージ：シェアターゲットピッカー用 Flexメッセージ
   （自己開示QAの共有メッセージと同じ構成：
     ヒーロー画像＋ブランドラベル＋タイトル＋説明＋プライマリボタン）
   ・ヒーロー画像は、このページと同じフォルダに置いた
     sharetargetpicker.jpg（3:2）を自動で参照する。
     別の場所に置く場合は、下の定数を絶対URL(https)に書き換える。
   ------------------------------------------------------------ */
const SHARETARGETPICKER_IMAGE_URL = new URL("sharetargetpicker.jpg", location.href).href;

function buildInviteFlexMessage(inviterName, inviteURL){
  const title = inviterName
    ? `${inviterName}さんからパートナー登録のお誘いが届きました`
    : "パートナー登録のお誘いが届きました";

  return {
    type: "flex",
    altText: `パートナー登録 - ${title}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: SHARETARGETPICKER_IMAGE_URL,
        size: "full",
        aspectRatio: "3:2",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "パートナー登録", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: title, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから内容を確認して、パートナー登録を進めてください。", size: "sm", color: "#888888", wrap: true, margin: "md" },
          { type: "text", text: "登録が完了すると、これまで共有した自己開示などの内容は、お二人だけが閲覧できるようになります。", size: "xs", color: "#aaaaaa", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#f48ca0",
            action: { type: "uri", label: "招待を確認する", uri: inviteURL }
          }
        ]
      }
    }
  };
}

/* ---- 招待リンクを1人だけに送る（shareTargetPicker）。失敗時はテキストでのLINE共有に切り替える ---- */
async function shareInviteLink(inviteURL, inviterName){
  const ok = await confirmSheet(
    "お相手を選んで送信",
    "お相手お一人を選んで送信します。一度送信すると、そのリンクを開いた最初の方がお相手として登録されます。",
    "相手を選んで送信する"
  );
  if(!ok) return false;

  const flexMessage = buildInviteFlexMessage(inviterName, inviteURL);

  if(liff.isApiAvailable("shareTargetPicker")){
    try{
      await liff.shareTargetPicker([flexMessage], { isMultiple: false });
      return true;
    }catch(e){
      console.warn("shareTargetPicker failed, falling back to URL scheme:", e);
    }
  }

  // shareTargetPickerが使えない環境向けのフォールバック（こちらは通常のテキスト）
  const previewMsg = inviterName
    ? `${inviterName}さんからパートナー登録のお誘いが届きました。\n招待を確認する→${inviteURL}`
    : `パートナー登録のお誘いが届きました。\n招待を確認する→${inviteURL}`;
  const lineURL = `https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
  if(liff.isInClient()){ window.location.href = lineURL; } else { window.open(lineURL, "_blank"); }
  return true;
}

async function copyToClipboard(text){
  try{
    await navigator.clipboard.writeText(text);
    showToast("リンクをコピーしました");
  }catch(e){
    showToast("コピーに失敗しました");
  }
}

/* ============================================================
   状態ごとの描画
   ============================================================ */
function renderNone(){
  setRingsState("none");
  document.getElementById("pageTitle").textContent = "パートナー登録";
  showOnly("screen-intro");
}
function renderPending(inviteToken){
  setRingsState("pending");
  document.getElementById("pageTitle").textContent = "確認待ちです";
  showOnly("screen-pending");
  document.getElementById("resendBtn").onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try{
      const url = getFormBaseURL() + "?token=" + encodeURIComponent(inviteToken);
      // 画面を開き直した場合でも、登録時に入力した名前をメッセージに入れられるよう、
      // サーバー（inviteInfo）から招待者名を取り直す
      let inviterName = "";
      try{
        const info = await apiGet({ action:"inviteInfo", token: inviteToken });
        if(info.ok) inviterName = info.inviterDisplayName || "";
      }catch(e){
        console.warn("inviteInfo fetch failed (名前なしで送信します):", e);
      }
      await shareInviteLink(url, inviterName);
    }finally{
      btn.disabled = false;
    }
  };
  document.getElementById("copyPendingBtn").onclick = () => {
    copyToClipboard(getFormBaseURL() + "?token=" + encodeURIComponent(inviteToken));
  };
  document.getElementById("cancelPendingBtn").onclick = async () => {
    const ok = await confirmSheet("招待を取り消しますか？", "発行済みの招待リンクは無効になります。この操作は取り消せません。", "招待を取り消す");
    if(!ok) return;
    const ownerHash = await sha256Hex(getLineUserId());
    const result = await apiPost({ action:"cancel", ownerHash });
    if(result.ok){ showToast("招待を取り消しました"); renderNone(); }
    else{ showError("取り消しに失敗しました。時間をおいて再度お試しください。"); }
  };
}
function renderActive(partnerDisplayName, startedAt){
  setRingsState("active");
  document.getElementById("pageTitle").textContent = "交際中";
  document.getElementById("activePartnerName").textContent = partnerDisplayName || "（お相手）";
  document.getElementById("activeStartedAt").textContent = formatDate(startedAt);
  showOnly("screen-active");
  document.getElementById("endBtn").onclick = async () => {
    const ok = await confirmSheet(
      "交際を終了しますか？",
      "終了すると、お相手はこれまでの共有内容を閲覧できなくなります。新しいお相手を登録するまで、あなたの共有内容は本人以外誰も見られない状態になります。この操作は取り消せません。",
      "交際を終了する"
    );
    if(!ok) return;
    const ownerHash = await sha256Hex(getLineUserId());
    const result = await apiPost({ action:"end", ownerHash });
    if(result.ok){ showToast("交際を終了しました"); loadStatus(); }
    else{ showError("処理に失敗しました。時間をおいて再度お試しください。"); }
  };
}
function renderEnded(partnerDisplayName){
  setRingsState("ended");
  document.getElementById("pageTitle").textContent = "パートナー登録";
  document.getElementById("endedPartnerName").textContent = partnerDisplayName || "—";
  showOnly("screen-ended");
  bindStartHandler("restartBtn", "restartDisplayName");
}

function bindStartHandler(buttonId, inputId){
  document.getElementById(buttonId).onclick = async (ev) => {
    const btn = ev.currentTarget;
    clearError();
    btn.disabled = true;
    try{
      const displayName = document.getElementById(inputId).value.trim();
      const ownerHash = await sha256Hex(getLineUserId());
      const result = await apiPost({ action:"start", ownerHash, displayName });
      if(!result.ok){
        showError(reasonToMessage(result.reason));
        return;
      }
      const url = getFormBaseURL() + "?token=" + encodeURIComponent(result.inviteToken);
      await shareInviteLink(url, displayName);
      renderPending(result.inviteToken);
    }catch(e){
      console.error(e);
      showError("通信に失敗しました。時間をおいて再度お試しください。");
    }finally{
      btn.disabled = false;
    }
  };
}

function reasonToMessage(reason){
  switch(reason){
    case "already_active":  return "すでにパートナーが登録されています。";
    case "already_pending": return "すでに招待を送信済みです。相手の確認をお待ちください。";
    case "cannot_partner_self": return "自分自身を相手として登録することはできません。";
    case "invalid_or_expired_token": return "この招待リンクは無効か、有効期限が切れています。";
    case "no_active_partnership": return "現在、交際中のお相手が登録されていません。";
    case "no_pending_invite": return "取り消せる招待が見つかりませんでした。";
    default: return "処理に失敗しました。時間をおいて再度お試しください。";
  }
}

/* ============================================================
   招待リンクを開いた側（相手）の確認フロー
   ============================================================ */
async function renderConfirmScreen(inviteToken){
  setRingsState("pending");
  document.getElementById("pageTitle").textContent = "パートナー登録のお誘い";
  showOnly("screen-confirm");

  const info = await apiGet({ action:"inviteInfo", token: inviteToken });
  const fromText = document.getElementById("inviteFromText");
  if(info.ok){
    fromText.innerHTML = info.inviterDisplayName
      ? `<span class="name-highlight">${escapeHTML(info.inviterDisplayName)}</span>さんから、パートナー登録のお誘いが届いています。`
      : "パートナー登録のお誘いが届いています。";
  }else{
    showError(reasonToMessage(info.reason));
    fromText.textContent = "";
  }

  document.getElementById("confirmBtn").onclick = async (ev) => {
    const btn = ev.currentTarget;
    clearError();
    btn.disabled = true;
    try{
      const displayName = document.getElementById("confirmDisplayName").value.trim();
      const viewerHash = await sha256Hex(getLineUserId());
      const result = await apiPost({ action:"confirm", inviteToken, viewerHash, displayName });
      if(!result.ok){
        showError(reasonToMessage(result.reason));
        return;
      }
      try{ sessionStorage.removeItem(PENDING_TOKEN_KEY); }catch(_){}
      showToast("パートナーを登録しました");
      renderActive(result.partnerDisplayName, new Date().toISOString());
    }catch(e){
      console.error(e);
      showError("通信に失敗しました。時間をおいて再度お試しください。");
    }finally{
      btn.disabled = false;
    }
  };
}

function escapeHTML(str){
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ============================================================
   自分の現在の状態を取得して描画（通常のリッチメニュー導線） 
   ============================================================ */
/* myStatusの取得。LINEアプリ内ブラウザでは、ページ読み込み直後の
   自動fetchがまれに一度だけ失敗することがあるため、1回だけ間を
   おいてリトライする（ユーザー操作起点の通信では起きにくいため）。 */
async function fetchMyStatusWithRetry(ownerHash){
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const result = await apiGet({ action:"myStatus", ownerHash });
      if(result.ok) return result;
      console.warn("myStatus not ok (attempt " + attempt + "). reason:", result.reason);
    }catch(e){
      console.warn("myStatus fetch failed (attempt " + attempt + ")", e);
    }
    if(attempt === 0) await new Promise(r => setTimeout(r, 800));
  }
  return { ok:false, reason:"network_error" };
}

async function loadStatus(){
  const ownerHash = await sha256Hex(getLineUserId());
  const result = await fetchMyStatusWithRetry(ownerHash);
  if(!result.ok){
    console.error("myStatus failed after retry. reason:", result.reason);
    // 実際の操作（登録・確認・終了）はPOSTで別途成功するため、
    // ここは致命的エラー扱いにせず、未登録画面を出して控えめに知らせるだけにする
    renderNone();
    bindStartHandler("startBtn", "introDisplayName");
    showToast("最新の状態を確認できませんでした。そのままご利用いただけます。");
    return;
  }
  if(result.status === "active"){
    renderActive(result.partnerDisplayName, result.startedAt);
  }else if(result.status === "pending_sent"){
    renderPending(result.inviteToken);
  }else if(result.status === "ended"){
    renderEnded(result.partnerDisplayName);
  }else{
    renderNone();
    bindStartHandler("startBtn", "introDisplayName");
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async () => {
  const params = new URLSearchParams(location.search);
  let inviteToken = params.get("token");

  // liff.init/loginのリダイレクトでクエリが失われる場合に備え、一時保存する
  let pendingToken = null;
  try{ pendingToken = sessionStorage.getItem(PENDING_TOKEN_KEY); }catch(_){}
  if(inviteToken){
    try{ sessionStorage.setItem(PENDING_TOKEN_KEY, inviteToken); }catch(_){}
  }else if(pendingToken){
    inviteToken = pendingToken;
  }

  try{ await liff.init({ liffId: LIFF_ID }); }
  catch(e){
    console.error("LIFF init failed", e);
    document.getElementById("screen-loading").classList.add("hidden");
    showError("LIFFの初期化に失敗しました。");
    document.getElementById("screen-body").classList.remove("hidden");
    return;
  }
  if(!liff.isLoggedIn()){ liff.login(); return; }

  await checkFriendship();

  // 名前入力欄（登録・承認・再登録の3か所）にLINEの表示名を初期入力する。
  // 画面の表示を待たせないよう await せずに実行し、入力欄が空のときだけ埋める。
  prefillDisplayNames();

  if(inviteToken){
    await renderConfirmScreen(inviteToken);
    return;
  }

  await loadStatus();
})();
