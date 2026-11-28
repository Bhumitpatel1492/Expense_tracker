# Expense Tracker

A simple income and expense tracker for a small group of people (white and orange theme), built as an installable web app (PWA) for Android. Each user has their own login and their own private data.

- **Dashboard**: monthly balance, income and expense, today's spending, expense by category, and a 6-month trend.
- **Income / Expense tabs**: filter by date, month, year, date range or all time, plus category and search.
- **Categories**: each user manages their own (Settings, or **+ New** in the add form).
- **Reminders**: push notifications every day at **6:35 PM, 10:00 PM and 11:00 PM** IST, with each user's own totals.
- **Works offline**: changes sync when the phone is back online.

## How it works

| Part | Where |
|---|---|
| App (this repo) | GitHub Pages: https://bhumitpatel1492.github.io/Expense_tracker/ |
| Logins | Firebase Authentication. The mobile number is the username, plus a password. |
| Data | Cloud Firestore: `users/{uid}` (profile + categories), `users/{uid}/transactions`, `users/{uid}/devices` |
| Privacy | `firebase/firestore.rules`: a user can only read and write their own documents |
| Sign-up | Needs the invite code stored in Firestore at `config/app → inviteCode` |
| Reminders | GitHub Actions cron in the private `Expense_tracker_backend` repo sends Firebase Cloud Messaging pushes |

`config.js` holds the Firebase web settings. These are public by design; access is protected by login and the security rules.

## Adding a friend

Share the app link and the invite code. They open the link, tap **Sign up**, and enter their name, mobile number, password and the invite code.

To change the invite code: Firebase console → Firestore → `config` → `app` → edit `inviteCode`.

## Reminders setup (once)

`Expense_tracker_backend` needs the Actions secret `FIREBASE_SERVICE_ACCOUNT`, containing the JSON from Firebase console → Project settings → Service accounts → **Generate new private key**.

Test it now: backend repo → Actions → *Daily expense reminders* → **Run workflow**.

## Local testing

```bash
node tools/serve.mjs
```

Then open http://localhost:5173.
