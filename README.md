# Best FireWorks – Diwali order booking

Website and Android app for **Best FireWorks** (Sivakasi Factory Outlet, Bachupally). Customers browse the price list, book an order without logging in, send it to the shop on WhatsApp, and track its status. The shop gets an alert for each new order, updates the status, and messages the customer on WhatsApp from the admin page. At the stall, the same app does **counter billing** that works offline, with camera scanning of boxes.

| Page | What it does |
|---|---|
| `/` | Price list (Standard / Other Brands), search, cart, 10% bulk offer, booking form |
| `/track?code=BFW-XXXXXX` | Order status for the customer (no login, no personal details shown) |
| `/admin` (and the Android app) | Shop login (username + password; roles: super admin, admin, sales): live orders with sound and notification alerts, status updates with WhatsApp messages, 🧾 counter billing (offline, scan or search, WhatsApp bill, bills list with corrections), 📊 sales for counter and online by salesperson, item and price editor, 👥 users, sold-out items, home-delivery switch, pause bookings, CSV export |

**Built with:** plain HTML/CSS/JS with Vite, Firebase (Firestore, Auth, Hosting, Cloud Functions for push notifications and the Users tab), and Capacitor for the Android APK. GitHub Actions deploys the website and builds the APK.

---

## Run it on your PC (no Firebase project needed)

You need Node 20.19+ (22+ recommended), Java 21 and the Firebase CLI (`npm i -g firebase-tools`).

```bash
npm install
npm run emulators        # terminal 1: local Firestore + Auth (UI at http://127.0.0.1:4000)
npm run seed             # once: creates admin@bestfireworks.test / diwali2026
npm run dev              # terminal 2: http://localhost:5173
npm run test:e2e         # optional: automated booking -> tracking -> admin -> security-rules test
```

- Shop: http://localhost:5173 · Admin: http://localhost:5173/admin.html · Tracking: http://localhost:5173/track.html
- From a phone on the same Wi-Fi, use the "Network" address that `npm run dev` prints.
- `npm run dev` always uses the local emulators, so testing never touches real orders. Emulator data is wiped when you stop them. `npm run dev:live` runs the local site against the real Firebase project.

---

## Publish

### 1. Firebase project (`best-fireworks-98d13`)
Already done: the project exists, a web app named "Best FireWorks" is registered, and its config is in `src/config.js` and `.firebaserc`.

The website is **https://bestfireworks.web.app**. `best-fireworks.web.app` and `best-fireworks-98d13.web.app` are extra Hosting sites in the same project that forward there (see `firebase.json`).

1. **Build → Firestore Database → Create database**. Choose location **asia-south1 (Mumbai)** and production mode.
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. Deploy the security rules (once, and again whenever `firestore.rules` changes):
   ```bash
   firebase login
   firebase deploy --only firestore
   ```

### 2. Shop logins and roles
There is no sign-up page. The **super admin** adds everyone else in the app: **👥 Users → ＋ Add user** (name, username, password, role). Staff then sign in with just the username and password. Behind the scenes a username becomes `<username>@staff.bestfireworks.web.app` in Firebase Auth; no email is ever sent.

| Role | Can do |
|---|---|
| **Sales** | Billing, online orders, and only their own sales and bills ("My sales"). Can cancel or fix their own bill for 30 minutes. |
| **Admin** | Everything sales can do, plus everyone's sales (counter and online, by salesperson), cancelling or restoring any bill, items & prices, PDF settings, shop settings. |
| **Super admin** | Everything, plus the Users tab: add people, set passwords, change roles, switch logins off, delete logins. |

Roles live in Firestore `admins/{uid}` (`name`, `role` = `super` / `admin` / `sales`, `active`). A login without a `role` counts as an admin. `firestore.rules` enforces every limit on the server, and the **staffUsers** Cloud Function (`functions/index.js`) makes the changes, because only the server can set other people's passwords. It refuses to remove the last super admin, and a super admin cannot demote or delete themself. Switching a login off signs that person out straight away and stops order notifications on their phone.

**The very first login** (only if the project has no super admin yet): Firebase console → **Authentication → Add user** (email + password) → sign in to the admin page, copy the **user ID** it shows → **Firestore** → collection `admins` → document with that ID → fields `name` (your name) and `role` = `super`. Reload.

### 3. GitHub
1. Create a **public** repository named `best-fireworks`. Public repos get **unlimited free GitHub Actions minutes** (private repos only get a monthly quota), and customers never see GitHub: the staff APK is shared through Google Drive. The code holds no secrets: the Firebase web config is public by design, and the signing key and service account go in GitHub Secrets.
2. Push this folder:
   ```bash
   git init && git add . && git commit -m "Best FireWorks website and app"
   git branch -M main
   git remote add origin https://github.com/<you>/best-fireworks.git
   git push -u origin main
   ```

### 4. Auto-deploy from GitHub
Every push to `main` runs **Actions → Build and deploy**. It builds the website and the APK, deploys the website to Firebase Hosting, and keeps the APK as a download under the run's **Artifacts**. The workflow doesn't deploy Firestore rules: run `firebase deploy --only firestore` yourself when `firestore.rules` changes. This needs one secret:

1. Firebase console → ⚙️ **Project settings → Service accounts → Generate new private key**.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**: name `FIREBASE_SERVICE_ACCOUNT`, value = the whole JSON file. Then delete the downloaded file.

Without the secret, the workflow still builds everything but deploys nothing.

Manual deploy from this PC: `npm run deploy`.

### 5. "BFW Admin" Android app (staff only)
Customers use the website. The Android app is the shop's business tool: it opens straight to the staff login, then shows Orders, Billing, Sales, Items & prices, Price list PDF and Settings. A new-order notification opens that order, so staff can review it, call the customer or send a WhatsApp update, and confirm it.

Every push to `main` builds a signed **BFW-Admin.apk** (package `com.bestfireworks.admin`; Firebase config in `android-config/google-services.json`).

**Install on a staff phone**
1. GitHub → **Actions** → latest **Build and deploy** run → **Artifacts** → download **BFW-Admin-apk-v…** and unzip it.
2. Upload `BFW-Admin.apk` to Google Drive → **Share** → add only the staff Google accounts and keep General access **Restricted**.
3. On the staff phone, open the file from Drive → **Install** (allow "Install unknown apps" for Drive if asked) → open **Best FireWorks** → sign in → allow notifications (and the camera, the first time you scan in Billing).

**Updating:** in Drive, right-click the file → **File information → Manage versions → Upload new version**, then reinstall it on each phone. App updates are rarely needed: prices, items and settings change live.

**Set up a signing key once.** Without one, each build is signed with a new throwaway key, and phones must uninstall the old app before installing an update.

```bash
keytool -genkeypair -v -keystore bestfireworks.jks -alias bestfireworks -keyalg RSA -keysize 2048 -validity 10000
# PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("bestfireworks.jks")) | Set-Clipboard
```

In GitHub, go to **Settings → Secrets and variables → Actions** and add:
`ANDROID_KEYSTORE_BASE64` (the base64 text), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`bestfireworks`), `ANDROID_KEY_PASSWORD`.
Keep `bestfireworks.jks` and its passwords safe and **out of git** (`.gitignore` already excludes `*.jks`). GitHub stores only an encrypted copy that nobody can download again, so back the file up, for example to Google Drive. If you lose them, you cannot ship updates to installed apps.

The app loads the latest price list from the website each time it opens, so price corrections reach the app without a new APK.

### 6. Server parts: rules, indexes, Cloud Functions (needs Blaze)
GitHub only deploys the website. After changing `firestore.rules`, `firestore.indexes.json`, `storage.rules` or `functions/`, run once from this PC:
```bash
npm run deploy:backend
```

### 7. New-order notifications when the app is closed (needs Blaze)
While the app or admin page is open, new orders ring straight away. To get a notification **even when the app is closed or the phone is locked**, the Cloud Function in `functions/` sends one per order, and that needs the **Blaze** (pay-as-you-go) plan. A shop's volume stays inside the free monthly quota, but a billing account is required. Set a small budget alert under Google Cloud → Billing → Budgets.
1. Firebase console → **Upgrade** → Blaze.
2. `npm run deploy:functions`
3. Open BFW Admin on each staff phone once (it registers the phone for notifications automatically).
4. Optional, for alerts in a desktop browser too: **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**, paste the key into `vapidKey` in `src/config.js`, push, then tap **Turn on alerts** on the admin web page.

---

## Day-to-day

- **Change prices, rename, hide or add items:** admin page → **Items & prices** → **Edit** / **+ Add item**. The website and app update straight away, with no code change or deploy needed. Edits are stored in Firestore (`settings/public.catalog`) on top of the price-list file. **↺ Back to original price list** undoes an item's edits.
- **Item photos (optional):** Items & prices → Edit → **Take photo** or **Gallery**. Each photo is compressed on the phone into a list picture (up to 25 KB, never cropped) and a zoom picture (up to 180 KB, loaded only when a customer taps it). Items without a photo show a compact text card.
- **Price list PDF:** admin → **📄 Price list PDF**. Exports from the live prices as one PDF, two separate PDFs, or a single section. All text (note, offer, header, footer, section and column titles) and each header image can be changed there. Settings are stored in Firestore: `settings/pdf` and `settings/pdfimg-*`. Built-in artwork is in `public/pdf/header/`; the design is in `src/lib/price-pdf.js`. One-time setup: Firebase console → **Storage → Get started** (location asia-south1), then `npm run deploy:rules`.
- **Start next season's list:** edit `data/best_fire_works_price_list_2026.csv` (Excel is fine; keep the header row and `id` column) and push. `npm run prices` checks that amount − discount = final price. Clear the old admin edits afterwards (each item's **↺ Back to original price list**, or delete the `catalog` field in Firestore).
- **Store details, offer dates or excluded items:** edit `data/store.json`.
- **Sold out, pause bookings, notice banner:** use the admin page, no code change needed.
- **Home delivery:** admin → **Settings** → "Offer home delivery" (and an optional note such as area or charges). Pickup at the stall is always available. The security rules refuse delivery orders while it is off.
- **Sales:** admin → **📊 Sales**. Revenue, still-to-collect, sales by category, best-selling items, daily sales, busiest hours, pickup/delivery and website/app split, for today, yesterday, the last 7 days or the whole season. **⬇ All item sales (CSV)** helps with restocking.
- Customers can book for any day from today.

## Counter billing (in the app)
**🧾 Billing**. Made for the stall: quick bills, several at once, and it keeps working without internet.

The screen has three views, switched with the bar at the top (it stays on screen while you scroll):
- **📷 Scan**: hold the box inside the square and tap **📷 Scan item**. A sure match is added straight away (with Undo); otherwise the closest items are shown to tap. Turn on **Auto** to add each box held steady in front of the camera. The last 3 items added show under the camera.
- **🔍 Search**: by name, brand or item number, or by category. Tap a result to add it; items already on the bill show **− qty +** right on the result.
- **🧾 Bill**: the whole bill with quantities, totals, **Hold & start a new bill**, Clear, Delete.

The bar at the bottom always shows the total; tap it to see the bill, or tap **Checkout**.

- **Offline price list.** The first time, Billing saves the prices, items and item photos on the phone and prepares them for scanning. After that it downloads only what changed: price edits arrive with the settings the app already loads (1 read when the app opens), and a photo is downloaded again only if it was replaced. Tap the sync line to check by hand.
- **How scanning recognises a box.** For every item photo the phone stores a colour fingerprint and about 300 small "feature points" (distinctive corners and patterns of the printed artwork). A scan picks the 30 items with the closest colours, matches the camera's feature points against theirs, and checks that the matching points line up as the same picture seen at an angle (OpenCV: ORB features + RANSAC). At least 12 points that line up, and twice as many as the next item, count as a sure match. It runs on the phone (about 0.25 s, no internet, no cost). It needs a photo of each item: Items & prices → Edit → **Take photo**, with the front of the box filling the frame.
- **Several bills at once.** **＋ New** starts another bill. Tap a bill chip to switch. Unfinished bills stay on the phone even if the app is closed.
- **Checkout.** Shows the final bill (item discounts and the bulk offer, as on the website). Enter the **amount collected**, or tap exact, round down to ₹10 or ₹50, −5% or −10%; the difference is shown as the adjustment. Choose **UPI**, **Cash** or **Card**. Customer phone and name are optional; a returning customer's name fills in from their phone number.
- **Save = 1 write.** The bill is saved on the phone first, then sent as one Firestore document, `sales/{billNo}`, with who billed it. Bills saved offline are sent automatically when the phone is back online. Bill numbers are a 3-letter code per phone plus a running number, like `KMP-0001`, so two phones never clash.
- **WhatsApp bill.** On save, WhatsApp opens with the items and prices, discount, bill total, adjustment, **total paid** with the payment mode, and a thank-you and Happy Diwali message. With a customer number it goes straight to their chat.
- **📒 Bills** (Billing or Sales tab): every counter bill (sales staff: their own), searchable by bill number, customer name or phone, filtered by date, salesperson, payment and status, with day totals by UPI, cash and card. Tap a bill to see it in full, send it on WhatsApp again, **fix the payment mode or customer**, **cancel** it with a reason, or **cancel & re-bill** (its items go into a new bill to correct and check out again). Cancelled bills stay in the list and are left out of every total; an admin can restore them. Bills are never deleted.
- **Counter-only phone.** Settings → "This phone is a billing counter". The app opens on Billing and skips the online-orders list and order alerts.

**Reads and writes.** Each bill is 1 write; each correction is 1 write. The Bills list and Sales download each bill once per phone and afterwards only new or changed bills (while one of them is open, new bills from other counters appear by themselves). Sales staff phones open on Billing and load the online orders only when the Orders tab is opened.

## Sales tab
- **Admins:** **All sales** (counter + online together), **🧾 Counter** or **🌐 Online**, for today, yesterday, the last 7 days or the whole season. Shows totals, where sales came from, counter payments (UPI / cash / card), **by salesperson** (tap a person to see their bills), discounts and counter adjustments given, cancelled bills, busiest hours, best-selling items and categories. **⬇ Bills (CSV)**, **⬇ item sales (CSV)** and **💬 Share report** (a WhatsApp summary for the owner).
- **Sales staff:** **📊 My sales**: their own counter sales, cash to hand over, UPI and card, their bills, and **💬 Share my day**.

## How orders flow
1. The customer books and gets two codes:
   - an **order code** like `BFW-K7Q2M` (5 random characters, about 33 million possibilities), used for tracking;
   - a private 4-digit **pickup code**, needed to collect the order.

   The full order is saved in the customer's browser ("Orders"). The server keeps `orders/{code}` (private) and `tracking/{code}` (public status only: no name, phone or pickup code).
2. The customer taps **Send order to shop on WhatsApp**. This opens a pre-filled message with both codes, the items, the total and the tracking link.
3. The admin page rings and shows a notification with a **📞 Call customer** button. The Cloud Function does the same when the page is closed.
4. Fake-order check: confirm only once the WhatsApp message has arrived from the booked number and shows the right pickup code, or after calling the customer.
5. The shop taps **Confirm**, **Ready for pickup** or **Completed**. The status updates on the customer's tracking page, and WhatsApp opens with a ready-made update that includes the directions link.
6. At the stall, type the code after `BFW-` in **Open order** (no hyphen needed), then type the customer's 4-digit pickup code to check it before handing over. The admin page also shows ✓ or ⚠ if the booked prices don't match the current price list.

## Open questions for the owner
- The 10% offer is set to end on **5 Nov 2026**, the same day the stall opens. Confirm the real end date in `data/store.json`.
- The ₹10,000 threshold is checked on the **full bill**, and the 10% applies only to eligible items. Confirm this.
- Is POPUP (OTH-091) the "pop pop" item excluded from the offer?
