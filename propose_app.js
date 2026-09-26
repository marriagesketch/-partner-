/* ============================================================
   プロポーズプラン – app.js（暗号キー方式）
   ------------------------------------------------------------
   ・真剣交際登録時にPartners側で発行される「暗号キー」を入力して
     使う。共有リンク・shareTargetPickerは使わない。
   ・暗号キーの生データはサーバーに一切送らない。
     - sha256Hex("lookup:" + 暗号キー) … Partnersでの検証に使うハッシュ
     - sha256("cipher:" + 暗号キー)   … 回答の暗号化に使うAES鍵の材料
     いずれも一方向ハッシュのため、ハッシュ値からは暗号キー自体も
     もう一方の値も導出できない。
   ・「入力完了」を押すまでは相手はこちらの回答を見られない。
   ============================================================ */

const LIFF_ID   = "2010606389-v29ZSV0f"; // ※ 婚活すり合わせと別アプリとして登録する場合は差し替えてください
const DRAFT_KEY = "proposal_plan_draft_v1";
const PAIR_KEY_STORAGE = "proposal_plan_pair_key_v1";

// ▼▼▼ デプロイ済みGAS Web AppのURL ▼▼▼
const GAS_ENDPOINT = "https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec";

/* ============================================================
   Base64URL 変換ユーティリティ（暗号文の符号化に使用）
   ============================================================ */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = padded.length % 4;
  const fixed  = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(fixed);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ============================================================
   SHA-256ハッシュ
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   暗号キーからの派生値
   ・lookupHash … Partnersでの検証、Answers/Analyticsシートでの
     行の特定に使う（生の暗号キーを一切含まない）
   ・aesKey     … 回答の暗号化・復号に使う（サーバーには一切送らない）
   同じ生の暗号キーから導出しても、prefixが違うため異なる値になる。
   ============================================================ */
async function deriveLookupHash(pairKey) {
  return sha256Hex("lookup:" + pairKey);
}
async function deriveAesKey(pairKey) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cipher:" + pairKey));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   ============================================================ */
async function encryptJSON(obj, key) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return bufToBase64Url(combined.buffer);
}
async function decryptJSON(base64, key) {
  const combined = new Uint8Array(base64UrlToBuf(base64));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* ------------------------------------------------------------
   LINEユーザーIDの取得
   ------------------------------------------------------------ */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) {
    throw new Error("ID token is not available (sub claim missing)");
  }
  return idToken.sub;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ============================================================
   ラジオ・チェックボックスのvalue→表示テキスト変換マップ
   ============================================================ */
const RADIO_LABELS = {
  /* Q1-2 */ "a1_2-1":"事前にお店に一緒に行って婚約指輪を選びたい",
             "a1_2-2":"プロポーズの時はプロポーズリングをもらって、後から一緒に婚約指輪を選びたい",
             "a1_2-3":"婚約指輪の希望はある程度伝えた上で、お店で決めるのは相手に任せる",
             "a1_2-4":"その他",
  /* Q2   */ "a2-1":"レストラン",
             "a2-2":"ホテルの客室",
             "a2-3":"同棲している家もしくはどちらかの自宅",
             "a2-4":"どこでもいい",
             "a2-5":"思い出の場所、その他",
  /* Q3   */ "a3-1":"記念日",
             "a3-2":"誕生日",
             "a3-3":"クリスマス",
             "a3-4":"バレンタイン",
             "a3-5":"その他",
};
const CHECKBOX_LABELS = {
  /* Q1-1 */ "a1_1-1":"指輪",
             "a1_1-2":"花束",
             "a1_1-3":"手紙",
             "a1_1-4":"特にほしいものはない",
             "a1_1-5":"その他",
};
const OTHER_VALUE = { q1_1: "a1_1-5", q1_2: "a1_2-4", q2: "a2-5", q3: "a3-5" };

/* ============================================================
   チェックボックス・ラジオ収集ヘルパー
   ============================================================ */
function getChecked(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`))
    .map(el => el.value || el.closest("label").textContent.trim());
}
function getRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? (el.value || el.closest("label").textContent.trim()) : "";
}
function toggleDetail(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = show ? "block" : "none";
  if (!show) el.value = "";
}
function updateQ1_2Visibility() {
  const ringChecked = document.querySelector('input[name="q1_1"][value="a1_1-1"]').checked;
  const group = document.getElementById("q1_2_group");
  if (!group) return;
  group.style.display = ringChecked ? "block" : "none";
  if (!ringChecked) {
    document.querySelectorAll('input[name="q1_2"]').forEach(el => (el.checked = false));
    toggleDetail("q1_2_other", false);
  }
}

/* ============================================================
   フォーム値の収集・復元・検証
   ============================================================ */
function collectFormData() {
  return {
    q1_1:       getChecked("q1_1"),
    q1_1_other: document.getElementById("q1_1_other").value,
    q1_2:       getRadio("q1_2"),
    q1_2_other: document.getElementById("q1_2_other").value,
    q2:         getRadio("q2"),
    q2_other:   document.getElementById("q2_other").value,
    q3:         getRadio("q3"),
    q3_other:   document.getElementById("q3_other").value,
    q4:         document.getElementById("q4").value,
    q5:         document.getElementById("q5").value,
  };
}

function restoreFormData(data) {
  if (!data) return;
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  };
  const setRadio = (name, val) => {
    if (!val) return;
    let r = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (!r) {
      document.querySelectorAll(`input[name="${name}"]`).forEach(el => {
        if ((el.closest("label") || {}).textContent &&
            el.closest("label").textContent.trim() === val) r = el;
      });
    }
    if (r) r.checked = true;
  };
  const setCheckboxes = (name, vals) => {
    if (!Array.isArray(vals)) return;
    document.querySelectorAll(`input[name="${name}"]`).forEach(el => {
      const label = el.closest("label");
      const text  = label ? label.textContent.trim() : "";
      if (vals.includes(el.value) || vals.includes(text)) el.checked = true;
    });
  };

  setCheckboxes("q1_1", data.q1_1);
  setText("q1_1_other", data.q1_1_other);
  setRadio("q1_2", data.q1_2);
  setText("q1_2_other", data.q1_2_other);
  setRadio("q2", data.q2);
  setText("q2_other", data.q2_other);
  setRadio("q3", data.q3);
  setText("q3_other", data.q3_other);
  setText("q4", data.q4);
  setText("q5", data.q5);

  toggleDetail("q1_1_other", getChecked("q1_1").includes(OTHER_VALUE.q1_1));
  toggleDetail("q2_other", getRadio("q2") === OTHER_VALUE.q2);
  toggleDetail("q3_other", getRadio("q3") === OTHER_VALUE.q3);
  updateQ1_2Visibility();
  toggleDetail("q1_2_other", getRadio("q1_2") === OTHER_VALUE.q1_2);
}

function clearFormFields() {
  ["q1_1_other", "q1_2_other", "q2_other", "q3_other", "q4", "q5"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    .forEach(el => (el.checked = false));
  ["q1_1_other", "q1_2_other", "q2_other", "q3_other"]
    .forEach(id => toggleDetail(id, false));
  updateQ1_2Visibility();
}

function validate(data) {
  const errors = [];
  if (!data.q1_1 || data.q1_1.length === 0)
    errors.push("Q1-1: プロポーズの時にほしいものを選択してください。");
  if (data.q1_1 && data.q1_1.includes(OTHER_VALUE.q1_1) && !data.q1_1_other.trim())
    errors.push("Q1-1: 「その他」の内容を入力してください。");
  if (data.q1_1 && data.q1_1.includes("a1_1-1") && !data.q1_2)
    errors.push("Q1-2: 指輪の準備について選択してください。");
  if (data.q1_2 === OTHER_VALUE.q1_2 && !data.q1_2_other.trim())
    errors.push("Q1-2: 「その他」の内容を入力してください。");
  if (!data.q2)
    errors.push("Q2: プロポーズ場所の希望を選択してください。");
  if (data.q2 === OTHER_VALUE.q2 && !data.q2_other.trim())
    errors.push("Q2: 「思い出の場所、その他」の内容を入力してください。");
  if (data.q3 === OTHER_VALUE.q3 && !data.q3_other.trim())
    errors.push("Q3: 「その他」の内容を入力してください。");
  return errors;
}

function buildAnalyticsPayload(data) {
  const lbl = (val) => (val ? (RADIO_LABELS[val] || val) : "");
  const chkText = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr.map(v => CHECKBOX_LABELS[v] || v).join("、")
    : "";
  return {
    q1_1: chkText(data.q1_1),
    q1_1_other: data.q1_1_other || "",
    q1_2: lbl(data.q1_2),
    q1_2_other: data.q1_2_other || "",
    q2: lbl(data.q2),
    q2_other: data.q2_other || "",
    q3: lbl(data.q3),
    q3_other: data.q3_other || "",
    q4: data.q4 || "",
    q5: data.q5 || "",
  };
}

/* ============================================================
   回答の読み取り表示（自分の回答／相手の回答の共通レンダラ）
   ============================================================ */
function renderAnswerRows(data) {
  const r = (val) => (val && String(val).trim()) ? val : "未回答";
  const lblWithOther = (val, other, otherVal) => {
    if (!val) return "未回答";
    const text = RADIO_LABELS[val] || val;
    if (val === otherVal && other && other.trim()) return `${text}：${other.trim()}`;
    return text;
  };
  const chkListHTML = (arr, other) => {
    if (!Array.isArray(arr) || arr.length === 0) return "未回答";
    return arr.map(v => {
      const text = CHECKBOX_LABELS[v] || v;
      if (v === OTHER_VALUE.q1_1 && other && other.trim()) return `・${escapeHTML(text)}：${escapeHTML(other.trim())}`;
      return `・${escapeHTML(text)}`;
    }).join("<br>");
  };

  const rows = [
    { q: "Q1-1 プロポーズの時にほしいものはありますか？", html: chkListHTML(data.q1_1, data.q1_1_other) },
    { q: "Q1-2 プロポーズのときに指輪がほしいと答えた方、事前に一緒に見に行きたいですか？",
      a: (Array.isArray(data.q1_1) && data.q1_1.includes("a1_1-1"))
        ? lblWithOther(data.q1_2, data.q1_2_other, OTHER_VALUE.q1_2)
        : "（指輪を選択していないため対象外）" },
    { q: "Q2 プロポーズ場所の希望はありますか？", a: lblWithOther(data.q2, data.q2_other, OTHER_VALUE.q2) },
    { q: "Q3 プロポーズの日程にこだわりがあれば教えてください。", a: lblWithOther(data.q3, data.q3_other, OTHER_VALUE.q3) },
    { q: "Q4 プロポーズについて、これだけは嫌というものがあれば教えてください。", a: r(data.q4) },
    { q: "Q5 上記の他に理想のプロポーズはありますか？", a: r(data.q5) },
  ];

  return rows.map(({ q, a, html }) => `
    <div class="view-item">
      <p class="view-question">${escapeHTML(q)}</p>
      <p class="view-answer">${html !== undefined ? html : escapeHTML(a).replace(/\n/g, "<br>")}</p>
    </div>
  `).join("");
}

/* ============================================================
   フォーム要素の表示・非表示
   ============================================================ */
function setFormVisible(visible) {
  document.querySelectorAll(
    ".container > label, .container > input, .container > textarea, " +
    ".container > #q1_2_group, .container > div.button-group"
  ).forEach(el => (el.style.display = visible ? "" : "none"));
}

function getOrCreateContainer(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.querySelector(".container").prepend(el);
  }
  return el;
}

/* ============================================================
   状態表示（鍵検証中・エラーなど）
   ============================================================ */
function showStateCard(title, text, isLoading = false) {
  setFormVisible(false);
  const container = getOrCreateContainer("viewMode");
  container.style.display = "block";
  container.innerHTML = `
    <div class="view-header state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>
      ` : ""}
      <p class="view-label">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>
  `;
}
function hideStateCard() {
  const el = document.getElementById("viewMode");
  if (el) { el.style.display = "none"; el.innerHTML = ""; }
  const partnerRequired = document.getElementById("partnerRequired");
  if (partnerRequired) partnerRequired.style.display = "none";
}

/* ============================================================
   暗号キー入力ゲート
   ============================================================ */
function pairKeyReasonToMessage(reason) {
  switch (reason) {
    case "invalid_key":   return "この暗号キーが見つかりません。入力内容をご確認ください。";
    case "partner_ended": return "パートナーが解除されているため、この暗号キーは使用できません。最新の暗号キーはパートナー登録画面でご確認ください。";
    case "not_a_party":   return "このキーは、あなたとお相手の組み合わせのものではないようです。";
    default:              return "暗号キーの確認に失敗しました。時間をおいて再度お試しください。";
  }
}

function showKeyGate(prefill, errorMessage) {
  setFormVisible(false);
  const container = getOrCreateContainer("viewMode");
  container.style.display = "block";
  container.innerHTML = `
    <div class="view-header" style="text-align:left;">
      <p class="view-label" style="text-align:center;">暗号キーの入力</p>
      <p class="state-text" style="margin-top:8px;">
        プロポーズプランは、真剣交際のお相手との暗号キーで開きます。<br>
        暗号キーは、パートナー登録画面（真剣交際中の画面）で確認できます。
      </p>
      ${errorMessage ? `<p class="state-text" style="color:#c0392b; margin-top:10px;">${escapeHTML(errorMessage)}</p>` : ""}
      <input type="text" id="pairKeyInput" placeholder="例）AB3D-K9QZ-..." value="${escapeHTML(prefill || "")}"
        style="width:100%; margin-top:14px; padding:14px; border:1px solid #f0c5cc; border-radius:12px; font-size:15px; text-align:center; letter-spacing:.05em;">
      <button type="button" id="pairKeySubmitBtn" style="width:100%; margin-top:14px; padding:16px; border:none; border-radius:14px; background:#f48ca0; color:#fff; font-size:16px; font-weight:700; cursor:pointer;">
        回答画面を開く
      </button>
    </div>
  `;

  // パートナー未登録の方向けの案内（既存のCTAカードは元の位置のまま、表示だけ切り替える）
  const partnerRequired = document.getElementById("partnerRequired");
  if (partnerRequired) {
    partnerRequired.style.display = "block";
  }

  document.getElementById("pairKeySubmitBtn").addEventListener("click", onPairKeySubmit);
  document.getElementById("pairKeyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onPairKeySubmit();
  });
}

async function onPairKeySubmit() {
  const btn = document.getElementById("pairKeySubmitBtn");
  const input = document.getElementById("pairKeyInput");
  const pairKey = (input.value || "").trim();
  if (!pairKey) return;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "確認中…";

  try {
    const ownerHash = await sha256Hex(getLineUserId());
    const lookupHash = await deriveLookupHash(pairKey);

    const url = `${GAS_ENDPOINT}?action=fetchPair&pairKeyHash=${encodeURIComponent(lookupHash)}&ownerHash=${encodeURIComponent(ownerHash)}`;
    const resp = await fetch(url, { method: "GET" });
    const result = await resp.json();

    if (!result.ok) {
      showKeyGate(pairKey, pairKeyReasonToMessage(result.reason));
      return;
    }

    try { localStorage.setItem(PAIR_KEY_STORAGE, pairKey); } catch (_) {}
    await enterAnswerScreen(pairKey, lookupHash, ownerHash, result);
  } catch (e) {
    console.error("pair key validation error", e);
    showKeyGate(pairKey, "通信に失敗しました。通信環境を確認してもう一度お試しください。");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

/* ============================================================
   回答画面（キー検証済み）の状態管理
   ============================================================ */
const AppState = { pairKey: null, lookupHash: null, ownerHash: null };

async function enterAnswerScreen(pairKey, lookupHash, ownerHash, fetchResult) {
  AppState.pairKey = pairKey;
  AppState.lookupHash = lookupHash;
  AppState.ownerHash = ownerHash;
  hideStateCard();
  await renderAnswerScreen(fetchResult);
}

async function refetchPair() {
  const url = `${GAS_ENDPOINT}?action=fetchPair&pairKeyHash=${encodeURIComponent(AppState.lookupHash)}&ownerHash=${encodeURIComponent(AppState.ownerHash)}`;
  const resp = await fetch(url, { method: "GET" });
  const result = await resp.json();
  if (!result.ok) {
    // 取得中に交際終了などでキーが無効になった場合はゲートに戻す
    showKeyGate(AppState.pairKey, pairKeyReasonToMessage(result.reason));
    return null;
  }
  return result;
}

/* fetchResult: { own: {cipherText, completed, updatedAt} | null, partner: {completed, cipherText?, updatedAt?} } */
async function renderAnswerScreen(fetchResult) {
  const aesKey = await deriveAesKey(AppState.pairKey);
  const ownCompleted = !!(fetchResult.own && fetchResult.own.completed);

  if (ownCompleted) {
    let ownData = null;
    try { ownData = await decryptJSON(fetchResult.own.cipherText, aesKey); }
    catch (e) {
      console.error("decrypt own answer failed", e);
      showStateCard("復号に失敗しました", "暗号キーが正しくない可能性があります。パートナー登録画面で最新の暗号キーをご確認ください。");
      return;
    }
    renderCompletedView(ownData, fetchResult.partner, aesKey);
  } else {
    // まだ入力完了していない → 編集可能なフォームを表示（下書きがあれば復元）
    setFormVisible(true);
    hideStateCard();
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) restoreFormData(JSON.parse(saved));
    } catch (_) {}
    renderStatusBanner(false, fetchResult.partner);
    wireSubmitButton(aesKey);
  }
}

function renderStatusBanner(ownCompleted, partner) {
  const container = getOrCreateContainer("statusBanner");
  container.style.display = "block";
  container.innerHTML = `
    <div class="view-header" style="text-align:left; padding:16px 20px;">
      <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:700;">
        <span style="color:${ownCompleted ? "#2e9e5b" : "#d96c7d"}">あなた：${ownCompleted ? "入力完了" : "未入力"}</span>
        <span style="color:${partner && partner.completed ? "#2e9e5b" : "#999"}">お相手：${partner && partner.completed ? "入力完了" : "未入力"}</span>
      </div>
    </div>
  `;
}

function wireSubmitButton(aesKey) {
  const submitBtn = document.getElementById("submitBtn");
  if (!submitBtn) return;
  submitBtn.textContent = "入力完了にする";
  submitBtn.onclick = async () => {
    const data = collectFormData();
    const errors = validate(data);
    if (errors.length > 0) {
      alert("以下の項目を入力・選択してください。\n\n" + errors.join("\n"));
      return;
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (_) {}

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "送信中…";
    try {
      await submitAnswer(data, true, aesKey);
      const result = await refetchPair();
      if (result) await renderAnswerScreen(result);
    } catch (e) {
      console.error("submit error", e);
      alert("送信に失敗しました。通信環境を確認してもう一度お試しください。");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  };
}

async function submitAnswer(data, completed, aesKey) {
  const cipherText = await encryptJSON(data, aesKey);
  const analytics  = buildAnalyticsPayload(data);
  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "submit",
      pairKeyHash: AppState.lookupHash,
      ownerHash: AppState.ownerHash,
      cipherText, completed, analytics
    }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "submit_failed");
  return result;
}

/* ============================================================
   入力完了後のビュー：自分の回答（読み取り専用）＋相手の回答
   ============================================================ */
function renderCompletedView(ownData, partner, aesKey) {
  setFormVisible(false);
  const statusEl = document.getElementById("statusBanner");
  if (statusEl) statusEl.remove();

  const container = getOrCreateContainer("viewMode");
  container.style.display = "block";

  (async () => {
    let partnerHTML = `
      <div class="cta-card" style="border-style:dashed;">
        <div class="cta-content" style="text-align:center;">
          <p class="cta-text" style="margin:0;">お相手はまだ入力中です。入力が完了すると、ここに回答が表示されます。</p>
        </div>
      </div>
    `;
    if (partner && partner.completed) {
      try {
        const partnerData = await decryptJSON(partner.cipherText, aesKey);
        partnerHTML = `
          <div class="view-header"><p class="view-label">お相手の回答</p></div>
          ${renderAnswerRows(partnerData)}
        `;
      } catch (e) {
        console.error("decrypt partner answer failed", e);
        partnerHTML = `<div class="view-header state-card"><p class="state-text">お相手の回答の復号に失敗しました。</p></div>`;
      }
    }

    container.innerHTML = `
      <div class="view-header">
        <p class="view-label">あなたの回答（入力完了）</p>
      </div>
      ${renderAnswerRows(ownData)}
      <div style="margin:20px 0;">
        <button type="button" id="editAnswerBtn" style="width:100%; padding:14px; border-radius:12px; background:#fff; color:#d96c7d; border:2px solid #f0c5cc; font-size:15px; font-weight:600; cursor:pointer;">
          回答を編集する
        </button>
        <button type="button" id="refreshPairBtn" style="width:100%; margin-top:10px; padding:12px; border-radius:12px; background:#fafafa; color:#888; border:1px solid #ddd; font-size:14px; cursor:pointer;">
          お相手の状況を更新する
        </button>
      </div>
      <div style="margin:28px 0 12px; border-top:1px dashed #f0c5cc;"></div>
      ${partnerHTML}
    `;

    document.getElementById("editAnswerBtn").addEventListener("click", async () => {
      if (!confirm("回答を編集すると「未入力」の状態に戻り、編集が終わって再度「入力完了」を押すまでお相手には見えなくなります。編集しますか？")) return;
      try {
        await submitAnswer(ownData, false, aesKey);
      } catch (e) {
        console.error("revert to incomplete failed", e);
        alert("処理に失敗しました。通信環境を確認してもう一度お試しください。");
        return;
      }
      hideStateCard();
      setFormVisible(true);
      restoreFormData(ownData);
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(ownData)); } catch (_) {}
      renderStatusBanner(false, partner);
      wireSubmitButton(aesKey);
    });

    document.getElementById("refreshPairBtn").addEventListener("click", async () => {
      const result = await refetchPair();
      if (result) await renderAnswerScreen(result);
    });
  })();
}

/* ============================================================
   友だち追加チェック
   ============================================================ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try { await liff.requestFriendship(); }
      catch (error) { console.warn("友だち追加リクエスト失敗:", error); }
    }
  } catch (error) {
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async () => {
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error("LIFF init failed", e);
    alert("LIFFの初期化に失敗しました。");
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  await checkFriendship();

  /* ----- 条件付き表示：自由記述欄の表示制御 ----- */
  document.querySelectorAll('input[name="q1_1"]').forEach(cb =>
    cb.addEventListener("change", () => {
      toggleDetail("q1_1_other", getChecked("q1_1").includes(OTHER_VALUE.q1_1));
      updateQ1_2Visibility();
    })
  );
  [
    { name: "q1_2", otherId: "q1_2_other", otherVal: OTHER_VALUE.q1_2 },
    { name: "q2",   otherId: "q2_other",   otherVal: OTHER_VALUE.q2 },
    { name: "q3",   otherId: "q3_other",   otherVal: OTHER_VALUE.q3 },
  ].forEach(({ name, otherId, otherVal }) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r =>
      r.addEventListener("change", () => toggleDetail(otherId, r.value === otherVal))
    );
  });
  updateQ1_2Visibility();

  /* ----- 下書き保存 ----- */
  document.getElementById("draftBtn") &&
  document.getElementById("draftBtn").addEventListener("click", () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectFormData()));
      alert("下書きを保存しました。");
    } catch (_) {
      alert("下書きの保存に失敗しました。");
    }
  });

  /* ----- フォームクリア ----- */
  document.getElementById("clearBtn") &&
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("入力内容をすべてクリアしますか？")) return;
    clearFormFields();
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  });

  /* ----- 暗号キーの入力ゲートから開始 -----
     前回入力済みの暗号キーがあれば自動入力するが、開くにはワン
     クリックの確認操作を必ず挟む（交際終了などでキーが無効になって
     いる可能性を、開くたびにサーバー側で検証するため）。 */
  let savedPairKey = "";
  try { savedPairKey = localStorage.getItem(PAIR_KEY_STORAGE) || ""; } catch (_) {}
  showKeyGate(savedPairKey, "");
})();
