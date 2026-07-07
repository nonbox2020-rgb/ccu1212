/* global renderTopbar, icon, api, yen, esc */
"use strict";

(async function init() {
  await renderTopbar("products");
  document.getElementById("eyebrow").innerHTML = icon("box", 12) + " PRODUCT CATALOG";
  document.getElementById("addBtn").innerHTML = icon("plus", 15) + " 製品を追加";
  document.getElementById("seedBtn").innerHTML = icon("box", 15) + " サンプル建材を一括投入";
  document.getElementById("closeModal").innerHTML = icon("x", 16);
  document.getElementById("footNote").innerHTML =
    icon("info", 13) +
    "<span>「基準CO\u2082」は置き換え前の既存資材の排出係数です。この値と自社製品の排出係数の差が削減量として計算されます。</span>";

  document.getElementById("addBtn").addEventListener("click", () => openModal());
  document.getElementById("seedBtn").addEventListener("click", seedSamples);
  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("saveBtn").addEventListener("click", save);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  await load();
})();

let products = [];

async function load() {
  const data = await api("/api/products");
  products = data.products;
  render();
}

function render() {
  const tb = document.getElementById("ptbody");
  const empty = document.getElementById("emptyState");
  if (!products.length) {
    tb.innerHTML = "";
    empty.innerHTML = `<div class="empty">${icon("box", 34)}<div>製品が登録されていません。「製品を追加」から登録してください。</div></div>`;
    return;
  }
  empty.innerHTML = "";
  tb.innerHTML = products
    .map(
      (p) => `<tr>
        <td><span class="item-name">${esc(p.name)}</span>${p.active ? "" : ' <span class="badge off">無効</span>'}
          ${p.description ? `<div class="item-meta" style="max-width:280px; white-space:normal">${esc(p.description)}</div>` : ""}</td>
        <td>${p.category ? `<span class="badge">${esc(p.category)}</span>` : "—"}</td>
        <td class="num">${yen(p.unit_price)}</td>
        <td class="item-meta">${esc(p.unit)}</td>
        <td class="num">${Number(p.co2_per_unit).toFixed(2)}</td>
        <td class="num">${Number(p.baseline_co2_per_unit).toFixed(2)}</td>
        <td style="max-width:200px; white-space:normal">
          ${p.verified ? `<span class="badge verified">${icon("badge", 11)} 検証済</span> ` : ""}
          <span class="item-meta">${esc(p.data_source || "未設定")}</span>
        </td>
        <td><div class="row-actions">
          <button class="btn btn-sm btn-ghost" data-edit="${p.id}">${icon("edit", 14)}</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">${icon("trash", 14)}</button>
        </div></td>
      </tr>`
    )
    .join("");
  tb.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openModal(products.find((x) => x.id == b.dataset.edit)))
  );
  tb.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => del(b.dataset.del)));
}

function openModal(p) {
  document.getElementById("modalTitle").textContent = p ? "製品を編集" : "製品を追加";
  document.getElementById("f_id").value = p ? p.id : "";
  document.getElementById("f_name").value = p ? p.name : "";
  document.getElementById("f_category").value = p ? p.category : "";
  document.getElementById("f_unit").value = p ? p.unit : "m2";
  document.getElementById("f_price").value = p ? p.unit_price : "";
  document.getElementById("f_co2").value = p ? p.co2_per_unit : "";
  document.getElementById("f_baseline").value = p ? p.baseline_co2_per_unit : "";
  document.getElementById("f_keywords").value = p ? p.keywords : "";
  document.getElementById("f_source").value = p ? (p.data_source || "") : "";
  document.getElementById("f_verified").checked = p ? !!p.verified : false;
  document.getElementById("f_desc").value = p ? p.description : "";
  document.getElementById("modal").classList.add("show");
}
function closeModal() {
  document.getElementById("modal").classList.remove("show");
}

async function save() {
  const id = document.getElementById("f_id").value;
  const body = {
    name: document.getElementById("f_name").value,
    category: document.getElementById("f_category").value,
    unit: document.getElementById("f_unit").value,
    unit_price: document.getElementById("f_price").value,
    co2_per_unit: document.getElementById("f_co2").value,
    baseline_co2_per_unit: document.getElementById("f_baseline").value,
    keywords: document.getElementById("f_keywords").value,
    data_source: document.getElementById("f_source").value,
    verified: document.getElementById("f_verified").checked,
    description: document.getElementById("f_desc").value,
  };
  if (!body.name.trim()) {
    alert("製品名は必須です。");
    return;
  }
  try {
    if (id) await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/api/products", { method: "POST", body: JSON.stringify(body) });
    closeModal();
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function del(id) {
  const p = products.find((x) => x.id == id);
  if (!confirm(`「${p ? p.name : ""}」を削除しますか？`)) return;
  await api(`/api/products/${id}`, { method: "DELETE" });
  await load();
}

async function seedSamples() {
  if (!confirm("新築工事の見積書にマッチするサンプル建材（5件）を一括登録します。\n※ CO2係数・単価は提案が出るように置いた仮の値です。実運用では検証済みの数値に差し替えてください。\n\n登録しますか？")) return;
  const btn = document.getElementById("seedBtn");
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = "投入中…";
  try {
    const res = await api("/api/products/seed-samples", { method: "POST" });
    await load();
    alert(`${res.added}件を追加しました。${res.skipped ? `（${res.skipped}件は登録済みのためスキップ）` : ""}`);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}
