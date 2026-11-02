# Rail desk

A local booking assistant for the current IRCTC `/eticket/` website. Build a list of journeys, with separate passengers and a fare limit for each, then start the list once. The app uses Chromium's visible controls to prepare each ticket, pauses for human verification, and can open UPI payment. You approve each payment on your own device.

## Run

Requires Node.js 22 or newer and Chromium on a Linux desktop.

```sh
npm start
```

Open **http://127.0.0.1:4317**. Click **Open IRCTC**. The app attaches to an existing local Chromium debug session on port 9222, or starts a separate profile under `.runtime/chromium`. Keep one IRCTC booking tab open in that window.

## Build and run a booking list

1. Search From and To by station code, English/Hindi name or city, then select an exact station suggestion. The imported IRCTC catalog currently contains **8,608 station records**.
2. Enter the train number, date, class, quota and maximum total fare. A blank train number means the first eligible result in the requested class.
3. Choose passengers for **this journey**. Saved passengers use their exact IRCTC master-list names; new passengers use name, age, gender and berth preference.
4. Click **Add to booking list**. Add further journeys with their own passengers and limits. Use **Edit** or **Remove** before starting. A matching journey/passenger group cannot be added twice while it is queued or already reported booked.
5. Click **Start booking list**. The list runs in order, one journey at a time. Optional sign-in credentials apply to the first journey only; later journeys use the browser session and pause for sign-in if needed.
6. Complete any required OTP/CAPTCHA on IRCTC. If automatic QR is enabled for that journey, the app initiates its payment once, within the fare limit. Otherwise click **Open payment QR** after review. Approve payment yourself.
7. The running list checks the browser result every five seconds without changing focus. A matching issued ticket/PNR, or your report of a final booked status, lets the next journey start. Each row retains its result and verified PNR. An unknown payment remains locked; a browser read error stops automatic checking and requires a manual result check.

An unavailable train, preparation error, cancellation or reported failed booking pauses the list. **Continue remaining journeys** skips that resolved row and starts the rows still marked Queued; it never automatically retries a failed transaction. **Stop list** cancels an unpaid preparation and preserves the remaining rows. If payment has already started, it leaves that payment for reconciliation and starts no further journeys.

The list supports up to 20 journeys and stays in the local server's memory across page refreshes. Restarting the server clears the list and passenger data. A pending-payment journal survives restarts and still prevents another booking until the payment is reconciled. A single booking remains available through **Book only this journey** while the list is empty.

## Single-journey flow

1. Sign in directly on IRCTC, or expand the local form's sign-in options to supply credentials for this run.
2. Enter exact stations (codes avoid ambiguity), date, class and General/Tatkal quota. A train number is optional. Without one, the assistant checks up to 20 results in the order IRCTC shows and chooses the first eligible train in the requested class.
3. Add saved passengers by their exact master-list names, or enter new Indian passengers aged 5–125. New entries are added to the booking, not to the master list. Infants, foreign passengers, concessions and additional train-specific requirements need direct IRCTC interaction.
4. Set the maximum **total**, including fees. RAC/waitlist acceptance is off by default. Enable it only if that is acceptable.
5. Start booking. Complete any login, OTP, CAPTCHA, ambiguous station selection or additional details in Chromium, then click **Resume** in Rail desk. The app does not solve or bypass verification.
6. With automatic QR handoff enabled, the assistant checks the fare and itinerary and selects Paytm UPI, then clicks Pay & Book **once**. Otherwise it stops at payment options until you click Open payment QR. The provider may require further steps or may fail; a successful handoff is not an issued ticket.
7. Complete payment yourself, then click **Check booking result**. Automatic success requires a matching IRCTC ticket confirmation and PNR. If the result is uncertain, inspect IRCTC booked and failed history. Only reconcile “No ticket issued” once IRCTC establishes failure; a pending payment is not a failure.

Result checking and reconciliation stay disabled while the payment handoff is running. One result check runs at a time, and a resolved booking cannot be checked again. A verified PNR appears in a confirmation card and remains visible after refreshing the page while the local server is running. A new booking clears that card and requires a fresh reconciliation choice if its payment outcome is uncertain.

If a run starts in another local tab or through the local API, open Rail desk pages update their form to that run's journey and passengers. Once a run ends, ordinary status updates preserve edits to your next journey.

Tatkal starts at 10:00 AM IST for AC and 11:00 AM for non-AC, one day before departure from the train's originating station. Select the quota and start at the appropriate time. This version does not schedule future runs or promise opening-second execution. Account Aadhaar authentication and booking OTP may be required. [IRCTC timing guide](https://contents.irctc.co.in/en/TatkalBooking.html), [Railways verification announcement](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2135694&lang=2&reg=48).

## Local configuration

- `PORT`: local web port, default `4317`.
- `IRCTC_DEBUG_URL`: loopback-only Chromium debug URL, default `http://127.0.0.1:9222`.
- `IRCTC_CHROMIUM`: executable path, default `/usr/bin/chromium`.

The web server binds only to `127.0.0.1`, checks the Host and Origin, requires a per-process token for mutations, and has no external assets or analytics. Passwords and passenger details stay in process memory and the live IRCTC/browser session; they are not written to application files or logs. The browser profile itself can retain IRCTC session data. Do not expose either local port publicly.

`data/stations.json` contains only public station names, codes, cities, states and search aliases. It was imported from the station catalog already loaded by the official IRCTC page (`nget-spa.station-list-new`, populated by `stationData`). **Refresh stations**, or `npm run stations:refresh`, reimports that public catalog from the open IRCTC tab; no account storage, cookies or login tokens are copied. The import timestamp is not a guarantee that IRCTC has refreshed its own browser cache. Search is local and does not call IRCTC for each keystroke. An ambiguous station name requires an exact code.

Only a small pending-payment journal is saved, with the job ID, train, date and amount. It is written **before** clicking Pay & Book and prevents automatic retries, including after a server restart. A failed handoff keeps that guard until the outcome is reconciled. `.runtime/` is excluded from source control.

## Verification and limits

```sh
npm test
npm run test:ui
```

`test:ui` needs Chromium's local debug port. It opens a temporary local test tab with a fake booking adapter, exercises the real form and HTTP server, then closes that tab. It does not make IRCTC requests or initiate payments. The simulated flow covers station suggestions, distinct passenger groups, queue editing/removal, two sequential bookings, automatic result checks, payment handoff locks, PNR display after a refresh, and desktop/mobile overflow. To save screenshots, run `RAIL_UI_SCREENSHOTS=1 npm run test:ui`; all screenshot passengers and PNRs are test data.

Live verification on 13 October 2026: both saved-passenger and new-passenger workflows automatically reached payment options for 15128, NDLS–MBDP, 14 October, 2A/General, ₹1,478.60, PQWL5/WL2. Payment preflight verified the full review date, names, total and selected Paytm UPI provider; it stopped before Pay & Book. No payment was initiated by these app tests. Desktop and 390-pixel mobile layouts were visually checked without horizontal overflow. Unit tests cover input validation, exact passenger matching, availability, fare caps, OTP pause/cancellation, duplicate submissions, persistent uncertain-payment recovery, receipt matching and local API access controls.

The adapter is tied to the currently observed IRCTC UI. A changed or ambiguous control stops the run. It does not silently select another class, exceed the fare cap, truncate names or submit duplicate payments. Train availability, session lifetime and provider responses remain outside the assistant's control. Full end-to-end ticket issuance and opening-time Tatkal behavior have not yet been demonstrated in this project.

Follow-up live check on 13 October 2026: a fresh sign-in and new-passenger run again reached payment options for the same train/date/class at ₹1,478.60. Availability had changed to **PQWL6/WL3**. The full review rechecked passenger age, gender and country before continuing. Automatic payment was disabled; no payment was initiated. This also exposed and fixed stale form values in an already-open local tab when a run starts elsewhere.

This is a browser-based implementation. The experimental independent HTTP flow worked through boarding enquiries but returned **403 Access Denied** at fare preparation. See [the investigation](docs/api-investigation.md); it is not used as a fallback here.

Implementation: `app/server.mjs` is the loopback server, `app/jobs.mjs` manages one booking and payment recovery, `app/queue.mjs` sequences journeys, `app/stations.mjs` searches/imports public stations, `app/irctc.mjs` drives visible controls, and `web/` contains the interface. There are no third-party runtime dependencies. Live single-journey preparation has been verified; multiple real ticket purchases in one list have not been exercised.
