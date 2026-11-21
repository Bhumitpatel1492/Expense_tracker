# Expense Tracker

A simple personal income and expense tracker in white and orange, built as an installable web app (PWA) for Android.

- **Dashboard**: monthly balance, income and expense, today's spending, expense by category, and a 6-month trend.
- **Income / Expense tabs**: filter by date, month, year, date range or all time, plus category and search.
- **Categories**: add or delete them in Settings, or straight from the add-entry form (**+ New**).
- **Reminders**: push notifications every day at **6:35 PM, 10:00 PM and 11:00 PM** IST.
- **Login**: one fixed mobile number and password.
- **Storage**: `data.json` in your own **private** GitHub repo (`expense-data`), saved through the GitHub API.
- Works offline. Changes made offline sync when the phone is back online.

## How it fits together

```
expense-tracker (public, GitHub Pages)      expense-data (PRIVATE)
  index.html / app.js / sw.js   ── API ──▶   data.json            ← your entries
  config.js (encrypted token)                subscriptions.json   ← phones for reminders
                                             .github/workflows/reminders.yml (cron → push)
```

`config.js` holds no readable secrets. The GitHub token and the login check are AES-GCM encrypted with a key
derived from `mobile:password` (PBKDF2, 310k iterations), so only the correct login can decrypt the token.
Your data lives only in the private repo.

## One-time setup

1. **Private data repo**: create `expense-data` (private) from the `expense-data` folder.
   Add these Actions secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (both from `../secrets/vapid.json`) and
   `VAPID_SUBJECT` (your app URL, e.g. `https://<user>.github.io/expense-tracker/`).
2. **Token**: create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>
   - Repository access: **Only select repositories** → `expense-data`
   - Permissions: **Contents → Read and write** (nothing else)
   - Expiration: the longest option available
3. **Config**: run `node tools/setup.mjs`. Enter the mobile number, password, `<user>/expense-data` and the token.
   Commit and push `config.js`.
4. **Pages**: in the `expense-tracker` repo, open Settings → Pages → Deploy from branch → `main` / root.
5. **Phone**: open the Pages URL in Chrome → Login → ⋮ menu → **Add to Home screen / Install**.
   Then go to Settings → Reminders → **Turn on**.

Test a reminder now: `expense-data` → Actions → *Daily expense reminders* → **Run workflow**.

## Notes

- GitHub's scheduled workflows can start a few minutes late (sometimes 10–20 minutes) at busy times.
- If the token expires, create a new one and run `node tools/setup.mjs` again.
- To change the login, run `node tools/setup.mjs` again with the new mobile number and password.
- Local testing: `node tools/serve.mjs`, then open <http://localhost:5173>.
- Icons: `node tools/make-icons.mjs`. VAPID keys: `node tools/vapid.mjs <file>`.
