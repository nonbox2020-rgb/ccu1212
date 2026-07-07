"use strict";

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const db = require("./db");
const { extractForAI } = require("./lib/extract");
const { analyze } = require("./lib/match");
const ai = require("./lib/ai");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex");
const IS_PROD = process.env.NODE_ENV === "production";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 15);
const MAX_LOGO_MB = Number(process.env.MAX_LOGO_MB || 2);
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== "false"; // 既定で新規会社登録を許可

const app = express();
app.set("trust proxy", 1); // Render等のリバースプロキシ配下で正しいIP/セキュアCookieを扱う
app.disable("x-powered-by");

/* ----------------------------- セキュリティヘッダ ----------------------------- */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

app.use(express.json({ limit: "2mb" }));

/* ----------------------------- セッション ----------------------------- */
app.use(
  session({
    store: new pgSession({ pool: db.pool, tableName: "user_sessions", createTableIfMissing: true }),
    name: "co2sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 8, // 8時間
    },
  })
);

/* ----------------------------- レート制限 ----------------------------- */
const clientIp = (req) => req.ip || req.headers["x-forwarded-for"] || "unknown";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // ログイン/登録は15分に10回まで
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "試行回数が上限を超えました。しばらく待ってから再度お試しください。" },
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12, // 診断は1分に12回まで（AIコスト・濫用対策）
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "リクエストが集中しています。少し時間をおいてから再度お試しください。" },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ----------------------------- 認証ミドルウェア ----------------------------- */
async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      const user = await db.getUserById(req.session.userId);
      if (user) {
        req.user = user;
      } else {
        req.session.destroy(() => {});
      }
    } catch (e) {
      return next(e);
    }
  }
  next();
}
app.use(loadUser);

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "認証が必要です。再度ログインしてください。", code: "UNAUTH" });
  return res.redirect("/login.html");
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "認証が必要です。" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "この操作の権限がありません。" });
    next();
  };
}

// プラットフォーム運営者（PLATFORM_ADMIN_EMAIL と一致するユーザー）だけを通す。
// 製品カタログ・設定の編集はこの運営者のみに許可する。
function isPlatformAdmin(user) {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || "").toLowerCase().trim();
  return !!email && !!user && user.email.toLowerCase() === email;
}

function requirePlatformAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "認証が必要です。" });
  if (!isPlatformAdmin(req.user)) return res.status(403).json({ error: "この操作は運営者のみ実行できます。" });
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ----------------------------- バリデーション補助 ----------------------------- */
const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
const strongEnough = (s) => typeof s === "string" && s.length >= 8 && s.length <= 200;

/* ============================================================
   認証系ルート
   ============================================================ */

app.get("/api/session", (req, res) => {
  if (req.user) {
    return res.json({
      authed: true,
      user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role },
      org: { id: req.user.org_id, name: req.user.org_name },
      isPlatformAdmin: isPlatformAdmin(req.user),
    });
  }
  res.json({ authed: false, allowSignup: ALLOW_SIGNUP });
});

// 新規会社登録（オーナーアカウント作成）
app.post(
  "/api/signup",
  authLimiter,
  wrap(async (req, res) => {
    if (!ALLOW_SIGNUP) return res.status(403).json({ error: "現在、新規登録は受け付けていません。" });
    const { orgName, email, password, userName } = req.body || {};
    if (!orgName || String(orgName).trim().length < 1) return res.status(400).json({ error: "会社名を入力してください。" });
    if (!isEmail(email)) return res.status(400).json({ error: "有効なメールアドレスを入力してください。" });
    if (!strongEnough(password)) return res.status(400).json({ error: "パスワードは8文字以上で設定してください。" });

    // メール重複は組織横断では許容するが、既存組織のオーナー乱立を避けるため同一メールの既存を確認
    const existing = await db.findUserByEmail(email);
    if (existing.length > 0) {
      return res.status(409).json({ error: "このメールアドレスは既に登録されています。ログインしてください。" });
    }

    const { org, user } = await db.createOrganizationWithOwner({ orgName, email, password, userName });
    await db.audit(org.id, user, "org.signup", `会社「${org.name}」を新規登録`, clientIp(req));

    req.session.userId = user.id;
    res.json({ ok: true });
  })
);

// ログイン
app.post(
  "/api/login",
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!isEmail(email) || !password) return res.status(400).json({ error: "メールアドレスとパスワードを入力してください。" });

    const candidates = await db.findUserByEmail(email);
    if (candidates.length === 0) {
      return res.status(401).json({ error: "メールアドレスまたはパスワードが正しくありません。" });
    }

    // 同一メールが複数組織に存在する場合、パスワード一致する最初のユーザーでログイン
    let matched = null;
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await db.verifyPassword(password, c.password_hash)) {
        matched = c;
        break;
      }
    }
    if (!matched) {
      await db.audit(candidates[0].org_id, null, "login.fail", `ログイン失敗: ${email}`, clientIp(req));
      return res.status(401).json({ error: "メールアドレスまたはパスワードが正しくありません。" });
    }

    await db.touchLastLogin(matched.id);
    await db.audit(matched.org_id, matched, "login", "ログイン成功", clientIp(req));

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "セッションの作成に失敗しました。" });
      req.session.userId = matched.id;
      res.json({ ok: true });
    });
  })
);

app.post("/api/logout", (req, res) => {
  const user = req.user;
  const orgId = user ? user.org_id : null;
  req.session.destroy(() => {
    res.clearCookie("co2sid");
    if (user) db.audit(orgId, user, "logout", "ログアウト", clientIp(req));
    res.json({ ok: true });
  });
});

/* ----------------------------- 静的ファイル ----------------------------- */
// 製品DB・設定のHTMLは静的配信させず、後段のガード付きルートで扱う
const GUARDED_HTML = new Set(["/products.html", "/settings.html"]);
const staticMw = express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders: (res, p) => {
    if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
  },
});
// 公開ページ（login/signup）とアセットは認証不要。ただし保護HTMLは静的配信をスキップ。
app.use((req, res, next) => {
  if (GUARDED_HTML.has(req.path)) return next();
  return staticMw(req, res, next);
});

/* ----------------------------- ヘルスチェック ----------------------------- */
app.get("/healthz", wrap(async (req, res) => {
  try {
    await db.ping();
    res.json({ status: "ok", db: "up", ai: ai.hasKey() ? "ready" : "no_key", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: "degraded", db: "down", error: e.message });
  }
}));

/* ----------------------------- 認証必須ページ ----------------------------- */
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, "public", name));
app.get("/", requireAuth, page("index.html"));

// 製品DB・設定は運営者(プラットフォーム管理者)のみ。一般ユーザーはトップへ。
function platformAdminPage(name) {
  return (req, res) => {
    if (!isPlatformAdmin(req.user)) return res.redirect("/");
    res.sendFile(path.join(__dirname, "public", name));
  };
}
app.get("/products.html", requireAuth, platformAdminPage("products.html"));
app.get("/settings.html", requireAuth, platformAdminPage("settings.html"));

// 以降の /api は認証必須＋汎用レート制限
app.use("/api", apiLimiter, requireAuth);

/* ============================================================
   製品API
   - 一覧(GET): 全ユーザーが「運営者の共通カタログ」を閲覧
   - 作成/更新/削除: 運営者(プラットフォーム管理者)のみ
   ============================================================ */

app.get("/api/products", wrap(async (req, res) => {
  // 運営者は自分のカタログをそのまま管理。一般ユーザーは運営者の共通カタログ(有効な製品のみ)を閲覧。
  if (isPlatformAdmin(req.user)) {
    return res.json({ products: await db.listProducts(req.user.org_id), canEdit: true });
  }
  const catalog = await db.listPlatformCatalog(false);
  res.json({ products: catalog, canEdit: false });
}));

app.post("/api/products", requirePlatformAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "製品名は必須です。" });
  const p = await db.createProduct(req.user.org_id, b);
  await db.audit(req.user.org_id, req.user, "product.create", `製品「${p.name}」を追加`, clientIp(req));
  res.json({ product: p });
}));

app.put("/api/products/:id", requirePlatformAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "不正なIDです。" });
  const p = await db.updateProduct(req.user.org_id, id, req.body || {});
  if (!p) return res.status(404).json({ error: "製品が見つかりません。" });
  await db.audit(req.user.org_id, req.user, "product.update", `製品「${p.name}」を更新`, clientIp(req));
  res.json({ product: p });
}));

app.delete("/api/products/:id", requirePlatformAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "不正なIDです。" });
  await db.deleteProduct(req.user.org_id, id);
  await db.audit(req.user.org_id, req.user, "product.delete", `製品ID ${id} を削除`, clientIp(req));
  res.json({ ok: true });
}));

/* ============================================================
   設定API
   - GET: 運営者は自組織の設定。一般ユーザーには運営者のブランディング(会社名・ロゴ)を配信
   - PUT/ロゴ: 運営者のみ
   ============================================================ */

app.get("/api/settings", wrap(async (req, res) => {
  if (isPlatformAdmin(req.user)) {
    const s = await db.allSettings(req.user.org_id);
    return res.json({
      settings: {
        company_name: s.company_name || req.user.org_name || "",
        report_note: s.report_note || "",
        logo_data_url: s.logo_data_url || "",
      },
      ai_ready: ai.hasKey(),
    });
  }
  // 一般ユーザー: 運営者orgのブランディングを配信（ヘッダーのロゴ・名称に使用）
  const platformOrgId = await db.getPlatformOrgId();
  let brand = { company_name: "", report_note: "", logo_data_url: "" };
  if (platformOrgId) {
    const s = await db.allSettings(platformOrgId);
    brand = {
      company_name: s.company_name || "",
      report_note: s.report_note || "",
      logo_data_url: s.logo_data_url || "",
    };
  }
  res.json({ settings: brand, ai_ready: ai.hasKey() });
}));

app.put("/api/settings", requirePlatformAdmin, wrap(async (req, res) => {
  const { company_name, report_note } = req.body || {};
  if (company_name !== undefined) await db.setSetting(req.user.org_id, "company_name", String(company_name).slice(0, 200));
  if (report_note !== undefined) await db.setSetting(req.user.org_id, "report_note", String(report_note).slice(0, 1000));
  await db.audit(req.user.org_id, req.user, "settings.update", "組織情報を更新", clientIp(req));
  res.json({ ok: true });
}));

/* ============================================================
   ユーザー管理API（owner/admin のみ）
   ============================================================ */

app.get("/api/users", requireRole("owner", "admin"), wrap(async (req, res) => {
  res.json({ users: await db.listUsers(req.user.org_id) });
}));

app.post("/api/users", requireRole("owner", "admin"), wrap(async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "有効なメールアドレスを入力してください。" });
  if (!strongEnough(password)) return res.status(400).json({ error: "パスワードは8文字以上で設定してください。" });
  if (await db.emailExistsInOrg(req.user.org_id, email)) {
    return res.status(409).json({ error: "このメールアドレスは既にこの組織に登録されています。" });
  }
  const u = await db.createUser(req.user.org_id, { email, name, password, role });
  await db.audit(req.user.org_id, req.user, "user.create", `ユーザー ${u.email} を追加`, clientIp(req));
  res.json({ user: u });
}));

app.put("/api/users/:id/active", requireRole("owner", "admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { active } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: "不正なIDです。" });
  if (id === req.user.id) return res.status(400).json({ error: "自分自身を無効化することはできません。" });
  // 最後のオーナーを無効化しない保護
  if (active === false) {
    const target = (await db.listUsers(req.user.org_id)).find((u) => u.id === id);
    if (target && target.role === "owner" && (await db.countOwners(req.user.org_id)) <= 1) {
      return res.status(400).json({ error: "最後のオーナーは無効化できません。" });
    }
  }
  await db.updateUserActive(req.user.org_id, id, active);
  await db.audit(req.user.org_id, req.user, "user.update", `ユーザーID ${id} を${active ? "有効化" : "無効化"}`, clientIp(req));
  res.json({ ok: true });
}));

/* ============================================================
   監査ログAPI（owner/admin のみ）
   ============================================================ */
app.get("/api/audit", requireRole("owner", "admin"), wrap(async (req, res) => {
  res.json({ logs: await db.listAuditLogs(req.user.org_id, 100) });
}));

/* ============================================================
   アップロード・診断
   ============================================================ */

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_MB * 1024 * 1024 } });

app.post("/api/settings/logo", requirePlatformAdmin, logoUpload.single("logo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルがありません。" });
  const ext = (path.extname(req.file.originalname) || "").toLowerCase();
  const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
  const mime = mimeMap[ext] || req.file.mimetype;
  if (!mime || !mime.startsWith("image/")) return res.status(400).json({ error: "画像ファイル(PNG/JPG/WEBP/SVG)を指定してください。" });
  const dataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  await db.setSetting(req.user.org_id, "logo_data_url", dataUrl);
  await db.audit(req.user.org_id, req.user, "settings.logo", "ロゴを更新", clientIp(req));
  res.json({ ok: true, logo_data_url: dataUrl });
}));

app.post("/api/analyze", analyzeLimiter, memUpload.single("estimate"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "見積書ファイルをアップロードしてください。" });

  const content = extractForAI(req.file.buffer, req.file.originalname, req.file.mimetype);

  let items;
  try {
    items = await ai.extractLineItems(content);
  } catch (e) {
    if (String(e.message).includes("NO_API_KEY")) {
      return res.status(503).json({ error: "AIキーが未設定です。管理者にお問い合わせください。", code: "NO_API_KEY" });
    }
    return res.status(502).json({ error: "見積書の読み取りに失敗しました。ファイル形式をご確認ください。", detail: String(e.message).slice(0, 200) });
  }

  // 診断は運営者の共通カタログと照合（運営者自身は自組織カタログ＝同じ内容）
  const products = isPlatformAdmin(req.user)
    ? await db.listProducts(req.user.org_id)
    : await db.listPlatformCatalog(false);
  const { rows, totals } = analyze(items, products);
  const matched = rows.filter((r) => r.matched);

  let summary = ai.fallbackSummary(totals);
  let comments = matched.map((r) => ai.fallbackComment(r));
  if (matched.length > 0) {
    try {
      const c = await ai.generateCommentary(matched, totals);
      if (c.summary) summary = c.summary;
      if (Array.isArray(c.comments) && c.comments.length === matched.length) comments = c.comments;
    } catch (e) {
      /* フォールバック維持 */
    }
  }

  let ci = 0;
  const enriched = rows.map((r) => (r.matched ? { ...r, comment: comments[ci++] } : r));

  await db.logAnalysis(req.user.org_id, req.user.id, {
    filename: req.file.originalname,
    matched_count: totals.count,
    cost_saving: totals.costSaving,
    co2_saving: totals.co2Saving,
  });
  await db.audit(req.user.org_id, req.user, "analyze", `見積診断: ${req.file.originalname}（${totals.count}件マッチ）`, clientIp(req));

  res.json({ filename: req.file.originalname, rows: enriched, totals, summary });
}));

/* ----------------------------- 404 & エラーハンドラ ----------------------------- */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "エンドポイントが見つかりません。" });
  res.status(404).sendFile(path.join(__dirname, "public", "login.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "ファイルサイズが上限を超えています。" });
  }
  console.error("[error]", err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: "サーバーエラーが発生しました。しばらくしてから再度お試しください。" });
});

/* ----------------------------- 起動 ----------------------------- */
let server;
db.init()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`CO2削減サポート [本番構成] running on :${PORT}  (env: ${IS_PROD ? "production" : "development"}, ai: ${ai.hasKey() ? "ready" : "no key"}, signup: ${ALLOW_SIGNUP ? "on" : "off"})`);
    });
  })
  .catch((e) => {
    console.error("DB初期化に失敗しました:", e);
    process.exit(1);
  });

// グレースフルシャットダウン
function shutdown(sig) {
  console.log(`\n${sig} 受信。シャットダウンします...`);
  if (server) server.close(() => { db.pool.end(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
