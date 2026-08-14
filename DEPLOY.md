# Deploying Archive Search to Cloudflare

Same stack as the analytics dashboard: Cloudflare Pages, deployed from GitHub, with a
password gate in `functions/_middleware.js`. The data lives in Cloudflare D1.

You do **not** need Node.js or wrangler. Everything below is either the Cloudflare
website or a Python command.

Every command runs in **PowerShell**, from `C:\B8S-APPS\em-corpus`.

---

## Step 1. Create the D1 database

1. Go to <https://dash.cloudflare.com> and sign in.
2. Left sidebar: **Storage & Databases** -> **D1 SQL Database**.
3. Click **Create**.
4. Name it exactly `em-archive`. Click **Create**.
5. On the database page, copy the **Database ID** (a long hyphenated string).
   Keep it for step 4.

## Step 2. Create an API token

1. Top right avatar -> **My Profile** -> **API Tokens**.
   Direct link: <https://dash.cloudflare.com/profile/api-tokens>
2. Click **Create Token** -> **Create Custom Token** -> **Get started**.
3. Name: `em-archive-import`.
4. Under **Permissions**, set one row to: **Account** | **D1** | **Edit**.
5. Under **Account Resources**, select the Equity Mates account.
6. **Continue to summary** -> **Create Token**.
7. Copy the token now. Cloudflare shows it once and never again.

You also need your **Account ID**: it is on the right-hand side of any Cloudflare
account page, or in the URL after `dash.cloudflare.com/`.

## Step 3. Generate the data files

```powershell
C:\B8S-APPS\venv\Scripts\python.exe C:\B8S-APPS\em-corpus\export_d1.py
```

Writes 51 `.sql` files (about 69 MB) into `cf-archive\sql`. Already done once, so
you only need to re-run this after refreshing the corpus.

## Step 4. Save your credentials

Create the file `C:\B8S-APPS\em-corpus\cf-archive\.cf-env` containing your three
values, one per line:

```
CF_ACCOUNT_ID=your-account-id
CF_DATABASE_ID=id-copied-in-step-1
CF_API_TOKEN=token-copied-in-step-2
```

This file is listed in `.gitignore`, so it will not be committed.

## Step 5. Load the data into D1

```powershell
C:\B8S-APPS\venv\Scripts\python.exe C:\B8S-APPS\em-corpus\import_d1.py
```

Takes roughly 20 to 40 minutes and prints a line per file. If it stops partway, the
error message tells you exactly how to resume, for example:

```powershell
C:\B8S-APPS\venv\Scripts\python.exe C:\B8S-APPS\em-corpus\import_d1.py --from 40_utterances_012.sql
```

The last two files build the search indexes and are the slowest. When it finishes it
prints a row count so you can confirm the data arrived.

## Step 6. Put the code on GitHub

Create a new **private** repository called `em-archive-search` at
<https://github.com/new>, then:

```powershell
cd C:\B8S-APPS\em-corpus\cf-archive
git init
git add .
git commit -m "Equity Mates archive search"
git branch -M main
git remote add origin https://github.com/LouiscEM/em-archive-search.git
git push -u origin main
```

## Step 7. Create the Pages project

1. Cloudflare dashboard -> **Workers & Pages** -> **Create** -> **Pages** ->
   **Connect to Git**.
2. Choose the `em-archive-search` repository.
3. Build settings:
   - Framework preset: **None**
   - Build command: leave **empty**
   - Build output directory: `public`
4. Click **Save and Deploy**. The first deploy will fail the password check, which
   is expected until step 8.

## Step 8. Connect the database and set the password

In the new Pages project, go to **Settings**:

1. **Bindings** -> **Add** -> **D1 database**.
   - Variable name: `DB` (exactly this, the code reads `env.DB`)
   - D1 database: `em-archive`
   - Add it for **both** Production and Preview.
2. **Variables and Secrets** -> **Add**.
   - Type: **Secret**
   - Name: `ARCHIVE_PASSWORD`
   - Value: whatever password the team will share
   - Add it for **both** Production and Preview.
3. Go to **Deployments** and click **Retry deployment** on the latest one, so it
   picks up the binding and the secret.

## Step 9. Check it

Open the `*.pages.dev` URL. Your browser will ask for a username and password:
leave the username blank, enter the password from step 8.

Then confirm:

- the home page shows the five stat tiles
- searching `rare earths` in **Moments** returns results with speaker and timecode
- **Best performing** sort shows the green performance badges
- clicking an episode title opens the full transcript with terms highlighted

---

## Updating it later

After refreshing the corpus (`ingest.py`, then `backfill_youtube.py`, `slot_perf.py`):

```powershell
C:\B8S-APPS\venv\Scripts\python.exe C:\B8S-APPS\em-corpus\export_d1.py
C:\B8S-APPS\venv\Scripts\python.exe C:\B8S-APPS\em-corpus\import_d1.py
```

The schema file drops and recreates the tables, so a re-run replaces the data rather
than duplicating it. Code changes deploy automatically on `git push`.

## If something goes wrong

**Every request returns "ARCHIVE_PASSWORD is not configured"** - the secret was not
added, or the deployment was not retried after adding it. Redo step 8.3.

**Errors mentioning `env.DB` or `no such table`** - the D1 binding is missing or is
named something other than `DB`. Redo step 8.1.

**The import fails on one file** - re-run with `--from <filename>` as printed. It is
safe to re-run a file; inserts are plain and the schema step is what clears the table.

**Searches are slow** - normal on the very first query after a deploy while D1 warms
up. If it persists, check that `90_index.sql` and `91_fts.sql` actually loaded.
