#!/usr/bin/env node
/*
 * BookMyShow -> Telegram alert monitor
 * Avengers: Doomsday (Hyderabad) — SPECIFIC premium screens only:
 *   - Prasads Multiplex, Screen 6 (PCX)
 *   - Allu Cinemas Kokapet, Screen 1 (Dolby Cinema)
 *
 * The showtimes already live at these venues (Infinity Vision 3D on OTHER screens)
 * are treated as a baseline and never alerted on. We alert when:
 *   (a) a premium label (PCX / Dolby Cinema) appears at the target venue, OR
 *   (b) ANY new show type appears at the target venue (safety net, in case BMS
 *       labels the premium screen in a way we didn't predict).
 *
 * Modes:
 *   node monitor.mjs            run one check cycle (used by CI every 5 min)
 *   node monitor.mjs --test     send a test Telegram message
 *   node monitor.mjs --getid    print chat IDs that have messaged your bot
 *   node monitor.mjs --once     run one check, printing verbose results
 *   node monitor.mjs --baseline just record current formats as baseline, no alerts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const STATE_PATH = join(__dirname, "state.json");

const args = process.argv.slice(2);
const MODE_TEST = args.includes("--test");
const MODE_GETID = args.includes("--getid");
const MODE_VERBOSE = args.includes("--once") || args.includes("--verbose");
const MODE_BASELINE = args.includes("--baseline");

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    log("ERROR: config.json not found at", CONFIG_PATH);
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  cfg.telegram = cfg.telegram || {};
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
  if (process.env.MOVIE_URL) cfg.movieUrl = process.env.MOVIE_URL;
  if (process.env.BMS_DATE) cfg.date = process.env.BMS_DATE;
  return cfg;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { baseline: {}, alerted: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    s.baseline = s.baseline || {};
    s.alerted = s.alerted || {};
    return s;
  } catch {
    return { baseline: {}, alerted: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- Telegram ----------

async function tgApi(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}

async function sendTelegram(cfg, text) {
  const { botToken, chatId } = cfg.telegram || {};
  const placeholder = /^(PASTE|SET_VIA)/i;
  const configured =
    botToken && botToken.includes(":") && !placeholder.test(botToken) &&
    chatId && !placeholder.test(String(chatId));
  if (!configured) {
    log("Telegram not configured yet — would have sent:\n" + text);
    return false;
  }
  const r = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
  if (!r.ok) log("Telegram send failed:", JSON.stringify(r));
  return r.ok;
}

async function getChatIds(cfg) {
  const { botToken } = cfg.telegram || {};
  if (!botToken || botToken.includes("PASTE") || botToken.includes("SET_VIA")) {
    console.log("Set telegram.botToken (or TELEGRAM_BOT_TOKEN env) first.");
    return;
  }
  const r = await tgApi(botToken, "getUpdates", {});
  if (!r.ok) {
    console.log("getUpdates failed:", JSON.stringify(r));
    return;
  }
  const seen = new Set();
  for (const u of r.result || []) {
    const chat = u.message?.chat || u.edited_message?.chat || u.my_chat_member?.chat;
    if (chat && !seen.has(`${chat.id}`)) {
      seen.add(`${chat.id}`);
      console.log(`chat_id: ${chat.id}  (${chat.type}${chat.username ? " @" + chat.username : ""}${chat.first_name ? " " + chat.first_name : ""})`);
    }
  }
  if (seen.size === 0) {
    console.log("No updates yet. Open your bot in Telegram, send it /start, then run this again.");
  }
}

// ---------- Scraping ----------

async function scrapeShowtimes(cfg) {
  // Test hook: feed page text from a file instead of launching a browser.
  if (process.env.MOCK_BODY_FILE) {
    return { bodyText: readFileSync(process.env.MOCK_BODY_FILE, "utf8"), finalUrl: "mock" };
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(cfg.movieUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(7000);
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    return { bodyText, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

// ---------- Analysis ----------

const TIME_RE = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/i;

// Normalize a format label for stable comparison across scrapes.
const norm = (l) => String(l).toUpperCase().replace(/\s+/g, " ").trim();

// Pull the distinct format/audio labels out of a venue block (everything that
// isn't the venue name line, "Non-cancellable", a showtime, or an offer line).
function extractFormatLabels(blockText) {
  const labels = [];
  for (let raw of blockText.split("\n")) {
    const ln = raw.trim();
    if (!ln) continue;
    if (TIME_RE.test(ln) && ln.length <= 9) continue; // a bare showtime
    if (/non-cancellable/i.test(ln)) continue;
    if (/(code:|off for|rs\.?\s*\d|% off|first-time)/i.test(ln)) continue; // offers
    if (/:/.test(ln) && /(cinemas|multiplex|hyderabad|kokapet|ameerpet|mall|cinepolis|pvr|inox|imax)/i.test(ln)) continue; // venue line
    labels.push(ln);
  }
  return Array.from(new Set(labels));
}

function analyze(bodyText, cfg) {
  const haystack = bodyText || "";
  const lower = haystack.toLowerCase();
  const results = [];

  for (const target of cfg.targets) {
    let venueIdx = -1;
    let matchedVenue = null;
    for (const v of target.venueMatch) {
      const i = lower.indexOf(v.toLowerCase());
      if (i !== -1 && (venueIdx === -1 || i < venueIdx)) {
        venueIdx = i;
        matchedVenue = v;
      }
    }
    if (venueIdx === -1) {
      results.push({ target, found: false, reason: "venue not on page" });
      continue;
    }

    // Bound the block to THIS venue: next venue begins at the next "Non-cancellable".
    const ownNC = lower.indexOf("non-cancellable", venueIdx);
    let blockEnd;
    if (ownNC === -1) {
      blockEnd = Math.min(haystack.length, venueIdx + 1200);
    } else {
      const nextNC = lower.indexOf("non-cancellable", ownNC + 15);
      if (nextNC === -1) {
        blockEnd = Math.min(haystack.length, venueIdx + 1200);
      } else {
        const nlBeforeName = haystack.lastIndexOf("\n", nextNC - 2);
        blockEnd = nlBeforeName > venueIdx ? nlBeforeName : Math.min(haystack.length, venueIdx + 1200);
      }
    }

    const block = haystack.slice(venueIdx, blockEnd);
    const blockLower = block.toLowerCase();

    const premiumHit = (target.premiumMatch || []).find((p) => blockLower.includes(p.toLowerCase())) || null;
    const langOk =
      !cfg.languages || cfg.languages.length === 0
        ? true
        : cfg.languages.some((l) => blockLower.includes(l.toLowerCase()));
    const times = Array.from(
      new Set((block.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/gi) || []).map((s) => s.toUpperCase().replace(/\s+/, " ")))
    );
    const formatLabels = extractFormatLabels(block);

    results.push({ target, found: true, matchedVenue, premiumHit, langOk, times, formatLabels, block });
  }
  return results;
}

// ---------- Alerts ----------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function premiumAlert(r, cfg) {
  return (
    `🎯 <b>YOUR SCREEN IS OPEN — Avengers: Doomsday</b>\n\n` +
    `<b>${escapeHtml(r.target.label)}</b>\n` +
    `Detected format: <b>${escapeHtml(r.premiumHit)}</b>\n` +
    `📅 ${escapeHtml(cfg.date)} · 🗣️ English\n` +
    `🕘 Showtimes at this venue: ${escapeHtml((r.times || []).join(", ") || "see page")}\n\n` +
    `👉 BOOK NOW (grab middle seats): ${cfg.movieUrl}`
  );
}

function newFormatAlert(r, cfg, fresh) {
  return (
    `🆕 <b>New show type at ${escapeHtml(r.matchedVenue)} — check if it's your screen!</b>\n\n` +
    `<b>${escapeHtml(r.target.label)}</b>\n` +
    `New format(s) just listed: <b>${escapeHtml(fresh.join(" | "))}</b>\n` +
    `📅 ${escapeHtml(cfg.date)} · 🗣️ English\n` +
    `🕘 Venue showtimes: ${escapeHtml((r.times || []).join(", ") || "see page")}\n\n` +
    `👉 Open to verify & book: ${cfg.movieUrl}`
  );
}

// ---------- Main ----------

async function main() {
  const cfg = loadConfig();

  if (MODE_GETID) return getChatIds(cfg);

  if (MODE_TEST) {
    const ok = await sendTelegram(
      cfg,
      "✅ <b>BMS alert bot is live.</b>\nI'm watching for your Prasads Screen 6 (PCX) and Allu Screen 1 (Dolby Cinema) shows for 17 Dec. You'll get a ping here the moment either opens."
    );
    log(ok ? "Test message sent." : "Test message NOT sent (check config/logs).");
    return;
  }

  if (!cfg.movieUrl || cfg.movieUrl.startsWith("PASTE")) {
    log("movieUrl not set — skipping.");
    return;
  }

  const state = loadState();

  let scrape;
  try {
    scrape = await scrapeShowtimes(cfg);
  } catch (e) {
    log("Scrape error (will retry next cycle):", e.message);
    return;
  }

  const results = analyze(scrape.bodyText, cfg);
  const now = new Date().toISOString();

  for (const r of results) {
    if (!r.found) {
      log(`[${r.target.label}] venue not on page this cycle.`);
      continue;
    }

    const key = r.target.label;
    const prev = state.baseline[key] || null; // null = never seen before
    const cur = r.formatLabels;

    if (MODE_VERBOSE) {
      log(`RESULT [${key}]`, JSON.stringify({ matchedVenue: r.matchedVenue, premiumHit: r.premiumHit, langOk: r.langOk, labels: cur, times: r.times }, null, 2));
    } else {
      log(`[${key}] premium=${r.premiumHit || "-"} labels=${JSON.stringify(cur)}`);
    }

    if (MODE_BASELINE) {
      state.baseline[key] = cur;
      saveState(state);
      continue;
    }

    let fired = false;

    // (a) precise premium trigger
    if (r.premiumHit && r.langOk) {
      const sig = `premium|${key}|${r.premiumHit}`;
      if (!state.alerted[sig]) {
        if (await sendTelegram(cfg, premiumAlert(r, cfg))) {
          state.alerted[sig] = now;
          fired = true;
          log(`  >>> PREMIUM ALERT sent: ${sig}`);
        }
      } else {
        log(`  premium already alerted (${sig}).`);
      }
    }

    // (b) safety net: a NEW format label appeared (only once we have a baseline)
    if (!fired && prev && r.target.alertOnNewFormat && r.langOk) {
      const prevSet = new Set(prev.map(norm));
      const fresh = cur.filter((l) => !prevSet.has(norm(l)));
      if (fresh.length) {
        const sig = `new|${key}|${fresh.slice().sort().join("~")}`;
        if (!state.alerted[sig]) {
          if (await sendTelegram(cfg, newFormatAlert(r, cfg, fresh))) {
            state.alerted[sig] = now;
            log(`  >>> NEW-FORMAT ALERT sent: ${sig}`);
          }
        }
      }
    }

    // Grow the baseline (store normalized; existing labels never re-alert).
    state.baseline[key] = Array.from(new Set([...(prev || []), ...cur.map(norm)]));
    saveState(state);
  }
}

main().catch((e) => {
  log("Fatal:", e.stack || e.message);
  process.exit(0);
});
