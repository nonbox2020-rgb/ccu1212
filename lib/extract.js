"use strict";

const path = require("path");
const iconv = require("iconv-lite");
const Papa = require("papaparse");
const XLSX = require("xlsx");

/**
 * Convert an uploaded file buffer into a form the AI can read.
 * Returns one of:
 *   { kind: "text",     text }
 *   { kind: "document", base64, mediaType }   // PDFs -> Claude native document
 *   { kind: "image",    base64, mediaType }   // images -> Claude vision
 */
function extractForAI(buffer, originalName, mimeType) {
  const ext = (path.extname(originalName || "") || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();

  // Images
  if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    const mediaType = mime.startsWith("image/") ? mime : guessImageMime(ext);
    return { kind: "image", base64: buffer.toString("base64"), mediaType };
  }

  // PDF -> native document block (handles scanned & complex layouts)
  if (ext === ".pdf" || mime === "application/pdf") {
    return { kind: "document", base64: buffer.toString("base64"), mediaType: "application/pdf" };
  }

  // Excel -> convert every sheet to CSV text
  if ([".xlsx", ".xls", ".xlsm"].includes(ext) || mime.includes("spreadsheetml") || mime.includes("ms-excel")) {
    try {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts = [];
      wb.SheetNames.forEach((sheetName) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
        if (csv.trim()) parts.push(`# シート: ${sheetName}\n${csv}`);
      });
      return { kind: "text", text: parts.join("\n\n") || "(空のシートです)" };
    } catch (e) {
      return { kind: "text", text: "(Excelファイルの読み取りに失敗しました)" };
    }
  }

  // CSV / TSV / TXT / others -> decode text with encoding detection
  const text = decodeText(buffer);
  // Normalise CSV a little so the AI sees clean rows
  if ([".csv", ".tsv"].includes(ext)) {
    try {
      const parsed = Papa.parse(text.trim(), { skipEmptyLines: true });
      const rows = parsed.data.map((r) => (Array.isArray(r) ? r.join(",") : String(r)));
      return { kind: "text", text: rows.join("\n") };
    } catch (e) {
      return { kind: "text", text };
    }
  }
  return { kind: "text", text };
}

function guessImageMime(ext) {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/**
 * Japanese estimate files are often Shift_JIS. Try UTF-8 first; if it looks
 * broken (many replacement chars), fall back to Shift_JIS.
 */
function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount > 3) {
    try {
      return iconv.decode(buffer, "Shift_JIS");
    } catch (e) {
      return utf8;
    }
  }
  return utf8;
}

module.exports = { extractForAI };
