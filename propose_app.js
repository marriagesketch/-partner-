/* ============================================================
   プロポーズプラン – app.js
   ------------------------------------------------------------
   共有リンクは「id（短いランダムID）＋復号鍵（URLのフラグメント）」
   のみで構成される。回答本体は暗号化されたうえで GAS 経由で
   スプレッドシートに保存され、復号鍵はサーバーに送信されない
   （URLの # 以降はブラウザからサーバーへ送信されないため）。
   ============================================================ */

const LIFF_ID   = "2010606389-v29ZSV0f"; // ※ 婚活すり合わせと別アプリとして登録する場合は差し替えてください
const DRAFT_KEY = "proposal_plan_draft_v1";

// ▼▼▼ デプロイ済みGAS Web AppのURL ▼▼▼
// ※ 婚活すり合わせと同じシートに保存すると項目がずれるため、
//   本フォーム用に別デプロイしたGAS Web AppのURLに差し替えてください。
const GAS_ENDPOINT = "https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec";

/* ============================================================
   Base64URL 変換ユーティリティ（AES鍵・暗号文の符号化に使用）
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
   SHA-256ハッシュ（LINE UserIDのハッシュ化。生IDはサーバーに送らない）
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   鍵はURLのフラグメント（#以降）にのみ含め、サーバーには渡さない。
   ============================================================ */
async function generateShareKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, base64: bufToBase64Url(raw) };
}

async function importShareKey(base64) {
  const raw = base64UrlToBuf(base64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

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
   liff.getProfile() はLINEサーバーへの追加API呼び出しが必要で、
   ログイン直後などタイミングによって不安定になりやすい。
   ログイン時に発行されるIDトークンをその場でデコードするだけなら
   通信が発生せず、ユーザーID（sub）を安定して取得できる。
   表示名・プロフィール画像は使わない設計なので、これで十分。
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

/* 「その他」を選んだときに自由記述欄が対応するラジオ/チェックボックスのvalue */
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

/* ============================================================
   詳細テキストエリアの表示・非表示
   ============================================================ */
function toggleDetail(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = show ? "block" : "none";
  if (!show) el.value = "";
}

/* ============================================================
   Q1-2 の表示制御
   Q1-1で「指輪」(a1_1-1) が選択されている場合のみ Q1-2 を表示する。
   非表示にする際は、Q1-2の回答（ラジオ・その他欄）をクリアする。
   ============================================================ */
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
   フォーム値の収集
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

/* ============================================================
   フォームへの値の復元
   ============================================================ */
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

  /* 「その他」自由記述欄の表示状態を復元内容に合わせて同期 */
  toggleDetail("q1_1_other", getChecked("q1_1").includes(OTHER_VALUE.q1_1));
  toggleDetail("q2_other", getRadio("q2") === OTHER_VALUE.q2);
  toggleDetail("q3_other", getRadio("q3") === OTHER_VALUE.q3);

  /* Q1-2 の表示・その他欄表示も復元内容に合わせて同期 */
  updateQ1_2Visibility();
  toggleDetail("q1_2_other", getRadio("q1_2") === OTHER_VALUE.q1_2);
}

/* ============================================================
   バリデーション
   ============================================================ */
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

/* ============================================================
   統計用データの抽出（Analyticsシート行）
   選択式の項目は、集計時にそのまま使えるよう選択肢の全文を入れる。
   ============================================================ */
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
   フォーム要素を隠す（ビューモード／状態表示に切り替える共通処理）
   ============================================================ */
function hideFormElements() {
  document.querySelectorAll(
    ".container > label, .container > input, .container > textarea, " +
    ".container > #q1_2_group, " +
    ".container > div.button-group, .container > div#shareModal, " +
    ".container > #submitBtn"
  ).forEach(el => (el.style.display = "none"));
}

/* ============================================================
   読み込み中／エラーなどの状態表示（共有リンクを開いたとき用）
   ============================================================ */
function showStateCard(title, text, isLoading = false) {
  hideFormElements();
  let container = document.getElementById("viewMode");
  if (!container) {
    container = document.createElement("div");
    container.id = "viewMode";
    document.querySelector(".container").prepend(container);
  }
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

/* ============================================================
   共有リンクを開いたときの処理
   ・URLの ?id=... がスプレッドシート上のレコードを指す
   ・URLの #以降 が復号鍵（サーバーには送信されない）
   ・閲覧にはLINEログインが必須（viewerHashによるアクセス制御のため）
   ============================================================ */
async function handleSharedView(id) {
  // ここに来た時点で liff.init() は完了済み（呼び出し元のメイン処理を参照）。
  showStateCard("読み込み中…", "回答内容を確認しています。少々お待ちください。", true);

  const keyBase64 = location.hash ? location.hash.slice(1) : "";
  if (!keyBase64) {
    showStateCard(
      "リンクが不完全です",
      "共有リンクが途中で切れているか、正しくコピーされていない可能性があります。共有した相手にもう一度リンクを送ってもらってください。"
    );
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  let key;
  try {
    key = await importShareKey(keyBase64);
  } catch (e) {
    console.error("key import error", e);
    showStateCard("リンクが正しくありません", "共有リンクが壊れている可能性があります。");
    return;
  }

  let viewerHash;
  try {
    const userId = getLineUserId();
    viewerHash = await sha256Hex(userId);
  } catch (e) {
    console.error("get user id error", e);
    showStateCard(
      "エラー",
      "LINEアカウント情報の確認に失敗しました。時間をおいてもう一度お試しください。" +
      "（詳細: " + (e && e.message ? e.message : String(e)) + "）"
    );
    return;
  }

  let result;
  try {
    const url = `${GAS_ENDPOINT}?action=view&id=${encodeURIComponent(id)}&viewerHash=${encodeURIComponent(viewerHash)}`;
    const resp = await fetch(url, { method: "GET" });
    result = await resp.json();
  } catch (e) {
    console.error("fetch view error", e);
    showStateCard("通信エラー", "回答内容を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return;
  }

  if (!result.ok) {
    if (result.reason === "forbidden") {
      showStateCard(
        "閲覧できません",
        "このリンクは最初に開いた方専用です。転送されたリンクは、その方以外は閲覧できない仕組みになっています。"
      );
    } else if (result.reason === "revoked" || result.reason === "expired" || result.reason === "deleted") {
      showStateCard("リンクが無効です", "このリンクはすでに無効になっています。最新の共有リンクを送ってもらってください。");
    } else if (result.reason === "not_found") {
      showStateCard("リンクが見つかりません", "このリンクは存在しないか、削除された可能性があります。");
    } else {
      showStateCard("エラー", "回答内容を取得できませんでした。時間をおいて再度お試しください。");
    }
    return;
  }

  let data;
  try {
    data = await decryptJSON(result.cipherText, key);
  } catch (e) {
    console.error("decrypt error", e);
    showStateCard("復号に失敗しました", "リンクの一部が正しくない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  renderViewMode(data);
}

/* ============================================================
   ビューモード：回答をカード表示
   ============================================================ */
function renderViewMode(data, options = {}) {
  const { selfPreview = false, onShare = null } = options;

  const r = (val) => (val && String(val).trim()) ? val : "未回答";
  const lbl = (val) => val ? (RADIO_LABELS[val] || val) : "未回答";
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
    { q: "Q1-1 プロポーズの時にほしいものはありますか？",
      html: chkListHTML(data.q1_1, data.q1_1_other) },
    { q: "Q1-2 プロポーズのときに指輪がほしいと答えた方、事前に一緒に見に行きたいですか？",
      a: (Array.isArray(data.q1_1) && data.q1_1.includes("a1_1-1"))
        ? lblWithOther(data.q1_2, data.q1_2_other, OTHER_VALUE.q1_2)
        : "（指輪を選択していないため対象外）" },
    { q: "Q2 プロポーズ場所の希望はありますか？",
      a: lblWithOther(data.q2, data.q2_other, OTHER_VALUE.q2) },
    { q: "Q3 プロポーズの日程にこだわりがあれば教えてください。",
      a: lblWithOther(data.q3, data.q3_other, OTHER_VALUE.q3) },
    { q: "Q4 プロポーズについて、これだけは嫌というものがあれば教えてください。",
      a: r(data.q4) },
    { q: "Q5 上記の他に理想のプロポーズはありますか？",
      a: r(data.q5) },
  ];

  hideFormElements();

  const formURL = location.href.split("?")[0].split("#")[0];

  const descEl = document.querySelector(".form-header .form-description");
  if (descEl) {
    descEl.innerHTML =
      "回答を共有してお互いのことを知りましょう。<br>" +
      "回答内容だけじゃなく、なぜそう思ってるのか、この場合はどう変わるかなども質問し合ってみましょう。";
  }

  /* viewMode div がなければ動的に生成 */
  let container = document.getElementById("viewMode");
  if (!container) {
    container = document.createElement("div");
    container.id = "viewMode";
    document.querySelector(".container").prepend(container);
  }
  container.style.display = "block";

  container.innerHTML = `
    ${selfPreview ? `
    <div class="cta-card share-confirm-card">
      <div class="cta-content" style="text-align:center;">
        <h3 class="cta-title">この内容を共有します</h3>
        <p class="cta-text">内容を確認したら、共有先を選んでください。</p>
        <button type="button" id="goShareBtn" class="cta-button">
          共有先を選ぶ <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : `
    <div class="view-header">
      <p class="view-label">回答内容</p>
      ${data._shareName ? `<p class="view-name">${escapeHTML(data._shareName)} さんの回答</p>` : ""}
    </div>
    `}

    ${rows.map(({ q, a, html }) => `
      <div class="view-item">
        <p class="view-question">${escapeHTML(q)}</p>
        <p class="view-answer">${html !== undefined ? html : escapeHTML(a).replace(/\n/g, "<br>")}</p>
      </div>
    `).join("")}

    ${!selfPreview ? `
    <div class="cta-card">
      <img src="shareimage.webp" class="cta-image-left" alt="">
      <div class="cta-content">
        <h3 class="cta-title">あなたの理想のプロポーズも共有してみませんか？</h3>
        <p class="cta-text">
          プロポーズ前のすり合わせは、<br>
          お互いの理想を叶える大切なきっかけになります。<br>
          あなたの考えや希望をアンケートで伝えてみましょう。
        </p>
        <button type="button" id="ctaButton" class="cta-button" data-href="${formURL}">
          私も回答する <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : ""}
  `;

  if (selfPreview) {
    const goShareBtn = document.getElementById("goShareBtn");
    if (goShareBtn && typeof onShare === "function") {
      goShareBtn.addEventListener("click", onShare);
    }
    return;
  }

  const ctaButton = document.getElementById("ctaButton");
  if (ctaButton) {
    ctaButton.addEventListener("click", () => {
      if (confirm("プロポーズプランフォームを開く")) {
        window.location.href = ctaButton.dataset.href;
      }
    });
  }
}

/* ============================================================
   共有：シェアターゲットピッカー用 Flexメッセージ
   長い共有URLはボタン(uriアクション)の中に格納するため、
   相手に見える本文には長いリンクが表示されない。
   ※ uriアクションのURLは1000文字以内という制限があるため、
     超える場合は liff.shareTargetPicker 側でエラーになり、
     呼び出し元で従来のURLスキーム方式にフォールバックする。
   ※ hero画像のURLは、LINEのサーバーから読み込める公開HTTPS URL
     である必要がある（ローカルパスや相対パスは不可）。
     画像は1MB以下を推奨。PNGの透過部分はそのまま送ると
     反映されない場合があるため、白背景に合成したJPEGを使用する。
   ============================================================ */
const HEADER_IMAGE_URL = "https://marriagesketch.github.io/-suriawase-/sharetargetpicker.jpg"; // ※ 必要に応じてプロポーズプラン用の画像に差し替えてください

function buildShareFlexMessage(shareName, shareURL) {
  const nameLine = shareName ? `${shareName}さんの回答が届きました` : "回答が届きました";

  return {
    type: "flex",
    altText: `プロポーズプラン - ${nameLine}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: HEADER_IMAGE_URL,
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
          { type: "text", text: "プロポーズプラン", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: nameLine, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから回答内容を確認できます。", size: "sm", color: "#888888", wrap: true, margin: "md" }
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
            action: { type: "uri", label: "回答をみる", uri: shareURL }
          }
        ]
      }
    }
  };
}

/* ============================================================
   共有先を選んで送信する
   1. シェアターゲットピッカーが使える場合はそちらを優先
      （Flexメッセージとして直接送信、送信後にトーク画面へ遷移しない）
   2. 使えない・失敗した場合は、従来のURLスキーム方式（送信先を
      選択画面を開いてテキストメッセージを送る）にフォールバック
   ============================================================ */
async function shareToOthers(flexMessage, fallbackLineSchemeURL) {
  if (liff.isApiAvailable("shareTargetPicker")) {
    try {
      await liff.shareTargetPicker([flexMessage], { isMultiple: true });
      return;
    } catch (e) {
      console.warn("shareTargetPicker failed, falling back to URL scheme:", e);
    }
  }

  if (liff.isInClient()) {
    window.location.href = fallbackLineSchemeURL;
  } else {
    window.open(fallbackLineSchemeURL, "_blank");
  }
}

/* ============================================================
   友だち追加チェック
   LINE公式アカウントを友だち追加済みかを確認し、未追加であれば
   友だち追加ダイアログを表示する。
   ※ LIFF初期化・ログイン済みの状態で呼び出すこと（liff.init は呼ばない）
   ============================================================ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try {
        await liff.requestFriendship();
      } catch (error) {
        console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error);
      }
    }
  } catch (error) {
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async () => {

  /* ----- LIFF 初期化（必ず最初に1回だけ実行） -----
     共有リンク判定に使うURL（?id=...#key）の読み取りは、
     必ずこの後で行う。ログインのリダイレクトを経由して
     戻ってきた直後は、URLが一時的に ?liff.state=... の形に
     なっていて ?id=... が正しく読み取れないことがあるため。
  ----- */
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error("LIFF init failed", e);
    alert("LIFFの初期化に失敗しました。");
    return;
  }

  /* ----- 共有リンク判定（?id=... が付いている場合） ----- */
  const sharedId = new URLSearchParams(location.search).get("id");
  if (sharedId) {
    await handleSharedView(sharedId);
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  /* ----- 友だち追加チェック（未追加なら追加ダイアログを表示） ----- */
  await checkFriendship();

  /* ----- 条件付き表示：自由記述欄の表示制御 ----- */
  /* Q1-1：「その他」選択時のみ自由記述欄を表示 */
  document.querySelectorAll('input[name="q1_1"]').forEach(cb =>
    cb.addEventListener("change", () => {
      toggleDetail("q1_1_other", getChecked("q1_1").includes(OTHER_VALUE.q1_1));
      /* Q1-1で「指輪」の選択状態が変わったら、Q1-2の表示も連動して切り替える */
      updateQ1_2Visibility();
    })
  );

  /* Q1-2・Q2・Q3：「その他」選択時のみ自由記述欄を表示 */
  [
    { name: "q1_2", otherId: "q1_2_other", otherVal: OTHER_VALUE.q1_2 },
    { name: "q2",   otherId: "q2_other",   otherVal: OTHER_VALUE.q2 },
    { name: "q3",   otherId: "q3_other",   otherVal: OTHER_VALUE.q3 },
  ].forEach(({ name, otherId, otherVal }) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r =>
      r.addEventListener("change", () => toggleDetail(otherId, r.value === otherVal))
    );
  });

  /* ----- 初期表示状態を同期（Q1-2はQ1-1「指輪」未選択時は非表示） ----- */
  updateQ1_2Visibility();

  /* ----- localStorage から下書き復元 ----- */
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) restoreFormData(JSON.parse(saved));
  } catch (_) {}

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

    ["q1_1_other", "q1_2_other", "q2_other", "q3_other", "q4", "q5"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });

    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .forEach(el => (el.checked = false));

    ["q1_1_other", "q1_2_other", "q2_other", "q3_other"]
      .forEach(id => toggleDetail(id, false));

    updateQ1_2Visibility();

    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  });

  /* ----- 送信ボタン ----- */
  document.getElementById("submitBtn").addEventListener("click", () => {
    const data   = collectFormData();
    const errors = validate(data);

    if (errors.length > 0) {
      alert("以下の項目を入力・選択してください。\n\n" + errors.join("\n"));
      return;
    }

    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (_) {}

    const modal = document.getElementById("shareModal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("show");
      document.getElementById("submitBtn").disabled = true;
    } else {
      handleShare(data, "").catch(e => {
        console.error("share error", e);
        alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
      });
    }
  });

  /* ----- 共有ボタン（モーダルあり） ----- */
  const shareBtn = document.getElementById("shareBtn");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      const shareName = (document.getElementById("shareName") || {}).value || "";
      const data      = collectFormData();

      shareBtn.disabled = true;
      const originalLabel = shareBtn.textContent;
      shareBtn.textContent = "送信中…";

      try {
        await handleShare(data, shareName.trim());

        const modal = document.getElementById("shareModal");
        if (modal) {
          modal.classList.remove("show");
          modal.classList.add("hidden");
        }
      } catch (e) {
        console.error("share error", e);
        alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
        document.getElementById("submitBtn").disabled = false;
      } finally {
        shareBtn.disabled = false;
        shareBtn.textContent = originalLabel;
      }
    });
  }

  /* ----- モーダル外クリックで閉じる ----- */
  const shareModal = document.getElementById("shareModal");
  if (shareModal) {
    shareModal.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove("show");
        e.currentTarget.classList.add("hidden");
        document.getElementById("submitBtn").disabled = false;
      }
    });
  }

})();

/* ============================================================
   共有処理（送信ボタン・共有ボタン共通）
   ============================================================ */
async function handleShare(data, shareName) {
  data._shareName = shareName;

  const userId    = getLineUserId();
  const ownerHash = await sha256Hex(userId);

  const id = (crypto.randomUUID ? crypto.randomUUID() : fallbackUUID());
  const { key, base64: keyBase64 } = await generateShareKey();
  const cipherText = await encryptJSON(data, key);
  const analytics  = buildAnalyticsPayload(data);

  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
    body: JSON.stringify({ action: "share", id, cipherText, ownerHash, analytics, schemaVersion: 1 }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "share_failed");

  const base     = location.href.split("?")[0].split("#")[0];
  const shareURL = `${base}?id=${id}#${keyBase64}`;

  const previewMsg = shareName
    ? `${shareName}さんのプロポーズプランの回答が届きました。\n回答をみる→${shareURL}`
    : `プロポーズプランの回答が届きました。\n回答をみる→${shareURL}`;

  const flexMessage = buildShareFlexMessage(shareName, shareURL);

  renderViewMode(data, {
    selfPreview: true,
    onShare: () => {
      // LINEの「送信先を選択」画面を開くURLスキーム（フォールバック用）
      const lineShareURL = `https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
      shareToOthers(flexMessage, lineShareURL);
    },
  });

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* crypto.randomUUID が使えない古い環境用のフォールバック */
function fallbackUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
