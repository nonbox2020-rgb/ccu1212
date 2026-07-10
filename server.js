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
const mailer = require("./lib/mailer");

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

    // メール確認コードを発行・送信（本登録前）
    try {
      const code = await db.issueAuthCode(user.id, "verify_email");
      await mailer.sendVerificationCode(user.email, code);
    } catch (e) {
      console.error("[signup] 確認コード送信に失敗:", e.message);
    }

    // ログインはさせず、確認コード入力へ誘導
    res.json({ ok: true, needVerify: true, email: user.email });
  })
);

// メール確認コードの検証（本登録完了）
app.post(
  "/api/verify-email",
  authLimiter,
  wrap(async (req, res) => {
    const { email, code } = req.body || {};
    if (!isEmail(email) || !code) return res.status(400).json({ error: "メールアドレスと確認コードを入力してください。" });
    const user = await db.findAnyUserByEmail(email);
    if (!user) return res.status(400).json({ error: "確認コードが正しくないか、有効期限が切れています。" });
    if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

    const result = await db.verifyAuthCode(user.id, "verify_email", code);
    if (!result.ok) {
      const msg = result.reason === "too_many_attempts"
        ? "試行回数が上限に達しました。コードを再送してください。"
        : "確認コードが正しくないか、有効期限が切れています。";
      return res.status(400).json({ error: msg });
    }
    await db.markEmailVerified(user.id);
    await db.audit(user.org_id, user, "email.verified", "メールアドレスを確認", clientIp(req));

    // 確認完了と同時にログイン状態にする
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "セッションの作成に失敗しました。" });
      req.session.userId = user.id;
      res.json({ ok: true });
    });
  })
);

// 確認コードの再送
app.post(
  "/api/resend-code",
  authLimiter,
  wrap(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ error: "メールアドレスを入力してください。" });
    const user = await db.findAnyUserByEmail(email);
    // アカウントの有無を漏らさない：存在してもしなくても同じ応答
    if (user && !user.email_verified) {
      try {
        const code = await db.issueAuthCode(user.id, "verify_email");
        await mailer.sendVerificationCode(user.email, code);
      } catch (e) {
        console.error("[resend] 送信失敗:", e.message);
      }
    }
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

    // メール未確認ならログインを止め、確認フローへ誘導
    if (matched.email_verified === false) {
      try {
        const code = await db.issueAuthCode(matched.id, "verify_email");
        await mailer.sendVerificationCode(matched.email, code);
      } catch (e) {
        console.error("[login] 確認コード送信失敗:", e.message);
      }
      return res.status(403).json({ error: "メールアドレスの確認が完了していません。確認コードを送信しました。", needVerify: true, email: matched.email });
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

// パスワード再設定：コード送信
app.post(
  "/api/forgot-password",
  authLimiter,
  wrap(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ error: "有効なメールアドレスを入力してください。" });
    const user = await db.findAnyUserByEmail(email);
    // アカウントの存在を漏らさない：常に同じ成功応答
    if (user) {
      try {
        const code = await db.issueAuthCode(user.id, "password_reset");
        await mailer.sendPasswordResetCode(user.email, code);
        await db.audit(user.org_id, user, "password.reset_request", "パスワード再設定コードを送信", clientIp(req));
      } catch (e) {
        console.error("[forgot] 送信失敗:", e.message);
      }
    }
    res.json({ ok: true });
  })
);

// パスワード再設定：コード＋新パスワードで確定
app.post(
  "/api/reset-password",
  authLimiter,
  wrap(async (req, res) => {
    const { email, code, password } = req.body || {};
    if (!isEmail(email) || !code) return res.status(400).json({ error: "メールアドレスとコードを入力してください。" });
    if (!strongEnough(password)) return res.status(400).json({ error: "新しいパスワードは8文字以上で設定してください。" });

    const user = await db.findAnyUserByEmail(email);
    if (!user) return res.status(400).json({ error: "コードが正しくないか、有効期限が切れています。" });

    const result = await db.verifyAuthCode(user.id, "password_reset", code);
    if (!result.ok) {
      const msg = result.reason === "too_many_attempts"
        ? "試行回数が上限に達しました。最初からやり直してください。"
        : "コードが正しくないか、有効期限が切れています。";
      return res.status(400).json({ error: msg });
    }
    await db.updatePassword(user.id, password);
    // 再設定を機にメール確認済みにもする（コードを受け取れた＝本人）
    if (!user.email_verified) await db.markEmailVerified(user.id);
    await db.audit(user.org_id, user, "password.reset", "パスワードを再設定", clientIp(req));
    res.json({ ok: true });
  })
);

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

// サンプル建材の一括投入（運営者のみ）。新築工事見積書にマッチする仮製品セット。
const SAMPLE_MATERIALS = [
  { name: "LIMEX 高断熱サッシ", category: "建具", unit: "箇所", unit_price: 45000, co2_per_unit: 12, baseline_co2_per_unit: 38, keywords: "複層サッシAPW,複層サッシ,サッシ,APW,樹脂サッシ,窓,建具", description: "高断熱・省エネの環境配慮型サッシ。", data_source: "社内LCA試算（仮データ）", verified: false },
  { name: "エコLow-E複層ガラス", category: "ガラス", unit: "箇所", unit_price: 38000, co2_per_unit: 9, baseline_co2_per_unit: 25, keywords: "ガラス,防犯ガラス,複層ガラス,Low-Eガラス", description: "断熱・防犯性能を両立した複層ガラス。", data_source: "社内LCA試算（仮データ）", verified: false },
  { name: "高効率エコキュート（提携品）", category: "給湯設備", unit: "台", unit_price: 420000, co2_per_unit: 180, baseline_co2_per_unit: 650, keywords: "エコキュート,給湯,ヒートポンプ", description: "他社提携の高効率給湯機（紹介手数料対象の想定）。", data_source: "メーカー公表値（仮）", verified: true },
  { name: "CR LIMEX 排水管材", category: "配管", unit: "式", unit_price: 450000, co2_per_unit: 120, baseline_co2_per_unit: 300, keywords: "給排水,排水,配管,上下水道", description: "カーボンリサイクル素材を用いた排水配管材。", data_source: "社内LCA試算（仮データ）", verified: false },
  { name: "LIMEX 構造用ボード", category: "構造材", unit: "式", unit_price: 15000000, co2_per_unit: 8500, baseline_co2_per_unit: 14000, keywords: "木造,在来工法,本体,構造,ダブルフォーム", description: "石灰石由来の低炭素構造材（本体工事の代替想定）。", data_source: "社内LCA試算（仮データ）", verified: false },
];

app.post("/api/products/seed-samples", requirePlatformAdmin, wrap(async (req, res) => {
  const existing = await db.listProducts(req.user.org_id);
  const existingNames = new Set(existing.map((p) => p.name));
  let added = 0;
  for (const m of SAMPLE_MATERIALS) {
    if (existingNames.has(m.name)) continue; // 重複は追加しない
    await db.createProduct(req.user.org_id, m);
    added += 1;
  }
  await db.audit(req.user.org_id, req.user, "product.seed", `サンプル建材を一括投入（${added}件）`, clientIp(req));
  res.json({ ok: true, added, skipped: SAMPLE_MATERIALS.length - added });
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
