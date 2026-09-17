# One site: academy.aininjas.com serves everything

Teachers and students see a single site. Quiz Studio lives at **academy.aininjas.com/assess/…** and Accounts at
**academy.aininjas.com/account/…**; the Academy's own menu (My courses · Classes · Assessments · …) stays at the top of
every page, and Quiz Studio's / Accounts' pages appear as a strip of tabs beneath it. Nobody sees
`assessment.aininjas.com` or `accounts.aininjas.com` any more — old links on those hostnames forward to the new address,
so printed entry links and activation emails keep working.

## How it works

```
browser ── academy.aininjas.com ──► Academy (Node)
                                      ├─ /assess/*   ──proxy──► Quiz Studio  (Railway private network)
                                      ├─ /account/*  ──proxy──► Accounts     (Railway private network)
                                      └─ everything else: the Academy itself
```

* **Academy** (`src/onesite.js`, `src/proxy.js`, `src/shell.js`): when `QUIZ_STUDIO_INTERNAL_URL` / `ACCOUNTS_INTERNAL_URL`
  are set, requests under `/assess` and `/account` are streamed to those services. Each forwarded request carries
  `X-AIN-Shell` (the Academy's menu for the signed-in person) and `X-AIN-Proxy` (a shared secret so the other app
  knows the header is genuine). Quiz launches, live-quiz joins and the Account link all point at the `/assess` and
  `/account` paths. Logging out of the Academy also clears the Quiz Studio / Accounts cookies, since they now live on
  the same domain.
* **Quiz Studio** and **Accounts** (`lib/basepath.js`): a `BASE_URL` with a path (`https://academy.aininjas.com/assess`)
  puts the app in one-site mode. Every route is served under that prefix, redirects get the prefix, and root-relative
  URLs in the pages, scripts and stylesheets it serves (`/api/…`, `/admin/…`, `/q/…`) are rewritten on the way out.
  The app still answers without the prefix on its private address, so server-to-server calls
  (`/api/sso/quizzes`, `/api/v1/grants`, sync webhooks) are unchanged. Pages opened through the Academy render the
  Academy's header and their own tabs (`shell` in `/api/me` for Quiz Studio; `locals.shell` in Accounts' header partial).
  When someone visiting Quiz Studio is signed in to the Academy but not yet to Quiz Studio, they go straight through
  single sign-on instead of seeing a login page.
* Without the new variables nothing changes: each app runs on its own hostname exactly as before, which is also how
  the apps run locally from the `.bat` files.

## Railway setup (one time)

Service names below are placeholders — use the names shown in your Railway project (Settings → Networking → Private
Networking on each service). Two things that bit us on the first rollout:

* Internal URLs must start with `http://` — `aininjas-accounts.railway.internal:5000` on its own is not a URL and is ignored
  (the Academy logs `[one site] … is not a valid URL`).
* The port is the one the app actually listens on. Railway injects its own `PORT` (it was 8080 on Accounts) when a service
  has none set, so either set `PORT=5000` on Accounts and `PORT=4000` on Quiz Studio, or use Railway's number in the
  internal URL. A mismatch shows up as `[proxy /account] … ECONNREFUSED` in the Academy log and the "That part of the
  Academy is waking up" page in the browser.

**1. Academy service** — add:

| Variable | Value |
| --- | --- |
| `QUIZ_STUDIO_INTERNAL_URL` | `http://aininjas-quiz-studio.railway.internal:4000` |
| `ACCOUNTS_INTERNAL_URL` | `http://aininjas-accounts.railway.internal:5000` |
| `ACCOUNTS_URL` | can stay as it is — with the internal URL set, the Academy uses `https://academy.aininjas.com/account` for sign-in |

`QUIZ_LAUNCH_SECRET` and `SSO_SECRET` stay as they are; they double as the proxy's proof to the other apps.

**2. Quiz Studio service** — change / add:

| Variable | Value |
| --- | --- |
| `BASE_URL` | `https://academy.aininjas.com/assess` |
| `ACCOUNTS_URL` | `https://academy.aininjas.com/account` |
| `ACCOUNTS_INTERNAL_URL` | `http://aininjas-accounts.railway.internal:5000` |
| `REDIRECT_FROM_HOSTS` | `assessment.aininjas.com` |
| `ACADEMY_URL` | `https://academy.aininjas.com` (as before) |
| `PORT` | `4000` (must match the port in the Academy's `QUIZ_STUDIO_INTERNAL_URL`) |

**3. Accounts service** — change / add:

| Variable | Value |
| --- | --- |
| `BASE_URL` | `https://academy.aininjas.com/account` |
| `REDIRECT_FROM_HOSTS` | `accounts.aininjas.com` |
| `PORT` | `5000` (must match the port in the Academy's `ACCOUNTS_INTERNAL_URL`) |

**4. In Accounts → Admin → Apps**, edit the *Quiz Studio* app and set its base URL to
`https://academy.aininjas.com/assess` (login, callback and sync paths stay `/auth/sso`, `/auth/sso/callback`,
`/api/sso/sync`). The *Academy* app keeps `https://academy.aininjas.com`.

**5. Deploy** all three (push each repo; Railway redeploys). Order doesn't matter, but expect a minute of
"That part of the Academy is waking up" until all three are up.

**6. Check**: `https://academy.aininjas.com/assess/healthz` should show `"base_path":"/assess"`, and
`https://academy.aininjas.com/account/healthz` should answer. Sign in as a teacher: the Assessments menu item opens
Results at an `academy.aininjas.com/assess/…` address with the Academy header on top.

Keep the `assessment.aininjas.com` and `accounts.aininjas.com` custom domains attached to their services — that is
what makes the old links forward. Everyone signs in once more after the switch (their sign-in cookie moves to the
new domain).

## Local run (three terminals, or the .bat files)

Local development doesn't need one-site mode, but to try it:

```powershell
# Accounts (in aininjas-accounts)
$env:PORT=5000; $env:BASE_URL="http://localhost:3000/account"; & "C:\Program Files\nodejs\npm.cmd" start
# Quiz Studio (in aininjas-quiz-studio)
$env:PORT=4000; $env:BASE_URL="http://localhost:3000/assess"; $env:ACCOUNTS_URL="http://localhost:3000/account"; $env:ACCOUNTS_INTERNAL_URL="http://localhost:5000"; & "C:\Program Files\nodejs\npm.cmd" start
# Academy (in aininjas-lms)
$env:PORT=3000; $env:QUIZ_STUDIO_INTERNAL_URL="http://localhost:4000"; $env:ACCOUNTS_INTERNAL_URL="http://localhost:5000"; & "C:\Program Files\nodejs\npm.cmd" start
```

Then open http://localhost:3000 — everything, including sign-in, happens on port 3000.

## Adding another app later

Register it in Accounts, give it its own `basepath` prefix (copy `lib/basepath.js`), and add one more
`proxy.mount(...)` line in the Academy's `server.js` with an `<APP>_INTERNAL_URL` variable.
