# Best FireWorks – Diwali order booking

Website and Android app for **Best FireWorks** (Sivakasi Factory Outlet, Bachupally). Customers browse the price list, book an order without logging in, send it to the shop on WhatsApp, and track its status. The shop gets an alert for each new order, updates the status, and messages the customer on WhatsApp from the admin page.

| Page | What it does |
|---|---|
| `/` | Price list (Standard / Other Brands), search, cart, 10% bulk offer, booking form |
| `/track?code=BFW-XXXXXX` | Order status for the customer (no login, no personal details shown) |
| `/admin` (and the BFW Admin app) | Shop login: live orders with sound and notification alerts, status updates with WhatsApp messages, 📊 sales dashboard, item and price editor, sold-out items, home-delivery switch, pause bookings, CSV export |

**Built with:** plain HTML/CSS/JS with Vite, Firebase (Firestore, Auth, Hosting, optional Cloud Function for push), and Capacitor for the Android APK. GitHub Actions deploys the website and builds the APK.

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

### 2. Shop logins
1. **Authentication → Users → Add user**: enter the owner's email and a password.
2. Open `https://bestfireworks.web.app/admin` and sign in. The page shows a **user ID**. Copy it.
3. **Firestore → Start collection** `admins` → Document ID = that user ID → add a field `name` (string) = the owner's name. Reload the admin page.

Repeat for each staff member.

### 3. GitHub
1. Create a **public** repository named `best-fireworks`. Public repos get **unlimited free GitHub Actions minutes** (private repos only get a monthly quota), and customers never see GitHub: the APK is served from the website. The code holds no secrets: the Firebase web config is public by design, and the signing key and service account go in GitHub Secrets.
2. Push this folder:
   ```bash
   git init && git add . && git commit -m "Best FireWorks website and app"
   git branch -M main
   git remote add origin https://github.com/<you>/best-fireworks.git
   git push -u origin main
   ```

### 4. Auto-deploy from GitHub
Every push to `main` runs **Actions → Build and deploy**. It builds the website and the APK, puts the APK on the website, and deploys both to Firebase Hosting. This needs one secret:

1. Firebase console → ⚙️ **Project settings → Service accounts → Generate new private key**.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**: name `FIREBASE_SERVICE_ACCOUNT`, value = the whole JSON file. Then delete the downloaded file.

Without the secret, the workflow still builds everything (the APK is under the run's **Artifacts**) but deploys nothing.

Manual deploy from this PC: `npm run deploy`. It keeps the APK that is currently live, because the APK is only built on GitHub.

### 5. "BFW Admin" Android app (staff only)
Customers use the website. The Android app is the shop's business tool: it opens straight to the staff login, then shows Orders, Sales, Items & prices and Settings. A new-order notification opens that order, so staff can review it, call the customer or send a WhatsApp update, and confirm it.

Every push to `main` builds a signed **BFW-Admin.apk** (package `com.bestfireworks.admin`; Firebase config in `android-config/google-services.json`).

**Install on a staff phone**
1. GitHub → **Actions** → latest **Build and deploy** run → **Artifacts** → download **BFW-Admin-apk-v…** and unzip it.
2. Upload `BFW-Admin.apk` to Google Drive → **Share** → add only the staff Google accounts and keep General access **Restricted**.
3. On the staff phone, open the file from Drive → **Install** (allow "Install unknown apps" for Drive if asked) → open **BFW Admin** → sign in → allow notifications.

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

### 6. New-order notifications when the app is closed (needs Blaze)
While the app or admin page is open, new orders ring straight away. To get a notification **even when the app is closed or the phone is locked**, the Cloud Function in `functions/` sends one per order, and that needs the **Blaze** (pay-as-you-go) plan. A shop's volume stays inside the free monthly quota, but a billing account is required. Set a small budget alert under Google Cloud → Billing → Budgets.
1. Firebase console → **Upgrade** → Blaze.
2. `npm run deploy:functions`
3. Open BFW Admin on each staff phone once (it registers the phone for notifications automatically).
4. Optional, for alerts in a desktop browser too: **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**, paste the key into `vapidKey` in `src/config.js`, push, then tap **Turn on alerts** on the admin web page.

---|---|
| `/` | Price list (Standard / Other Brands), search, cart, 10% bulk offer, booking form |
| `/track?code=BFW-XXXXXX` | Order status for the customer (no login, no personal details shown) |
| `/admin` | Shop login: live orders with sound and notification alerts, status updates with WhatsApp messages, 📊 sales dashboard, item and price editor, sold-out items, home-delivery switch, pause bookings, CSV export |

**Built with:** plain HTML/CSS/JS with Vite, Firebase (Firestore, Auth, Hosting, optional Cloud Function for push), and Capacitor for the Android APK. GitHub Actions deploys the website and builds the APK.

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

### 2. Shop logins
1. **Authentication → Users → Add user**: enter the owner's email and a password.
2. Open `https://bestfireworks.web.app/admin` and sign in. The page shows a **user ID**. Copy it.
3. **Firestore → Start collection** `admins` → Document ID = that user ID → add a field `name` (string) = the owner's name. Reload the admin page.

Repeat for each staff member.

### 3. GitHub
1. Create a **public** repository named `best-fireworks`. Public repos get **unlimited free GitHub Actions minutes** (private repos only get a monthly quota), and customers never see GitHub: the APK is served from the website. The code holds no secrets: the Firebase web config is public by design, and the signing key and service account go in GitHub Secrets.
2. Push this folder:
   ```bash
   git init && git add . && git commit -m "Best FireWorks website and app"
   git branch -M main
   git remote add origin https://github.com/<you>/best-fireworks.git
   git push -u origin main
   ```

### 4. Auto-deploy from GitHub
Every push to `main` runs **Actions → Build and deploy**. It builds the website and the APK, puts the APK on the website, and deploys both to Firebase Hosting. This needs one secret:

1. Firebase console → ⚙️ **Project settings → Service accounts → Generate new private key**.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**: name `FIREBASE_SERVICE_ACCOUNT`, value = the whole JSON file. Then delete the downloaded file.

Without the secret, the workflow still builds everything (the APK is under the run's **Artifacts**) but deploys nothing.

Manual deploy from this PC: `npm run deploy`. It keeps the APK that is currently live, because the APK is only built on GitHub.

### 5. "BFW Admin" Android app (staff only)
Customers use the website. The Android app is the shop's business tool: it opens straight to the staff login, then shows Orders, Sales, Items & prices and Settings. A new-order notification opens that order, so staff can review it, call the customer or send a WhatsApp update, and confirm it.

Every push to `main` builds a signed **BFW-Admin.apk** (package `com.bestfireworks.admin`; Firebase config in `android-config/google-services.json`).

**Install on a staff phone**
1. GitHub → **Actions** → latest **Build and deploy** run → **Artifacts** → download **BFW-Admin-apk-v…** and unzip it.
2. Upload `BFW-Admin.apk` to Google Drive → **Share** → add only the staff Google accounts and keep General access **Restricted**.
3. On the staff phone, open the file from Drive → **Install** (allow "Install unknown apps" for Drive if asked) → open **BFW Admin** → sign in → allow notifications.

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

### 6. Push notifications to the shop's phone (optional, recommended)
With the admin page open, new orders always ring and show an alert. To get notified **even when the page or phone screen is off**:
1. Upgrade the Firebase project to **Blaze** (pay-as-you-go). A shop's order volume stays within the free monthly quota, but a billing account is required for Cloud Functions.
2. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**, and paste the key into `vapidKey` in `src/config.js`.
3. Deploy the function:
   ```bash
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
   If your Firestore location is not `asia-south1`, change `region` in `functions/index.js` first.
4. On the shop phone, open `https://bestfireworks.web.app/admin` in **Chrome**, sign in, tap **Turn on alerts**, then **⋮ → Add to Home screen**.

---

## Day-to-day

- **Change prices, rename, hide or add items:** admin page → **Items & prices** → **Edit** / **+ Add item**. The website and app update straight away, with no code change or deploy needed. Edits are stored in Firestore (`settings/public.catalog`) on top of the price-list file. **↺ Back to original price list** undoes an item's edits.
- **Start next season's list:** edit `data/best_fire_works_price_list_2026.csv` (Excel is fine; keep the header row and `id` column) and push. `npm run prices` checks that amount − discount = final price. Clear the old admin edits afterwards (each item's **↺ Back to original price list**, or delete the `catalog` field in Firestore).
- **Store details, offer dates or excluded items:** edit `data/store.json`.
- **Sold out, pause bookings, notice banner:** use the admin page, no code change needed.
- **Home delivery:** admin → **Settings** → "Offer home delivery" (and an optional note such as area or charges). Pickup at the stall is always available. The security rules refuse delivery orders while it is off.
- **Sales:** admin → **📊 Sales**. Revenue, still-to-collect, sales by category, best-selling items, daily sales, busiest hours, pickup/delivery and website/app split, for today, yesterday, the last 7 days or the whole season. **⬇ All item sales (CSV)** helps with restocking.
- Customers can book for any day from today.

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
- Pickup only, or delivery too?
