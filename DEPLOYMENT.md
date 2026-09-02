# Adding the LMS to aininjas.com — deployment & integration plan

## The shape of it

Run the LMS at **learn.aininjas.com** as its own app, and let the marketing site (aininjas.com — WordPress, Webflow, Wix, Framer, a custom site, whatever you end up choosing) link into it. This is how Coursera, Kajabi, and every school's "Canvas" work: the public site sells and explains, the learning app does the logged-in work. It keeps the LMS independent of whichever site builder you pick, avoids iframe/cookie headaches, and means a redesign of aininjas.com never touches learner data.

```
aininjas.com  (marketing site)                 learn.aininjas.com  (this app)
┌───────────────────────────────┐              ┌──────────────────────────────┐
│ Home · Curriculum · Pricing   │  "Log in"    │ /login  /request-access      │
│ [Request access]  [Log in] ───┼─────────────▶│ /dashboard  (learner)        │
│ /courses  (course cards) ─────┼──────────────▶ /courses/:id  → SCORM player  │
│ /leaderboard widget ◀─────────┼── JSON API ──│ /plugins/leaderboard/api     │
└───────────────────────────────┘              │ /admin  (you)                │
                                               └──────────────────────────────┘
```

## Step 1 — Host the app (about 30 minutes)

Pick one. All three give you HTTPS automatically.

**Option A · Railway / Render (simplest, ~$5–10/mo).** Push the repo to GitHub, create a new service from it, add a persistent volume mounted at `/data`, and set the environment variables below. Both detect the `Dockerfile`. Render: "Web Service → Docker → add Disk (1 GB) at /data".

**Option B · A VPS (Hetzner / DigitalOcean, ~$6/mo).** Install Docker, clone the repo, `cp .env.example .env`, edit it, then `docker compose up -d`. Put Caddy in front for TLS:

```
learn.aininjas.com {
    reverse_proxy localhost:3000
}
```

**Option C · Fly.io.** `fly launch` (uses the Dockerfile), `fly volumes create lms_data --size 1`, mount it at `/data`, `fly secrets set …`.

Environment variables to set in production:

```
BASE_URL=https://learn.aininjas.com
SESSION_SECRET=<64 random chars — `openssl rand -hex 32`>
DATA_DIR=/data
ADMIN_EMAIL=you@aininjas.com
ADMIN_PASSWORD=<strong password — change it after first login>
SITE_NAME=AI Ninjas Academy
MAIN_SITE_URL=https://aininjas.com
```

Back up `/data` (it holds `lms.sqlite` plus every extracted course). A nightly `sqlite3 /data/lms.sqlite ".backup /backups/lms-$(date +%F).sqlite"` plus a copy of `/data/courses` is enough.

## Step 2 — DNS

At your registrar / DNS host, add a record for the subdomain:

| Type | Name | Value |
|---|---|---|
| CNAME | `learn` | the hostname your host gives you (e.g. `xyz.up.railway.app`, `aininjas-lms.onrender.com`) |
| A | `learn` | your VPS IP (Option B only) |

Then tell the host the custom domain is `learn.aininjas.com` so it issues the certificate. Propagation is usually minutes.

## Step 3 — Google Sign-In (optional but recommended for schools)

1. Google Cloud Console → *APIs & Services → Credentials → Create OAuth client ID → Web application*.
2. Authorized JavaScript origin: `https://learn.aininjas.com`. Authorized redirect URI: `https://learn.aininjas.com/auth/google/callback`.
3. Put the client ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The "Sign in with Google" button appears automatically.
4. Set `GOOGLE_ALLOWED_DOMAINS=partnerschool.edu,aininjas.com` to auto-approve anyone signing in from those Workspace domains — everyone else still lands in the pending queue.
5. Configure the OAuth consent screen (app name "AI Ninjas Academy", logo, privacy URL `https://aininjas.com/privacy`) and submit it for verification before you go beyond 100 users. This is the same verification the Foundations Challenge PRD flags as the critical path — start it now, not at launch.

## Step 4 — Wire up aininjas.com

Three links and one optional widget. Nothing on the marketing site needs to know anything about SCORM.

**Navigation.** Add *Log in* → `https://learn.aininjas.com/login` and a *Request access* button → `https://learn.aininjas.com/request-access`. Every site builder lets you add an external link to the menu.

**Course pages.** Wherever you describe a module on aininjas.com, the call-to-action is `https://learn.aininjas.com/request-access`. If you want a "Request access" form to live physically on aininjas.com, a plain HTML form that POSTs to the LMS works from any builder that allows custom HTML:

```html
<form method="post" action="https://learn.aininjas.com/request-access">
  <input name="name" placeholder="Full name" required>
  <input name="email" type="email" placeholder="School email" required>
  <input name="password" type="password" placeholder="Choose a password" required minlength="8">
  <input name="organization" placeholder="School / organization">
  <button>Request access</button>
</form>
```

**Live leaderboard on the public site.** The leaderboard plugin exposes JSON at `https://learn.aininjas.com/plugins/leaderboard/api?limit=10` (only display handles, never names). Drop this in a custom-HTML block:

```html
<ol id="ninja-board"></ol>
<script>
fetch('https://learn.aininjas.com/plugins/leaderboard/api?limit=10')
  .then(r => r.json())
  .then(rows => { document.getElementById('ninja-board').innerHTML =
    rows.map(r => `<li><b>${r.handle}</b> — ${r.belt} · ${r.points.toLocaleString()} pts</li>`).join(''); });
</script>
```

(If aininjas.com and learn.aininjas.com are on different hosts, add `Access-Control-Allow-Origin: https://aininjas.com` to that one route — a two-line change in `plugins/leaderboard/index.js`.)

**Privacy page.** Publish `https://aininjas.com/privacy` — the LMS footer and Google consent screen link there. List what you collect (name, email, school, course responses, scores, time) and why. Schools will ask.

## Step 5 — The access workflow you'll run day to day

1. A visitor clicks *Request access* on aininjas.com → fills the form on learn.aininjas.com → sees "Almost there — pending".
2. You open **Admin → Users** (filter: pending), read the school and note, click **Approve**, then either enroll them in a course from the dropdown or leave it to them: approved learners see published courses on their dashboard and click *Request access* / *Enroll* per course. Toggle **open enrollment** on a course to skip per-course approval.
3. They log in, take the course, progress is tracked per lesson; you watch **Admin → Courses → Report** and export CSV for a school.

Turn on **Auto-approve new sign-ups** once you're comfortable, or leave it off and approve in batches.

## Step 6 — Get a real SCORM 1.2 package in

The Foundations Challenge and the eight modules are currently PowerPoints and Word docs. To make them SCORM 1.2 packages: import the PPTX into **iSpring Suite** (PowerPoint add-in, best fidelity), **Articulate Storyline/Rise**, or **Genially**; add quiz slides; *Publish → LMS → SCORM 1.2*; upload the resulting zip in Admin → Courses. Set the mastery score inside the authoring tool — the LMS reads `adlcp:masteryscore` from the manifest and derives pass/fail automatically.

The sample package in `test/sample-scorm12.zip` shows the minimum a hand-built course needs (an `imsmanifest.xml` plus HTML pages that talk to `window.parent.API`), which is also how the custom Foundations Challenge quiz from the PRD could be packaged so its 25 items run inside this same player and feed the same leaderboard.

## Later: sharing one login between the sites

If aininjas.com becomes a custom app and you want one account across both, the cleanest route is to make the LMS the identity provider: aininjas.com redirects to `learn.aininjas.com/login?returnTo=…` and the LMS sets a cookie on `.aininjas.com`. Because both sites share the parent domain, a session cookie with `domain=.aininjas.com` works without any SSO protocol. Not needed for v1.

## Security checklist before opening to students

- `SESSION_SECRET` set and long; `BASE_URL` is `https://` so cookies are Secure.
- Admin password changed from the seed value; second admin created via *make admin*.
- Volume backed up; test a restore once.
- Content routes already require an active enrollment — do not put course files behind a public CDN.
- Uploads limited to admins; zip-slip guarded; packages capped at 1 GB (raise in `src/routes/admin.js` if needed).
- Under-13 users: keep the request form's school field required and get the school's consent on file (COPPA school-consent path from the PRD).
