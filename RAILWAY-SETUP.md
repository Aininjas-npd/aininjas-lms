# Going live: learn.aininjas.com on Railway (alongside Quiz Studio)

This app was built deploy-ready: it has a `Dockerfile`, reads all its settings from environment variables, and keeps everything (SQLite database + extracted SCORM courses) in one `DATA_DIR` folder. So going live is the same 20-minute recipe as Quiz Studio — and both apps live in **one Railway project**, side by side, on one bill.

The broader hosting options (VPS, Fly.io) and the aininjas.com integration plan are in `DEPLOYMENT.md`; this file is just the Railway path, step by step.

## The target picture

```
Railway project "AI Ninjas"
├── Service: quiz-studio   → volume at /data → quiz.aininjas.com
└── Service: aininjas-lms  → volume at /data → learn.aininjas.com
```

Each service has its own repo, own volume, own variables, own domain. Updating one never touches the other.

## 1. Put the LMS on GitHub

Create a second **private** repository (e.g. `aininjas-lms`) and upload everything in this folder **except** `node_modules/`, `data/`, and `.env` (the `.gitignore` already excludes them if you use git; with GitHub's "upload files" page, just don't drag those in). `data/` holds your real database and uploaded courses — it stays on your machine; step 5 covers moving courses online.

## 2. Add it to the SAME Railway project

Open the project that already has Quiz Studio → **+ Create → GitHub Repo** → pick `aininjas-lms`. Railway sees the `Dockerfile` and builds with it automatically (the Dockerfile already sets `DATA_DIR=/data` and the right port).

## 3. Configure the service (before sharing any link)

**Variables** (service → Variables):

| Variable | Value |
|---|---|
| `BASE_URL` | `https://learn.aininjas.com` |
| `SESSION_SECRET` | 64 random characters (any long random string) |
| `ADMIN_EMAIL` | your admin login email |
| `ADMIN_PASSWORD` | a strong password (first admin account is created from these on first boot) |

(`DATA_DIR` and `PORT` are already handled by the Dockerfile. `SITE_NAME`, `MAIN_SITE_URL`, `GOOGLE_*`, and `PLUGINS` are optional — see `.env.example`.)

**Volume** (service → Settings → Volumes → New Volume): mount path `/data`.
This holds the database and every uploaded course. **Without it, all learner data is wiped on each redeploy.**

Redeploy after both are set.

## 4. Point learn.aininjas.com at it

1. Service → Settings → Networking → **Custom Domain** → `learn.aininjas.com`. Railway shows a CNAME target.
2. GoDaddy → DNS → add **CNAME**: name `learn`, value = that target — exactly like the `quiz` record.
3. A few minutes later `https://learn.aininjas.com` is live with HTTPS. (The free `*.up.railway.app` URL works immediately, before DNS.)

Note: if DNS previously had a `learn` record pointing at Vercel, delete that record first.

## 5. Getting your courses online

The live site starts empty (it creates a fresh admin from the variables above). Two options:

- **Re-upload** (simplest): log in at `https://learn.aininjas.com/admin` and upload your SCORM zips again — e.g. "The Disciple" Storyline export.
- **Copy state**: copy your local `data/` contents (`lms.sqlite` + `courses/` + `uploads/`) into the Railway volume via `railway ssh` — full clone of your local setup, users and progress included.

## Everyday notes

- Back up by downloading the `/data` volume occasionally — it is the complete state.
- Code updates: push to GitHub → Railway redeploys → volume keeps all data.
- Both apps online means you can link or embed quizzes from LMS course pages using their public `quiz.aininjas.com/q/…` links.
