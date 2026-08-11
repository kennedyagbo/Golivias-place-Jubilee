# Golivia's Place

Production-ready ordering website for Golivia's Place, Makurdi. Customers can browse the live menu and send an order; the owner can sign in to manage products, orders, promotions, content, settings, and uploads.

## What is included

- Responsive customer and admin experience for phones, tablets, and desktop browsers.
- Protected admin API: a password alone does not expose or permit dashboard operations; login creates an eight-hour session.
- Admins can change their password from **Admin Profile**. The replacement is stored securely on the persistent disk, takes effect immediately, and signs out every active admin session. After the first change, it overrides the original `ADMIN_PASSWORD` environment value.
- A public storefront API that does not reveal customer or order data.
- Persistent data and image uploads when deployed with the included Render disk.
- Health endpoint at `/healthz` for Render.

## Run locally

```powershell
Copy-Item .env.example .env
$env:ADMIN_PASSWORD = "choose-a-long-unique-password"
$env:DATA_DIR = ".local-data"
npm ci
npm start
```

Open `http://localhost:9000`. The first start copies `data/store.json` into `.local-data/store.json`; delete `.local-data` only when you intentionally want to reset local changes.

## Deploy on Render

1. Create a new empty GitHub repository, then push the files in the list below.
2. In Render, select **New + → Blueprint**, choose the GitHub repository, and use `render.yaml`.
3. Render will ask for `ADMIN_PASSWORD`. Set a strong, private password. Do not add it to GitHub.
4. Deploy. The service uses the Starter plan because continuous data retention requires a persistent disk. Render provides `PORT`; do not set it yourself.
5. Open the generated Render URL. Use the Admin tab on the site and sign in with `ADMIN_PASSWORD`.

The attached `/var/data` disk keeps orders, admin edits, and uploaded images through redeploys and restarts. Back up the disk data periodically before making major menu changes.

## Files to push to GitHub

Push these production files and folders:

```text
.env.example
.gitignore
README.md
render.yaml
package.json
package-lock.json
server.js
index.html
data/store.json
*.jpg
*.jpeg
```

Do **not** push `.env`, `.local-data`, `uploads`, `data/uploads`, `node_modules`, `.vercel-tmp`, or the unused `backend` folder. The `.gitignore` already excludes the generated and secret files.

From this folder, review and push the intended files with:

```powershell
git init
git add .env.example .gitignore README.md render.yaml package.json package-lock.json server.js index.html data/store.json *.jpg *.jpeg
git status
git commit -m "Prepare Golivia's Place for production"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

## Verification

```powershell
npm test
```
