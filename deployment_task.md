# Cloud Deployment Checklist: Access VacciTrack from Anywhere

To make VacciTrack accessible from anywhere in the world on your phone or another laptop, while keeping the offline-first Local Server running at the clinic next to the fridge, you need to literally deploy the `cloud` and `client` folders to the public internet using free hosting providers.

Here is the exact checklist to achieve this:

## [x] 1. Set up a Free Cloud PostgreSQL Database (Supabase / Neon)
**DONE!** The `cloud/index.js` file is now hardcoded to connect to your Supabase PostgreSQL database (`db.lpzrqpkgeomgwoqyoapm.supabase.co`).

## [ ] 2. Host the Cloud Backend API (Render)
Render makes hosting Node.js servers incredibly easy and free.
1. Create a free account at [Render](https://render.com).
2. Create a GitHub repository and push your entire `VacciTrack` folder to it.
3. In Render, select **New Web Service**, connect your GitHub repo.
4. Set the Root Directory to `cloud`.
5. Set Build Command to `npm install`.
6. Set Start Command to `node index.js`.
7. Wait 5 minutes for it to deploy. You will get a link like `https://vaccitrack-cloud.onrender.com`.

## [ ] 3. Host the Frontend Website (Vercel or Netlify)
This is where you'll visit the dashboard from your phone anywhere in the world.
1. Create a free account on [Vercel](https://vercel.com) or [Netlify](https://netlify.com).
2. Create a new Project and link your GitHub repository.
3. Set the Root Directory to `client`.
4. We will need to update the React code in `client/` to point to the new Render link (e.g., `https://vaccitrack-cloud.onrender.com`) instead of `http://localhost:4000`.
5. Deploy it! It will give you a link like `https://vaccitrack-app.vercel.app`.

## [ ] 4. Configure the Local Edge Server
The local laptop stays next to the Arduino inside the clinic.
1. On the local PC, open `server/index.js`.
2. Find the constant `CLOUD_URL` and change it from `http://localhost:4000/api/data` to your new public Render link: `https://vaccitrack-cloud.onrender.com/api/data`.
3. Run `node index.js`.
4. Now, the local server will read from Arduino, save it locally, and push the data silently over the internet to Render.

## [ ] 5. Optional: Keep a Local Dashboard
If the clinic internet dies, the doctors in the room still need to see the fridge temperature!
1. You can still run `npm run dev` inside `client` on the local clinic laptop.
2. We can configure that specific local dashboard to read directly from `http://localhost:3000` (the offline edge server) so it works even without internet.
