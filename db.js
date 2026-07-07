"use strict";

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.warn(
    "[db] 警告: DATABASE_URL が未設定です。Renderの環境変数、またはローカル .env にPostgreSQL接続文字列を設定してください。"
  );
}

const needsSSL = !!DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[db] 予期しないPoolエラー:", err.message);
});

/* ============================================================
   スキーマ（マルチテナント）
   organizations（会社）─┬─ users（ユーザー）
                        ├─ products（自社製品）
                        ├─ settings（会社ごとの設定）
                        └─ audit_logs（監査ログ）
   ============================================================ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  unit TEXT DEFAULT 'm2',
  unit_price DOUBLE PRECISION DEFAULT 0,
  co2_per_unit DOUBLE PRECISION DEFAULT 0,
  baseline_co2_per_unit DOUBLE PRECISION DEFAULT 0,
  keywords TEXT DEFAULT '',
  description TEXT DEFAULT '',
  data_source TEXT DEFAULT '',
  verified BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_org ON products(org_id);

CREATE TABLE IF NOT EXISTS settings (
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS analyses (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename TEXT,
  matched_count INTEGER DEFAULT 0,
  cost_saving DOUBLE PRECISION DEFAULT 0,
  co2_saving DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analyses_org ON analyses(org_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at DESC);
`;

const SEED_PRODUCTS = [
  { name: "CR LIMEX フローリング", category: "床材", unit: "m2", unit_price: 7800, co2_per_unit: 2.3, baseline_co2_per_unit: 8.0, keywords: "複合フローリング,天然木フローリング,木質フローリング,フローリング,床材,フロア材", description: "カーボンリサイクル技術を用いた複合床材。工場排出CO2と鉄鋼廃棄由来カルシウムを活用。", data_source: "TBM社内LCA試算（サンプル値）", verified: false },
  { name: "CR LIMEX タイル", category: "床材", unit: "m2", unit_price: 6200, co2_per_unit: 1.9, baseline_co2_per_unit: 9.5, keywords: "タイルカーペット,カーペットタイル,タイル床材,床タイル,タイル", description: "店舗・高耐久空間向けのタイル型床材。", data_source: "TBM社内LCA試算（サンプル値）", verified: false },
  { name: "CR LIMEX 長尺シート", category: "床材", unit: "m2", unit_price: 4800, co2_per_unit: 2.0, baseline_co2_per_unit: 8.4, keywords: "ビニル床材,塩ビシート,長尺シート,シート床材,ビニルシート", description: "共用部・水まわり向けの長尺床シート。", data_source: "TBM社内LCA試算（サンプル値）", verified: false },
  { name: "LIMEX シート (名刺・印刷用)", category: "紙代替", unit: "kg", unit_price: 1200, co2_per_unit: 0.9, baseline_co2_per_unit: 3.1, keywords: "上質紙,コート紙,印刷用紙,名刺,紙,ペーパー", description: "石灰石を主原料とする紙・プラスチック代替素材。", data_source: "TBM社内LCA試算（サンプル値）", verified: false },
];

async function init() {
  await pool.query(SCHEMA);
  console.log("[db] スキーマ初期化完了");
  return true;
}

// health check（死活監視用）
async function ping() {
  const { rows } = await pool.query("SELECT 1 AS ok");
  return rows[0].ok === 1;
}

/* ------------------------------ 組織 ------------------------------ */

function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

async function createOrganizationWithOwner({ orgName, email, password, userName }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // slug の一意性を確保
    let slug = slugify(orgName);
    let suffix = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const check = await client.query("SELECT 1 FROM organizations WHERE slug = $1", [suffix ? `${slug}-${suffix}` : slug]);
      if (check.rowCount === 0) {
        if (suffix) slug = `${slug}-${suffix}`;
        break;
      }
      suffix += 1;
    }

    const orgRes = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING *",
      [String(orgName).trim(), slug]
    );
    const org = orgRes.rows[0];

    const hash = await bcrypt.hash(password, 12);
    const userRes = await client.query(
      `INSERT INTO users (org_id, email, name, password_hash, role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id, org_id, email, name, role, active, created_at`,
      [org.id, String(email).toLowerCase().trim(), String(userName || "").trim(), hash]
    );
    const user = userRes.rows[0];

    // 初期製品を投入
    for (const p of SEED_PRODUCTS) {
      await client.query(
        `INSERT INTO products (org_id, name, category, unit, unit_price, co2_per_unit, baseline_co2_per_unit, keywords, description, data_source, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [org.id, p.name, p.category, p.unit, p.unit_price, p.co2_per_unit, p.baseline_co2_per_unit, p.keywords, p.description, p.data_source, p.verified]
      );
    }

    await client.query("COMMIT");
    return { org, user };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getOrganization(id) {
  const { rows } = await pool.query("SELECT * FROM organizations WHERE id = $1", [id]);
  return rows[0] || null;
}

/* ------------------------------ ユーザー・認証 ------------------------------ */

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT u.*, o.name AS org_name, o.slug AS org_slug
     FROM users u JOIN organizations o ON o.id = u.org_id
     WHERE u.email = $1 AND u.active = true
     ORDER BY u.created_at ASC`,
    [String(email).toLowerCase().trim()]
  );
  return rows; // 同一メールが複数組織に存在する可能性を考慮し配列で返す
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.org_id, u.email, u.name, u.role, u.active, o.name AS org_name, o.slug AS org_slug
     FROM users u JOIN organizations o ON o.id = u.org_id
     WHERE u.id = $1 AND u.active = true`,
    [id]
  );
  return rows[0] || null;
}

async function touchLastLogin(userId) {
  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
}

async function listUsers(orgId) {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, active, last_login_at, created_at FROM users WHERE org_id = $1 ORDER BY created_at ASC",
    [orgId]
  );
  return rows;
}

async function emailExistsInOrg(orgId, email) {
  const { rows } = await pool.query("SELECT 1 FROM users WHERE org_id = $1 AND email = $2", [orgId, String(email).toLowerCase().trim()]);
  return rows.length > 0;
}

async function createUser(orgId, { email, name, password, role }) {
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (org_id, email, name, password_hash, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, active, created_at`,
    [orgId, String(email).toLowerCase().trim(), String(name || "").trim(), hash, role === "admin" ? "admin" : "member"]
  );
  return rows[0];
}

async function updateUserActive(orgId, userId, active) {
  await pool.query("UPDATE users SET active = $1 WHERE id = $2 AND org_id = $3", [!!active, userId, orgId]);
  return true;
}

async function countOwners(orgId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1 AND role = 'owner' AND active = true", [orgId]);
  return rows[0].c;
}

/* ------------------------------ 製品（org単位） ------------------------------ */

// プラットフォーム運営者（PLATFORM_ADMIN_EMAIL）の org_id を取得。
// この org の製品カタログを全ユーザー共通のカタログとして配信する。
async function getPlatformOrgId() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || "").toLowerCase().trim();
  if (!email) return null;
  const { rows } = await pool.query(
    "SELECT org_id FROM users WHERE email = $1 ORDER BY created_at ASC LIMIT 1",
    [email]
  );
  return rows.length ? rows[0].org_id : null;
}

// 全ユーザーに見せる共通カタログ（運営者orgの有効な製品）。
// 運営者が未設定・未登録の場合は空配列を返す。
async function listPlatformCatalog(includeInactive = false) {
  const orgId = await getPlatformOrgId();
  if (!orgId) return [];
  return listProducts(orgId, includeInactive);
}

async function listProducts(orgId, includeInactive = true) {
  const where = includeInactive ? "" : "AND active = true";
  const { rows } = await pool.query(`SELECT * FROM products WHERE org_id = $1 ${where} ORDER BY category, name`, [orgId]);
  return rows;
}

async function getProduct(orgId, id) {
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1 AND org_id = $2", [id, orgId]);
  return rows[0] || null;
}

async function createProduct(orgId, p) {
  const { rows } = await pool.query(
    `INSERT INTO products (org_id, name, category, unit, unit_price, co2_per_unit, baseline_co2_per_unit, keywords, description, data_source, verified, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      orgId,
      String(p.name || "").trim(),
      String(p.category || "").trim(),
      String(p.unit || "m2").trim(),
      Number(p.unit_price) || 0,
      Number(p.co2_per_unit) || 0,
      Number(p.baseline_co2_per_unit) || 0,
      String(p.keywords || "").trim(),
      String(p.description || "").trim(),
      String(p.data_source || "").trim(),
      p.verified === true || p.verified === "true",
      !(p.active === 0 || p.active === false),
    ]
  );
  return rows[0];
}

async function updateProduct(orgId, id, p) {
  const cur = await getProduct(orgId, id);
  if (!cur) return null;
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, category=$2, unit=$3, unit_price=$4, co2_per_unit=$5,
     baseline_co2_per_unit=$6, keywords=$7, description=$8, data_source=$9, verified=$10, active=$11, updated_at=now()
     WHERE id=$12 AND org_id=$13 RETURNING *`,
    [
      p.name !== undefined ? String(p.name).trim() : cur.name,
      p.category !== undefined ? String(p.category).trim() : cur.category,
      p.unit !== undefined ? String(p.unit).trim() : cur.unit,
      p.unit_price !== undefined ? Number(p.unit_price) || 0 : cur.unit_price,
      p.co2_per_unit !== undefined ? Number(p.co2_per_unit) || 0 : cur.co2_per_unit,
      p.baseline_co2_per_unit !== undefined ? Number(p.baseline_co2_per_unit) || 0 : cur.baseline_co2_per_unit,
      p.keywords !== undefined ? String(p.keywords).trim() : cur.keywords,
      p.description !== undefined ? String(p.description).trim() : cur.description,
      p.data_source !== undefined ? String(p.data_source).trim() : cur.data_source,
      p.verified !== undefined ? (p.verified === true || p.verified === "true") : cur.verified,
      p.active !== undefined ? !!p.active : cur.active,
      id, orgId,
    ]
  );
  return rows[0];
}

async function deleteProduct(orgId, id) {
  await pool.query("DELETE FROM products WHERE id = $1 AND org_id = $2", [id, orgId]);
  return true;
}

/* ------------------------------ 設定（org単位） ------------------------------ */

async function getSetting(orgId, key, fallback = null) {
  const { rows } = await pool.query("SELECT value FROM settings WHERE org_id = $1 AND key = $2", [orgId, key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(orgId, key, value) {
  await pool.query(
    `INSERT INTO settings (org_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [orgId, key, value == null ? null : String(value)]
  );
}

async function allSettings(orgId) {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE org_id = $1", [orgId]);
  const out = {};
  rows.forEach((r) => (out[r.key] = r.value));
  return out;
}

/* ------------------------------ 診断ログ・監査ログ ------------------------------ */

async function logAnalysis(orgId, userId, rec) {
  await pool.query(
    "INSERT INTO analyses (org_id, user_id, filename, matched_count, cost_saving, co2_saving) VALUES ($1,$2,$3,$4,$5,$6)",
    [orgId, userId || null, rec.filename || "", rec.matched_count || 0, rec.cost_saving || 0, rec.co2_saving || 0]
  );
}

async function audit(orgId, user, action, detail = "", ip = "") {
  try {
    await pool.query(
      "INSERT INTO audit_logs (org_id, user_id, user_email, action, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)",
      [orgId || null, user ? user.id : null, user ? user.email : null, action, String(detail).slice(0, 500), String(ip).slice(0, 60)]
    );
  } catch (e) {
    console.error("[audit] 記録失敗:", e.message);
  }
}

async function listAuditLogs(orgId, limit = 100) {
  const { rows } = await pool.query(
    "SELECT action, detail, user_email, ip, created_at FROM audit_logs WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2",
    [orgId, Math.min(limit, 500)]
  );
  return rows;
}

module.exports = {
  pool,
  init,
  ping,
  createOrganizationWithOwner,
  getOrganization,
  findUserByEmail,
  verifyPassword,
  getUserById,
  touchLastLogin,
  listUsers,
  emailExistsInOrg,
  createUser,
  updateUserActive,
  countOwners,
  getPlatformOrgId,
  listPlatformCatalog,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getSetting,
  setSetting,
  allSettings,
  logAnalysis,
  audit,
  listAuditLogs,
};
