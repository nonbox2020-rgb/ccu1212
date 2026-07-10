"use strict";

/**
 * メール送信（Resend API）。
 * RESEND_API_KEY が未設定の場合は、コンソールにコードを出力するフォールバックで動作する
 * （テスト段階でメールサービス無しでも確認フローを試せる）。
 */

const RESEND_API_URL = "https://api.resend.com/emails";

function hasMailer() {
  return !!process.env.RESEND_API_KEY;
}

// テスト段階の既定送信元。独自ドメイン設定後は MAIL_FROM を差し替える。
function fromAddress() {
  return process.env.MAIL_FROM || "CO2削減サポート <onboarding@resend.dev>";
}

async function sendMail({ to, subject, html, text }) {
  // フォールバック：キー未設定ならコンソール出力（開発・テスト用）
  if (!hasMailer()) {
    console.log("========== [MAIL:fallback] ==========");
    console.log("To     :", to);
    console.log("Subject:", subject);
    console.log("Text   :", text || "(html only)");
    console.log("=====================================");
    return { ok: true, fallback: true };
  }

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`メール送信に失敗しました (${res.status}): ${body.slice(0, 200)}`);
  }
  return { ok: true, fallback: false };
}

/* ------------------------------ テンプレート ------------------------------ */

function codeEmailHtml(title, intro, code) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f2f3f1;font-family:sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #e4e7e3;border-radius:6px;overflow:hidden">
    <div style="background:#1f4634;padding:20px 24px">
      <div style="color:#fff;font-size:16px;font-weight:bold">CO<sub>2</sub>削減サポート</div>
    </div>
    <div style="padding:28px 24px">
      <h1 style="font-size:18px;color:#171c19;margin:0 0 12px">${title}</h1>
      <p style="font-size:14px;color:#3a423d;line-height:1.7;margin:0 0 20px">${intro}</p>
      <div style="text-align:center;margin:24px 0">
        <div style="display:inline-block;background:#eef3ef;border:1px solid #1f4634;border-radius:6px;padding:14px 28px;font-size:30px;font-weight:bold;letter-spacing:8px;color:#1f4634;font-family:monospace">${code}</div>
      </div>
      <p style="font-size:13px;color:#6a736c;line-height:1.7;margin:16px 0 0">このコードは10分間有効です。心当たりがない場合は、このメールを破棄してください。</p>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e4e7e3;font-size:11px;color:#9aa29b">このメールは送信専用です。ご返信いただいてもお答えできません。</div>
  </div>
</body></html>`;
}

async function sendVerificationCode(to, code) {
  const html = codeEmailHtml(
    "メールアドレスの確認",
    "アカウント登録を完了するには、下記の確認コードを画面に入力してください。",
    code
  );
  const text = `メールアドレスの確認\n確認コード: ${code}\nこのコードは10分間有効です。`;
  return sendMail({ to, subject: "【CO2削減サポート】確認コード", html, text });
}

async function sendPasswordResetCode(to, code) {
  const html = codeEmailHtml(
    "パスワードの再設定",
    "パスワードを再設定するには、下記のコードを画面に入力してください。",
    code
  );
  const text = `パスワードの再設定\n再設定コード: ${code}\nこのコードは10分間有効です。`;
  return sendMail({ to, subject: "【CO2削減サポート】パスワード再設定コード", html, text });
}

module.exports = { hasMailer, sendMail, sendVerificationCode, sendPasswordResetCode };
