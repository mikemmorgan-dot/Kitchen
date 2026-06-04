# Deploying Morgan’s Kitchen to Render

The app runs as a single Node.js service on Render’s free tier.
Once deployed, recipes auto-refresh every Sunday at 3 AM from all 6 blogs.

-----

## Step 1 — Push to GitHub

1. Create a free account at [github.com](https://github.com) if you don’t have one
1. Create a new **private** repository called `morgans-kitchen`
1. Push the code:

```bash
cd /path/to/recipe-app
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/morgans-kitchen.git
git push -u origin main
```

-----

## Step 2 — Deploy on Render

1. Create a free account at [render.com](https://render.com)
1. Click **New → Web Service**
1. Connect your GitHub account and select the `morgans-kitchen` repo
1. Render will auto-detect the `render.yaml` config — just click **Deploy**

That’s it. Render will:

- Install dependencies (`npm install`)
- Start the server (`npm start`)
- Assign a URL like `https://morgans-kitchen.onrender.com`

-----

## Step 3 — Open the app

Visit your Render URL. The server will start a background scrape of all 6 blogs
on first launch (takes ~60 seconds). Until it finishes, the app shows the
built-in recipe set — you won’t notice any gap.

Check scrape status at: `https://YOUR-APP.onrender.com/api/status`

-----

## How the refresh works

|What          |When                                                                |
|--------------|--------------------------------------------------------------------|
|First scrape  |Automatically on startup if `recipes.json` is missing or >7 days old|
|Weekly refresh|Every Sunday at 3 AM                                                |
|Manual refresh|POST to `/api/refresh`                                              |

Recipe data is saved to `recipes.json` on disk. User data (meals logged, plan, goals)
is stored in the browser’s localStorage — it never touches the server.

-----

## Free tier limits

- **750 hours/month** — enough to run 24/7 for one service
- **Spins down after 15 min of inactivity** — first request after sleep takes ~30 sec to wake up
- **No persistent disk** — `recipes.json` resets on deploy/restart (re-scrapes automatically)

For $7/month (Render Starter), you get always-on with no spin-down and a persistent disk.

-----

## Updating the app

Push changes to GitHub → Render auto-deploys:

```bash
git add .
git commit -m "Add new feature"
git push
```