# AURELIA — Setup

This is a from-scratch deployment guide. If you already have
`motionsalt-headless` running, the GitHub PAT and Deriv tokens carry over
unchanged; you just need to add the Gemini step.

---

## 0. Prerequisites

- A Deriv account (demo + real loginids).
- A Telegram bot from `@BotFather`, and your personal chat id.
- A Google AI Studio account with at least one Gemini API key.
- A GitHub account; create a NEW empty repo for AURELIA. Do not push into
  the `motionsalt-headless` repo — the spec is explicit that this is a
  separate bot running side by side.
- A Cloudflare account for the Worker (free tier is fine).

---

## 1. Create the repo

```bash
git init aurelia
cd aurelia
# copy the contents of this archive into the new repo
git add .
git commit -m "init: AURELIA scaffold"
git remote add origin https://github.com/<you>/aurelia.git
git push -u origin main
```

---

## 2. GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**
and add:

| Name                 | Value                                              |
|----------------------|----------------------------------------------------|
| `DERIV_BEARER_TOKEN` | Your Deriv OAuth bearer token                      |
| `DERIV_APP_ID`       | Deriv app id (e.g. `1089` for testing)             |
| `DERIV_REAL_ID`      | Your `ROT...` real loginid                         |
| `DERIV_DEMO_ID`      | Your `DOT...` demo loginid                         |
| `TELEGRAM_BOT_TOKEN` | From BotFather                                     |
| `TELEGRAM_CHAT_ID`   | Your numeric chat id                               |
| `PAT_TOKEN`          | A PAT with **`repo`** + **Actions secrets write**  |
| `GEMINI_KEY_PRIMARY` | A real Gemini API key (you can add more via TG)    |

The PAT scopes specifically:
- Classic PAT: `repo` (full) and on a "Fine-grained" PAT enable
  **Actions → Read & write** and **Secrets → Read & write** for this
  repository.

Once the secret is added, also append its name to `config.ai.key_registry`
in `config.json`:

```json
"ai": {
  "key_registry": ["GEMINI_KEY_PRIMARY"]
}
```

(After that you can `/addkey` more from Telegram and it'll do this
automatically.)

---

## 3. Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

In the Cloudflare dashboard, open the worker → **Settings → Variables**
and add as plain text vars (or use `wrangler secret put`):

| Name                 | Example                                            |
|----------------------|----------------------------------------------------|
| `TELEGRAM_BOT_TOKEN` | …                                                  |
| `TELEGRAM_CHAT_ID`   | …                                                  |
| `GITHUB_PAT`         | Same PAT as above                                  |
| `GITHUB_OWNER`       | e.g. `motionssalt`                                 |
| `GITHUB_REPO`        | `aurelia`                                          |
| `GITHUB_WORKFLOW`    | `aurelia-cron.yml`                                 |
| `GITHUB_REF`         | `main`                                             |

Then point Telegram at the worker URL:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<worker_url>
```

---

## 4. First run

In Telegram, send `/menu`. You should see the AURELIA menu with 🟡 DEMO
badge. Try:

```
/status         ← state file readable?
/listkeys       ← Gemini key registered?
/scan           ← fire one manual AI trade (demo)
```

When you're satisfied:

```
/setcapital 100
/settp 20
/setsl 20
/startcycle
```

The bot will run the cycle until TP or SL is hit, then halt itself.

---

## 5. Going live

```
/mode real
/startcycle
```

The badge in every message flips to 🔴 REAL. There is intentionally no
single-click "real mode" — you must type or tap it explicitly. The TP/SL
session envelope is enforced in code regardless of mode.

---

## 6. Troubleshooting

- **"No Gemini keys registered"** — add one via `/addkey NAME VALUE`.
- **All keys benched** — check `last-status.json → ai_keys_bench`; the
  runner will still try the least-recently-benched one as a last resort,
  but you may need to add a fresh key.
- **Cycle not firing** — `/status` shows whether the session is active
  and what `next_cycle_eligible_at` is. The worker triggers ticks via
  `workflow_dispatch` after each settlement.
- **Webhook not receiving updates** — `getWebhookInfo` from the BotFather
  URL pattern will show the last error.
