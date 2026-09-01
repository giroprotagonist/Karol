// Karol — translate primary (as-sung) lyric lines into timed English tracks.
// DeepL preferred, then OpenAI, then DeepSeek (already used for lyric diagnosis).

'use strict';

const https = require('https');
const http = require('http');
const library = require('./library');

const COMMON_EN = new Set(
  ('a an the and or but if of to in on at for with from by is are was were be been being '
    + 'i you he she we they it me my your his her our their this that these those not no yes '
    + 'up down out about into over after before so just like all can will would should could '
    + 'do does did done get got go going gone come came know knew known love baby girl boy '
    + 'yeah oh ah hey hi hello okay ok wow fire hot cool night day time life heart mind '
    + 'pornstar fantasy ultra terrorific club check').split(/\s+/)
);

function _httpJson(urlStr, opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const body = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: Object.assign({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
      }, opts.headers || {}),
      timeout: opts.timeout || 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error((data && (data.message || data.error)) || ('HTTP ' + res.statusCode + ': ' + raw.slice(0, 200))));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function _formPost(urlStr, form, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = Buffer.from(form, 'utf8');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
      }, headers || {}),
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { data = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error((data && data.message) || ('HTTP ' + res.statusCode + ': ' + raw.slice(0, 200))));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/** Rough heuristic: line is already mostly English → skip translate. */
function looksMostlyEnglish(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  // Non-Latin scripts → not English (incl. Thai — otherwise empty Latin word list skips translate)
  if (/[\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(raw)) return false;
  // Accented Latin (FR/ES/etc.) → translate
  if (/[àâäéèêëïîôùûüçñáíóú¿¡]/i.test(raw)) return false;
  const words = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  let hits = 0;
  for (const w of words) if (COMMON_EN.has(w) || /^[0-9]+$/.test(w)) hits++;
  return (hits / words.length) >= 0.8;
}

function detectSourceLang(sampleTexts) {
  const blob = (sampleTexts || []).slice(0, 12).join(' ');
  if (/[\u0E00-\u0E7F]/.test(blob)) return 'TH';
  if (/[àâäéèêëïîôùûüç]/i.test(blob) || /\b(j'|t'|l'|d'|qu'|cest|avec|dans|pour)\b/i.test(blob)) return 'FR';
  if (/[ñáéíóú¿¡]/i.test(blob) || /\b(que|por|para|con|una|los|las|el|yo|tú|tu)\b/i.test(blob)) return 'ES';
  return null; // auto
}

function rebuildWords(startTime, endTime, text) {
  const start = Number(startTime) || 0;
  let end = Number(endTime);
  if (!Number.isFinite(end) || end <= start) end = start + 1;
  const rawWords = String(text || '').trim().split(/\s+/).filter(Boolean);
  const line = { text: String(text || '').trim(), startTime: start, endTime: end, words: [] };
  if (!rawWords.length) return line;
  const dur = Math.max(end - start, 0.1);
  const totalChars = rawWords.reduce((s, w) => s + w.length, 0) || 1;
  let t = start;
  line.words = rawWords.map((w) => {
    const share = w.length / totalChars;
    const wDur = share * dur;
    const word = {
      text: w,
      startTime: Math.round(t * 1000) / 1000,
      endTime: Math.round((t + wDur) * 1000) / 1000,
    };
    t += wDur;
    return word;
  });
  line.words[line.words.length - 1].endTime = Math.round(end * 1000) / 1000;
  return line;
}

function buildEnglishLines(primaryLines, englishTexts) {
  if (!Array.isArray(primaryLines) || !primaryLines.length) {
    throw new Error('No primary lyric lines to translate');
  }
  if (!Array.isArray(englishTexts) || englishTexts.length !== primaryLines.length) {
    throw new Error(
      'English line count must match primary (' + primaryLines.length
      + ' lines). Got ' + (englishTexts ? englishTexts.length : 0) + '.'
    );
  }
  return primaryLines.map((pl, i) => rebuildWords(
    pl.startTime,
    pl.endTime,
    String(englishTexts[i] != null ? englishTexts[i] : '').trim()
  ));
}

async function translateWithDeepL(texts, sourceLang) {
  const key = (process.env.DEEPL_API_KEY || '').trim();
  if (!key) throw new Error('no_deepl');
  // Free keys end with :fx — use api-free host; otherwise prefer DEEPL_API_URL or free by default
  const isFree = /:fx$/i.test(key) || /free/i.test(process.env.DEEPL_API_URL || '');
  const host = process.env.DEEPL_API_URL
    || (isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate');
  // Build form body with repeated text=
  const parts = ['target_lang=EN', 'preserve_formatting=1'];
  if (sourceLang) parts.push('source_lang=' + encodeURIComponent(sourceLang));
  for (const t of texts) parts.push('text=' + encodeURIComponent(t));
  const data = await _formPost(host, parts.join('&'), { Authorization: 'DeepL-Auth-Key ' + key });
  const translations = (data && data.translations) || [];
  if (translations.length !== texts.length) {
    throw new Error('DeepL returned ' + translations.length + ' lines, expected ' + texts.length);
  }
  return translations.map((t) => String(t.text || '').trim());
}

async function translateWithOpenAICompatible(texts, sourceLang, opts) {
  const apiKey = (opts.apiKey || '').trim();
  const base = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model || 'gpt-4o-mini';
  if (!apiKey) throw new Error('no_openai');

  const numbered = texts.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const langHint = sourceLang === 'FR' ? 'French'
    : sourceLang === 'ES' ? 'Spanish'
    : sourceLang === 'TH' ? 'Thai'
    : 'the source language';
  const system = 'You translate karaoke lyric lines into natural English. '
    + 'Return ONLY a JSON array of strings, same length and order as the input. '
    + 'Keep already-English words, names, brands, and slang tokens unchanged. '
    + 'Do not merge or split lines. Do not add commentary.';
  const user = 'Translate these ' + langHint + ' karaoke lines to English.\n\n' + numbered;

  const data = await _httpJson(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    timeout: 90000,
  }, {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const content = (((data || {}).choices || [])[0] || {}).message
    ? data.choices[0].message.content
    : '';
  let arr = null;
  try {
    const m = String(content).match(/\[[\s\S]*\]/);
    arr = JSON.parse(m ? m[0] : content);
  } catch (e) {
    throw new Error('LLM returned non-JSON translations: ' + String(content).slice(0, 160));
  }
  if (!Array.isArray(arr) || arr.length !== texts.length) {
    throw new Error('LLM returned ' + (arr ? arr.length : 0) + ' lines, expected ' + texts.length);
  }
  return arr.map((t) => String(t == null ? '' : t).trim());
}

/**
 * Translate primary line texts → English strings (same length).
 * Skips mostly-English lines. Uses DeepL → OpenAI → DeepSeek.
 */
async function translateLines(primaryLines, opts) {
  const options = opts || {};
  const texts = (primaryLines || []).map((l) => String((l && l.text) || '').trim());
  const out = texts.slice();
  const needIdx = [];
  const needTexts = [];
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i] || looksMostlyEnglish(texts[i])) continue;
    needIdx.push(i);
    needTexts.push(texts[i]);
  }
  if (!needTexts.length) {
    return { texts: out, provider: 'skip-english', translated: 0 };
  }

  const sourceLang = options.sourceLang || detectSourceLang(needTexts);
  let translated = null;
  let provider = '';
  const errors = [];

  try {
    translated = await translateWithDeepL(needTexts, sourceLang);
    provider = 'deepl';
  } catch (e) {
    if (e.message !== 'no_deepl') errors.push('DeepL: ' + e.message);
  }

  if (!translated) {
    try {
      translated = await translateWithOpenAICompatible(needTexts, sourceLang, {
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
        model: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini',
      });
      provider = 'openai';
    } catch (e) {
      if (e.message !== 'no_openai') errors.push('OpenAI: ' + e.message);
    }
  }

  if (!translated) {
    try {
      translated = await translateWithOpenAICompatible(needTexts, sourceLang, {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      });
      provider = 'deepseek';
    } catch (e) {
      if (e.message !== 'no_openai') errors.push('DeepSeek: ' + e.message);
    }
  }

  if (!translated) {
    throw new Error(
      'No translation API available. Set DEEPL_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY. '
      + (errors.length ? '(' + errors.join('; ') + ')' : '')
    );
  }

  for (let j = 0; j < needIdx.length; j++) out[needIdx[j]] = translated[j];
  return { texts: out, provider, translated: needTexts.length, sourceLang: sourceLang || 'auto' };
}

function getPrimaryLyrics(videoId) {
  const ly = library.getLyrics(videoId)
    || library.getLyrics(String(videoId || '').replace(/-karaoke$/, '') + '-karaoke')
    || library.getLyrics(String(videoId || '').replace(/-karaoke$/, ''));
  if (!ly) return null;
  const resolved = library.resolveLyricDisplay(ly);
  const primaryLines = resolved.primaryLines && resolved.primaryLines.length
    ? resolved.primaryLines
    : (ly.lines || []);
  return {
    lrc: ly,
    primaryLines,
    primaryKey: resolved.primaryKey || (ly.tracks && ly.tracks.sung ? 'sung' : null),
    secondaryKey: resolved.secondaryKey,
    hasEnglish: !!(ly.tracks && ly.tracks.english && (ly.tracks.english.lines || []).length),
    path: library.getLrcJsonPath(videoId)
      || library.getLrcJsonPath(String(videoId || '').replace(/-karaoke$/, '') + '-karaoke'),
  };
}

/**
 * Preview auto-translate into English strings (does not write disk).
 */
async function previewEnglishTranslation(videoId) {
  const pack = getPrimaryLyrics(videoId);
  if (!pack || !pack.primaryLines.length) {
    return { ok: false, error: 'No primary lyrics found for ' + videoId };
  }
  try {
    const result = await translateLines(pack.primaryLines);
    return {
      ok: true,
      videoId,
      lineCount: pack.primaryLines.length,
      texts: result.texts,
      lyricsText: result.texts.join('\n'),
      provider: result.provider,
      translated: result.translated,
      sourceLang: result.sourceLang,
      hasEnglish: pack.hasEnglish,
      primarySample: pack.primaryLines.slice(0, 3).map((l) => l.text),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Write tracks.english from pasted or auto-translated English; preserve primary.
 */
async function addEnglishTrack(videoId, opts) {
  const options = opts || {};
  const pack = getPrimaryLyrics(videoId);
  if (!pack || !pack.primaryLines.length) {
    return { ok: false, error: 'No primary lyrics found for ' + videoId };
  }
  if (!pack.path) return { ok: false, error: 'No LRC file on disk for ' + videoId };

  if (pack.hasEnglish && !options.replaceEnglish) {
    return {
      ok: false,
      error: 'English track already exists. Pass replaceEnglish:true to overwrite it.',
      hasEnglish: true,
    };
  }

  let englishTexts = null;
  let provider = 'paste';

  if (options.lyricsText && String(options.lyricsText).trim()) {
    englishTexts = String(options.lyricsText).split(/\r?\n/).map((s) => s.trim());
    // Allow trailing blank line
    while (englishTexts.length > pack.primaryLines.length && englishTexts[englishTexts.length - 1] === '') {
      englishTexts.pop();
    }
  } else {
    const result = await translateLines(pack.primaryLines, { sourceLang: options.sourceLang });
    englishTexts = result.texts;
    provider = result.provider;
  }

  let englishLines;
  try {
    englishLines = buildEnglishLines(pack.primaryLines, englishTexts);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Load raw file so we don't lose tracks via normalize side-effects
  const fs = require('fs');
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(pack.path, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'Failed to read LRC: ' + e.message };
  }

  // Ensure primary is in tracks.sung (or romanized) before adding english
  const legacyAs = (pack.primaryKey === 'romanized') ? 'romanized'
    : (pack.primaryKey === 'english' ? 'sung' : (pack.primaryKey || 'sung'));
  if (!existing.tracks || !Object.keys(existing.tracks).length) {
    const lang = detectSourceLang(pack.primaryLines.map((l) => l.text)) || '';
    existing = library.mergeLyricTrack(
      existing,
      { lines: pack.primaryLines, alignMode: existing.alignMode || existing.source || '', videoId },
      legacyAs === 'romanized' ? 'romanized' : 'sung',
      {
        protectEnglish: false,
        force: true,
        lang: lang === 'FR' ? 'fr' : lang === 'ES' ? 'es' : '',
        label: legacyAs === 'romanized' ? 'Romanized' : 'As sung',
        role: 'primary',
        displayPrimary: legacyAs === 'romanized' ? 'romanized' : 'sung',
        displaySecondary: null,
        legacyAs: 'sung',
      }
    );
  }

  const primaryKey = (existing.display && existing.display.primary)
    || (existing.tracks && existing.tracks.romanized ? 'romanized' : 'sung');

  const merged = library.mergeLyricTrack(
    existing,
    {
      lines: englishLines,
      alignMode: 'translation|' + provider,
      videoId: String(videoId).replace(/-karaoke$/, ''),
      duration: existing.duration,
    },
    'english',
    {
      protectEnglish: false,
      force: true,
      lang: 'en',
      label: 'English',
      role: 'translation',
      displayPrimary: primaryKey === 'english' ? 'sung' : primaryKey,
      displaySecondary: 'english',
      displayTertiary: (existing.display && existing.display.tertiary)
        || (existing.tracks && existing.tracks.native ? 'native'
          : (existing.tracks && existing.tracks.sung && primaryKey === 'romanized' ? 'sung' : null)),
      legacyAs: 'sung',
    }
  );

  try {
    const bak = pack.path + '.pre-english-bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(pack.path, bak);
    fs.writeFileSync(pack.path, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: 'Failed to write LRC: ' + e.message };
  }

  return {
    ok: true,
    videoId,
    path: pack.path,
    provider,
    lineCount: englishLines.length,
    primaryTrack: merged.primaryTrack || primaryKey,
    secondaryTrack: 'english',
    display: merged.display,
  };
}

module.exports = {
  looksMostlyEnglish,
  detectSourceLang,
  buildEnglishLines,
  translateLines,
  previewEnglishTranslation,
  addEnglishTrack,
  getPrimaryLyrics,
};
