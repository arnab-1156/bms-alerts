# BMS Alerts — Avengers: Doomsday (Hyderabad)

Checks BookMyShow every 5 minutes (headless Chromium via Playwright) for shows at your
target theatres/formats on your target date, and pushes a **Telegram** alert to your phone
the moment they're bookable. You book the seats yourself (middle rows) via the link in the alert.

## Setup (3 things)

1. **Telegram bot** — in Telegram, message **@BotFather** → `/newbot` → copy the token.
   Then message your new bot `/start`. Get your numeric chat id by messaging **@userinfobot**,
   or run `npm run get-chat-id`. Put both into `config.json` under `telegram`.
2. **Movie URL** — open the Avengers: Doomsday Hyderabad showtimes page on BookMyShow,
   select **17 Dec 2026**, copy the URL into `movieUrl` in `config.json`.
3. **Test** — `npm run test-alert` should ping your phone.

## Config

Edit `config.json`: `telegram`, `movieUrl`, `date`, `languages`, and `targets`
(venue + format substrings, case-insensitive, matched within each venue's block).

## Commands

```bash
npm run monitor        # one check cycle (what launchd runs)
npm run test-alert     # send a test Telegram message
npm run get-chat-id    # list chat ids that have messaged your bot
node monitor.mjs --once   # verbose single run (debugging)
```

## Scheduling (launchd, every 5 min)

Installed as the user LaunchAgent `com.bmsalerts.monitor`.

```bash
launchctl list | grep bmsalerts                                   # is it loaded?
launchctl kickstart -k gui/$(id -u)/com.bmsalerts.monitor         # force a run now
launchctl bootout gui/$(id -u)/com.bmsalerts.monitor              # stop it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bmsalerts.monitor.plist  # start it
```

Logs: `logs/run.log` (script), `logs/launchd.*.log` (scheduler).
Alert de-dup state: `state.json` (delete to re-arm all alerts).

## Caveats

- **Laptop must be awake & online** for launchd to fire. Keep it plugged in and set
  Settings → Battery/Lock Screen so it doesn't sleep (or run `caffeinate -s`).
- 5-min polling may miss the very first sell-out burst; it's built to catch new
  shows/returns reliably over the weeks until release.
- BMS can change page structure; if alerts look wrong, re-tune `targets`/selectors.
