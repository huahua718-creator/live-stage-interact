import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_MODES = new Set(['BUBBLE', 'SPECTRUM', 'MYTH', 'QUADRANT', 'TREE', 'DANMAKU']);

/**
 * Parse RFC 4180 CSV text into an array of row arrays.
 * Handles UTF-8 BOM, CRLF/LF, and quoted fields with commas/newlines.
 */
export function parseCSV(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

/**
 * Normalize a Google Sheets URL to a CSV export URL when possible.
 */
export function normalizeSheetCsvUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('output=csv') || trimmed.includes('format=csv') || trimmed.includes('tqx=out:csv')) {
    return trimmed;
  }
  // Convert /pubhtml to /pub?output=csv
  if (trimmed.includes('/pubhtml')) {
    return trimmed.replace(/\/pubhtml.*$/, '/pub?output=csv');
  }
  // Convert standard /d/<ID>/edit... to /d/<ID>/export?format=csv
  const match = trimmed.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && !trimmed.includes('/d/e/')) {
    const gidMatch = trimmed.match(/gid=(\d+)/);
    const gid = gidMatch ? `&gid=${gidMatch[1]}` : '';
    return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${gid}`;
  }
  return trimmed;
}

/**
 * Convert parsed CSV rows into structured Question objects.
 */
export function rowsToQuestions(rows) {
  if (!rows || rows.length < 2) {
    throw new Error('試算表內容為空或缺少標題列');
  }
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const idx = (name) => headers.indexOf(name);

  const iOrder = idx('order');
  const iMode = idx('mode');
  const iTitle = idx('title');
  if (iOrder === -1 || iMode === -1 || iTitle === -1) {
    throw new Error('試算表缺少必要欄位：order, mode, title');
  }

  const get = (r, name) => {
    const i = idx(name);
    return i >= 0 && i < r.length ? (r[i] || '').trim() : '';
  };

  const questions = [];
  for (let rIdx = 1; rIdx < rows.length; rIdx++) {
    const r = rows[rIdx];
    const mode = get(r, 'mode').toUpperCase();
    const title = get(r, 'title');
    if (!title || !VALID_MODES.has(mode)) continue;

    const orderNum = Number.parseInt(get(r, 'order'), 10);
    const options = [];
    for (let k = 1; k <= 5; k++) {
      const val = get(r, `opt_${k}`);
      if (val) options.push({ key: `opt_${k}`, label: val });
    }

    const timerSec = Math.max(0, Number.parseInt(get(r, 'timer_sec'), 10) || 0);
    questions.push({
      id: `q_${Number.isFinite(orderNum) ? orderNum : rIdx}_${mode}`,
      order: Number.isFinite(orderNum) ? orderNum : rIdx,
      mode,
      title,
      subtitle: get(r, 'subtitle'),
      options,
      correctOpt: get(r, 'correct_opt'),
      explanation: get(r, 'explanation'),
      timerSec,
    });
  }

  questions.sort((a, b) => a.order - b.order);
  if (questions.length === 0) {
    throw new Error('試算表中沒有任何有效題目（請檢查 mode 是否為 BUBBLE/SPECTRUM/MYTH/QUADRANT/TREE/DANMAKU）');
  }
  return questions;
}

/**
 * Load questions from a Google Sheets CSV URL, or fallback to local sample-questions.csv.
 */
export async function loadQuestions(sheetUrl) {
  const normalized = normalizeSheetCsvUrl(sheetUrl);
  if (normalized) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(normalized, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Google Sheets 回應錯誤 HTTP ${res.status}`);
      }
      const csvText = await res.text();
      if (csvText.trim().startsWith('<!DOCTYPE') || csvText.trim().startsWith('<html')) {
        throw new Error('取得的內容為 HTML 而非 CSV，請確認試算表已「發布到網路」並選擇 CSV 格式');
      }
      const questions = rowsToQuestions(parseCSV(csvText));
      return { questions, source: normalized, isFallback: false };
    } finally {
      clearTimeout(timer);
    }
  }

  const samplePath = path.resolve(__dirname, '../sample-questions.csv');
  const csvText = fs.readFileSync(samplePath, 'utf8');
  return {
    questions: rowsToQuestions(parseCSV(csvText)),
    source: 'sample-questions.csv (內建示範題庫)',
    isFallback: true,
  };
}
