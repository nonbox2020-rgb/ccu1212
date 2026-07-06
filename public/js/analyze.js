/* global renderTopbar, icon, api, yen, co2fmt, esc */
"use strict";

let selectedFile = null;

const PROGRESS_STEPS = [
  "見積書を読み込んでいます…",
  "AIが明細項目を認識しています…",
  "製品データベースと照合しています…",
  "コスト・CO\u2082削減効果を計算しています…",
  "提案コメントを生成しています…",
];

(async function init() {
  await renderTopbar("analyze");
  document.getElementById("eyebrow").innerHTML = icon("spark", 12) + " AI ESTIMATE ANALYSIS";
  document.getElementById("dzIcon").innerHTML = icon("upload", 30);
  document.getElementById("footNote").innerHTML =
    icon("info", 13) +
    "<span>単価・CO\u2082排出係数は製品DBの登録値に基づきます。実運用では検証済みの排出係数を登録してください。診断結果は提案用の試算です。</span>";

  // AI readiness banner
  try {
    const s = await api("/api/settings");
    if (!s.ai_ready) {
      document.getElementById("aiWarn").innerHTML =
        `<div class="card card-pad" style="margin-bottom:20px"><div class="notice warn">${icon(
          "warn",
          16
        )}<span>AI APIキー（<code>ANTHROPIC_API_KEY</code>）が未設定です。診断を実行するには、Renderの環境変数、または設定画面で登録してください。</span></div></div>`;
    }
  } catch (e) {}

  setupDropzone();
})();

function setupDropzone() {
  const dz = document.getElementById("dropzone");
  const input = document.getElementById("fileInput");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => {
    if (input.files.length) setFile(input.files[0]);
  });
  document.getElementById("analyzeBtn").addEventListener("click", runAnalysis);
}

function setFile(file) {
  selectedFile = file;
  const area = document.getElementById("fileArea");
  area.innerHTML = `<div class="filechip">${icon("file", 15)}<span>${esc(file.name)}</span>
    <span class="item-meta">${(file.size / 1024).toFixed(0)} KB</span>
    <span class="x" id="clearFile">${icon("x", 15)}</span></div>`;
  document.getElementById("clearFile").addEventListener("click", (e) => {
    e.stopPropagation();
    selectedFile = null;
    area.innerHTML = "";
    document.getElementById("analyzeBtn").disabled = true;
    document.getElementById("fileInput").value = "";
  });
  document.getElementById("analyzeBtn").disabled = false;
}

let progressTimer = null;
function startProgress() {
  document.getElementById("uploadCard").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("errorArea").innerHTML = "";
  document.getElementById("progressCard").classList.remove("hidden");
  let i = 0;
  const t = document.getElementById("progressText");
  t.textContent = PROGRESS_STEPS[0];
  progressTimer = setInterval(() => {
    i = (i + 1) % PROGRESS_STEPS.length;
    t.textContent = PROGRESS_STEPS[i];
  }, 1400);
}
function stopProgress() {
  clearInterval(progressTimer);
  document.getElementById("progressCard").classList.add("hidden");
}

async function runAnalysis() {
  if (!selectedFile) return;
  startProgress();
  const fd = new FormData();
  fd.append("estimate", selectedFile);
  try {
    const data = await api("/api/analyze", { method: "POST", body: fd });
    stopProgress();
    renderResults(data);
  } catch (err) {
    stopProgress();
    document.getElementById("uploadCard").classList.remove("hidden");
    document.getElementById("errorArea").innerHTML =
      `<div class="card card-pad" style="margin-top:20px"><div class="notice warn">${icon("warn", 16)}<span>${esc(
        err.message
      )}</span></div></div>`;
  }
}

function renderResults(data) {
  const { rows, totals, summary, filename } = data;
  const results = document.getElementById("results");
  const matched = rows.filter((r) => r.matched);

  if (matched.length === 0) {
    results.innerHTML = `
      <div class="card card-pad">
        <div class="empty">${icon("box", 34)}
          <div style="font-weight:600; color:var(--ink); margin-bottom:4px">置き換え対象の項目が見つかりませんでした</div>
          <div>製品DBのキーワードに一致する明細（フローリング・タイル・床材など）が含まれていると診断できます。<br>製品DBのキーワード登録をご確認ください。</div>
        </div>
        <div style="text-align:center"><button class="btn" id="againBtn">別の見積書で試す</button></div>
      </div>`;
    results.classList.remove("hidden");
    document.getElementById("againBtn").addEventListener("click", resetView);
    return;
  }

  const costPositive = totals.costSaving >= 0;
  const co2pct = Math.round(totals.co2Percent);

  const statHtml = `
    <div class="card">
      <div class="stat-grid">
        <div class="stat">
          <div class="label">コスト差額（合計）</div>
          <div class="value cost">${costPositive ? "" : "▲"}${yen(Math.abs(totals.costSaving))}</div>
          <div class="sub">${costPositive ? "削減見込み" : "増加"} · ${totals.count}項目を置換</div>
        </div>
        <div class="stat">
          <div class="label">CO\u2082削減量（合計）</div>
          <div class="value co2">${co2fmt(totals.co2Saving)}</div>
          <div class="sub">現行比 約${co2pct}% 削減</div>
        </div>
        <div class="stat" style="display:grid; place-items:center;">
          <div class="seal"><div><div class="big">-${co2pct}%</div><div class="cap">CO\u2082 REDUCTION</div></div></div>
        </div>
      </div>
      <div class="ets-bar">
        <span class="ets-label">${icon("badge", 13)} GX-ETS排出枠換算</span>
        <span class="ets-val">${yen(totals.etsValueLow)} 〜 ${yen(totals.etsValueHigh)} 相当</span>
        <span class="ets-note">2026年度 政府公表の参考価格（1,700〜4,300円/t-CO\u2082）で試算</span>
      </div>
    </div>`;

  const summaryHtml = `
    <div class="card card-pad">
      <div class="card-title">${icon("spark", 13)} AI総括コメント</div>
      <div class="summary-box">${esc(summary)}</div>
    </div>`;

  const rowsHtml = rows
    .map((r, i) => {
      const idx = String(i + 1).padStart(2, "0");
      if (!r.matched) {
        return `<tr class="dim">
          <td class="item-meta">${idx}</td>
          <td><span class="item-name">${esc(r.name)}</span><div class="item-meta">${r.qty}${esc(r.unit || "")}</div></td>
          <td class="num">${yen(r.amount)}</td>
          <td class="na">対象製品なし</td>
          <td class="num na">—</td>
          <td class="num na">—</td>
          <td class="num na">—</td>
        </tr>`;
      }
      const costCls = r.costDiff >= 0 ? "pos" : "neg";
      const costTxt = (r.costDiff >= 0 ? "" : "▲") + yen(Math.abs(r.costDiff));
      return `<tr>
          <td class="item-meta">${idx}</td>
          <td><span class="item-name">${esc(r.name)}</span><div class="item-meta">${r.qty}${esc(r.unit || "")}</div></td>
          <td class="num">${yen(r.amount)}</td>
          <td><span class="prod-tag">${icon("check", 13)}${esc(r.product.name)}</span>${r.product.verified ? `<span class="badge verified" style="margin-left:6px">${icon("badge", 10)} 検証済</span>` : ""}</td>
          <td class="num">${yen(r.newAmount)}</td>
          <td class="num ${costCls}">${costTxt}</td>
          <td class="num pos">-${Math.round(r.co2DiffPercent)}%</td>
        </tr>
        <tr class="comment-row"><td></td><td colspan="6"><div class="comment">${icon("spark", 12, 1.8).replace(
          "<svg",
          '<svg class="mk"'
        )}${esc(r.comment || "")}</div></td></tr>`;
    })
    .join("");

  const tableHtml = `
    <div class="card">
      <div class="card-pad" style="padding-bottom:0"><div class="card-title">${icon("file", 13)} 明細診断（${esc(filename)}）</div></div>
      <div class="table-scroll card-pad" style="padding-top:8px">
        <table class="ledger">
          <thead><tr>
            <th>#</th><th>元の項目</th><th class="num">元の金額</th><th>提案製品</th>
            <th class="num">新金額</th><th class="num">差額</th><th class="num">CO\u2082削減</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;

  results.innerHTML =
    statHtml +
    summaryHtml +
    tableHtml +
    `<div style="margin-top:20px"><button class="btn" id="againBtn">別の見積書で診断する</button></div>`;
  results.classList.remove("hidden");
  document.getElementById("againBtn").addEventListener("click", resetView);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetView() {
  selectedFile = null;
  document.getElementById("fileArea").innerHTML = "";
  document.getElementById("fileInput").value = "";
  document.getElementById("analyzeBtn").disabled = true;
  document.getElementById("results").classList.add("hidden");
  document.getElementById("results").innerHTML = "";
  document.getElementById("uploadCard").classList.remove("hidden");
}
