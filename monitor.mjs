#!/usr/bin/env node
/*
 * BookMyShow -> Telegram alert monitor
 * Avengers: Doomsday (Hyderabad), specific theatres / formats / date.
 *
 * Modes:
 *   node monitor.mjs            run one check cycle (used by launchd every 5 min)
 *   node monitor.mjs --test     send a test Telegram message (confirms phone alerts work)
 *   node monitor.mjs --getid    print recent chat IDs that have messaged your bot
 *   node monitor.mjs --once     run one check, printing verbose results to the console
 *
 * Alerts are de-duplicated: each target fires at most once per "signature" so you
 * don't get the same alert every 5 minutes. Delete state.json to reset.
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

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    log("ERROR: config.json not found at", CONFIG_PATH);
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

  // Environment overrides (used in CI / GitHub Actions so secrets are never committed).
  cfg.telegram = cfg.telegram || {};
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
  if (process.env.MOVIE_URL) cfg.movieUrl = process.env.MOVIE_URL;
  if (process.env.BMS_DATE) cfg.date = process.env.BMS_DATE;

  return cfg;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { alerted: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { alerted: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- Telegram ----------

async function tgApi(token, method, params) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}

async function sendTelegram(cfg, text) {
  const { botToken, chatId } = cfg.telegram || {};
  if (!botToken || botToken.startsWith("PASTE") || !chatId || String(chatId).startsWith("PASTE")) {
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
  if (!botToken || botToken.startsWith("PASTE")) {
    console.log("Set telegram.botToken in config.json first.");
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
    if (chat) {
      const key = `${chat.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`chat_id: ${chat.id}  (${chat.type}${chat.username ? " @" + chat.username : ""}${chat.first_name ? " " + chat.first_name : ""})`);
      }
    }
  }
  if (seen.size === 0) {
    console.log("No updates yet. Open your bot in Telegram and send it /start, then run this again.");
  }
}

// ---------- Scraping ----------

async function scrapeShowtimes(cfg) {
  // Lazy import so --test / --getid work even before Chromium is installed.
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
    // Give client-side rendering a moment.
    await page.waitForTimeout(6000);

    // Try to select the target date tab if a date was given and the page has date tabs.
    try {
      const d = new Date(cfg.date + "T00:00:00");
      const dayNum = String(d.getDate());
      const monShort = d.toLocaleString("en-US", { month: "short" }).toUpperCase(); // e.g. DEC
      // BMS date strip renders day numbers; click the one matching our target day if visible.
      const clicked = await page.evaluate(({ dayNum, monShort }) => {
        const nodes = Array.from(document.querySelectorAll("a,div,li,span,button"));
        for (const n of nodes) {
          const t = (n.innerText || "").trim().toUpperCase();
          if (!t) continue;
          if (t.includes(dayNum) && (t.includes(monShort) || t.length <= 4)) {
            const rect = n.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top < 400) {
              n.click();
              return t;
            }
          }
        }
        return null;
      }, { dayNum, monShort });
      if (clicked) {
        await page.waitForTimeout(4000);
      }
    } catch (e) {
      // non-fatal
    }

    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const finalUrl = page.url();
    return { bodyText, finalUrl };
  } finally {
    await browser.close();
  }
}

// Search a window of text after each venue mention for format/time/language tokens.
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

    // Window of text around the venue mention (venues list their shows right after the name).
    const windowText = haystack.slice(venueIdx, venueIdx + 1500);
    const windowLower = windowText.toLowerCase();

    const formatHit = target.formatMatch.find((f) => windowLower.includes(f.toLowerCase())) || null;
    const langHit =
      !cfg.languages || cfg.languages.length === 0
        ? "any"
        : cfg.languages.find((l) => windowLower.includes(l.toLowerCase())) || null;

    // Pull showtime-looking tokens (e.g. 09:45 PM, 11:30 PM) from the window.
    const times = Array.from(
      new Set((windowText.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)\b/g) || []).map((s) => s.toUpperCase().replace(/\s+/, " ")))
    ).slice(0, 12);

    const available = !!formatHit && (langHit !== null) && times.length > 0;

    results.push({
      target,
      found: true,
      matchedVenue,
      formatHit,
      langHit,
      times,
      available,
      snippet: windowText.slice(0, 300).replace(/\n{2,}/g, "\n"),
    });
  }
  return results;
}

function buildAlert(r, cfg) {
  const times = r.times && r.times.length ? r.times.join(", ") : "(times shown on page)";
  return (
    `🎬 <b>Avengers: Doomsday — tickets available!</b>\n\n` +
    `<b>${escapeHtml(r.target.label)}</b>\n` +
    `📅 ${escapeHtml(cfg.date)}  |  🗣️ ${escapeHtml(r.langHit === "any" ? "English" : r.langHit)}  |  🎞️ ${escapeHtml(r.formatHit || "")}\n` +
    `🕘 Shows: ${escapeHtml(times)}\n\n` +
    `👉 Book now (pick middle seats): ${cfg.movieUrl}\n\n` +
    `<i>Grab seats fast — big shows sell out in minutes.</i>`
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Main ----------

async function main() {
  const cfg = loadConfig();

  if (MODE_GETID) {
    await getChatIds(cfg);
    return;
  }

  if (MODE_TEST) {
    const ok = await sendTelegram(
      cfg,
      "✅ <b>BMS alert bot is working.</b>\nYou'll get a message here the moment Avengers: Doomsday shows open at your target theatres."
    );
    log(ok ? "Test message sent." : "Test message NOT sent (check config / logs above).");
    return;
  }

  if (!cfg.movieUrl || cfg.movieUrl.startsWith("PASTE")) {
    log("movieUrl not set in config.json yet — skipping check cycle.");
    return;
  }

  const state = loadState();
  state.alerted = state.alerted || {};

  let scrape;
  try {
    scrape = await scrapeShowtimes(cfg);
  } catch (e) {
    log("Scrape error (will retry next cycle):", e.message);
    return;
  }

  const results = analyze(scrape.bodyText, cfg);

  for (const r of results) {
    if (MODE_VERBOSE) log("RESULT:", JSON.stringify({ ...r, snippet: undefined, target: r.target.label }, null, 2));
    if (!r.found) {
      log(`[${r.target.label}] not found on page (${r.reason}).`);
      continue;
    }
    log(
      `[${r.target.label}] found. format=${r.formatHit || "-"} lang=${r.langHit || "-"} times=${(r.times || []).length} available=${r.available}`
    );

    if (r.available) {
      const sig = `${r.target.label}|${cfg.date}|${r.formatHit}`;
      if (state.alerted[sig]) {
        log(`  already alerted for "${sig}" — skipping.`);
        continue;
      }
      const ok = await sendTelegram(cfg, buildAlert(r, cfg));
      if (ok) {
        state.alerted[sig] = new Date().toISOString();
        saveState(state);
        log(`  ALERT SENT and recorded: ${sig}`);
      }
    }
  }
}

main().catch((e) => {
  log("Fatal:", e.stack || e.message);
  process.exit(0);
});
