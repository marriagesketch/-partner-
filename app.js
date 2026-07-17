/* ============================================================
   真剣交際登録画面 – app.js
   ・リッチメニュー「真剣交際」から開く（新規登録・確認・状態表示）
   ・招待リンク（?token=...）から開く（相手の確認画面）
   ・Partners中央API（別デプロイ）とのみ通信し、各ミニアプリの
     スプレッドシートには一切触れない。
   ============================================================ */

const LIFF_ID = "2010312230-xUsYz0UB"; // 
const PARTNERS_ENDPOINT = "https://script.google.com/macros/s/AKfycbw589kkA1HuCQBDu6giyS8TMeeZDj_EDWFUFBHpXnHvbdiymyedFq3kJZEoB9dpnPFWoA/exec"; 
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

/* ---- 招待リンクを1人だけに送る（shareTargetPicker）。失敗時はコピーに誘導 ---- */
async function shareInviteLink(inviteURL){
  const ok = await confirmSheet(
    "お相手を選んで送信",
    "真剣交際のお相手お一人を選んで送信します。一度送信すると、そのリンクを開いた最初の方がお相手として登録されます。",
    "相手を選んで送信する"
  );
  if(!ok) return false;

  const previewMsg = `真剣交際のお誘いが届きました。\n${inviteURL}`;
  if(liff.isApiAvailable("shareTargetPicker")){
    try{
      await liff.shareTargetPicker([{ type:"text", text: previewMsg }], { isMultiple: false });
      return true;
    }catch(e){
      console.warn("shareTargetPicker failed:", e);
    }
  }
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
  document.getElementById("pageTitle").textContent = "真剣交際の登録";
  showOnly("screen-intro");
}
function renderPending(inviteToken){
  setRingsState("pending");
  document.getElementById("pageTitle").textContent = "確認待ちです";
  showOnly("screen-pending");
  document.getElementById("resendBtn").onclick = async () => {
    const url = getFormBaseURL() + "?token=" + encodeURIComponent(inviteToken);
    await shareInviteLink(url);
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
  document.getElementById("pageTitle").textContent = "真剣交際中";
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
  document.getElementById("pageTitle").textContent = "真剣交際の登録";
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
      await shareInviteLink(url);
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
    case "already_active":  return "すでに真剣交際が登録されています。";
    case "already_pending": return "すでに招待を送信済みです。相手の確認をお待ちください。";
    case "cannot_partner_self": return "自分自身を相手として登録することはできません。";
    case "invalid_or_expired_token": return "この招待リンクは無効か、有効期限が切れています。";
    case "no_active_partnership": return "現在、真剣交際中のお相手が登録されていません。";
    case "no_pending_invite": return "取り消せる招待が見つかりませんでした。";
    default: return "処理に失敗しました。時間をおいて再度お試しください。";
  }
}

/* ============================================================
   招待リンクを開いた側（相手）の確認フロー
   ============================================================ */
async function renderConfirmScreen(inviteToken){
  setRingsState("pending");
  document.getElementById("pageTitle").textContent = "真剣交際のお誘い";
  showOnly("screen-confirm");

  const info = await apiGet({ action:"inviteInfo", token: inviteToken });
  const fromText = document.getElementById("inviteFromText");
  if(info.ok){
    fromText.innerHTML = info.inviterDisplayName
      ? `<span class="name-highlight">${escapeHTML(info.inviterDisplayName)}</span>さんから、真剣交際のお誘いが届いています。`
      : "真剣交際のお誘いが届いています。";
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
      showToast("真剣交際を登録しました");
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
async function loadStatus(){
  const ownerHash = await sha256Hex(getLineUserId());
  const result = await apiGet({ action:"myStatus", ownerHash });
  if(!result.ok){
    showError("状態の取得に失敗しました。時間をおいて再度お試しください。");
    renderNone();
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

  if(inviteToken){
    await renderConfirmScreen(inviteToken);
    return;
  }

  await loadStatus();
})();
