# IRCTC browser and login record

Recorded on **13 October 2026, Asia/Kolkata**. [api-flow.md](api-flow.md) contains the request inventory, booking sequence, passenger fields, and implementation gaps.

**Current status:** Srayansh Gupta is saved in the master list. A new journey reached browser payment options: 15128, 14 October, 2A, PQWL4/WL2, ₹1,478.60. No payment was initiated for that journey. Independent HTTP login and enquiries through boarding work, but fare preparation returns HTTP 403 Access Denied. Earlier payment attempts produced no observed confirmed ticket or PNR; the last inspected home-page transaction status was Payment Failed. See [api-investigation.md](api-investigation.md) for the latest schema and direct HTTP findings.

## Browser setup

1. Inspected the initially empty project directory.
2. Tried the built-in browser, which reported unavailable. Browser inventory also showed no connected browser.
3. After the user requested Chromium debug mode, checked Chromium and port 9222. The existing browser did not have remote debugging enabled.
4. Started a separate temporary profile, leaving the existing profile untouched:

```sh
chromium --user-data-dir=/tmp/tatkal-chromium-review --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check about:blank
```

5. Discovered the page through `http://127.0.0.1:9222/json/list` and connected to its DevTools WebSocket with Node.js. Targets were rediscovered rather than hardcoded.
6. Created `/tmp/tatkal-browser.mjs` for CDP inspection/interaction. No Playwright or Puppeteer installation was required.
7. Opened `https://www.irctc.co.in/nget/train-search` using `Page.navigate` and brought the tab forward with `Page.bringToFront`. The initial language dialog disappeared before the attempted English click; the helper did not successfully choose it.
8. Started passive first-party request metadata observation. Each observer attaches to one page target and stops after 20 minutes. Tab changes and observation gaps mean this is not a complete capture.

The built-in-browser and chrome-browser skills were consulted earlier. Direct CDP followed the explicit debug-mode request and unavailable browser-tool connections.

## Login steps and evidence

1. Initially handed login to the user. A later visible password field did not establish successful authentication.
2. The user supplied credentials and explicitly requested login. The tab was then on `/eticket/booking/train-list`, with a journey already selected. The assistant had not performed that initial search or transition to the newer interface.
3. Rediscovered the target, clicked header LOGIN, and inspected the form with `Enter Username` and `Enter password` inputs.
4. Sent credentials through non-echoing standard input. The helper checked the exact official origin, focused the fields, and used CDP `Input.insertText`. Values were not embedded in source, shell command arguments, or project documents.
5. Clicked LOGIN inside the password-containing form once and waited.
6. Verified that the dialog closed and the account control replaced LOGIN. No CAPTCHA or OTP appeared in that successful attempt.
7. After an unsuccessful payment redirect and full-page navigation, the session no longer showed authentication. A later login attempt displayed “Invalid User.” The user then manually signed in; authenticated UI was observed again.

HTTP 200, a loaded search page, or disappearance of a dialog alone is not proof of login. The temporary `status` command does not fully recognize the newer account control; explicit UI inspection was needed.

A reusable runner should check current authentication, obtain credentials from a local runtime/credential source if needed, wait for any user verification, then verify the account UI. Username/password alone cannot guarantee an unattended flow. CAPTCHA/OTP handling was not bypassed or implemented.

**Field-entry correction from the latest test:** a later Invalid User response was traced to a duplicated username in the visible input. The original helper's `select()` followed by text insertion had not reliably replaced autofilled content. The helper now focuses each official login field, clears it with the native input value setter and an input event, inserts the provided value, and verifies exact equality without logging it. Submitting the corrected form succeeded. This explains that observed failure, not necessarily every earlier Invalid User response.

## Booking and payment actions exercised

1. Checked PADMAVAT EXP (14208) and DLI BSB SPL (04210). Sleeper was unavailable in the inspected results.
2. After the user requested an AC alternative, selected 2A on DLI BSB SPL (04210), New Delhi → Ma Belhadevi Dp, 13 October 2026, General quota. Reached `/eticket/booking/psgninput`.
3. At the user's instruction, opened Existing Passenger, selected the checkbox for saved passenger Shivam Kumar, and clicked Add. Name text alone did not reliably select the checkbox. No biographical details were invented.
4. Inspected contact/other preferences, calculated fare, reached `/eticket/booking/reviewBooking`, then `/eticket/payment/bkgPaymentOptions`.
5. Initial total: ₹1,910.85, comprising ₹1,875 fare, ₹35.40 convenience fee, ₹0.45 insurance. These are observations, not current pricing guarantees.
6. The user supplied a UPI address and explicitly authorized purchase. Selected UPI category and deselected insurance; the total became ₹1,898.60, including ₹23.60 convenience fee.
7. Selected IRCTC iPay anShivamd clicked Pay & Book. The payment redirect returned HTTP 500 and “Sorry please try again.” Successful initiation did not establish a booked ticket.
8. Following manual sign-in, checked failed/booked history and last-transaction details. The earlier attempt appeared in failed history; no matching booked ticket was seen. The detail explicitly showed **Not Booked** and no PNR.
9. Re-entered the same authorized journey, checked availability, selected the saved passenger, and recalculated. Calculation exceeded the initial 20-second helper wait, but eventually advanced without a duplicate submission.
10. Selected Paytm UPI using its visible provider image/card and verified selection. Pay & Book reached `https://secure.paytmpayments.com/theia/processTransaction`, with a ₹1,898.60 QR and limited validity period.
11. Asked the user to scan and approve on their device. No UPI-address input was visible in that flow; the supplied address was not entered. Payment approval/debit was not confirmed to the assistant.
12. Later inspection found the browser back on IRCTC with changed preferences; who navigated back or changed them was not established. A subsequent home-page inspection showed **Payment Failed**. Bank debit/refund status remains independently unverified.
13. The user requested API documentation and a new passenger. No further payment submission was made for this request.

## New saved passenger

1. Opened account menu → My Profile → Modify master list: `/eticket/profile/add-masterpassenger`.
2. Entered **Srayansh Gupta** in Full name as per Govt. ID.
3. Inspected labels, dropdown options, and form validation. DOB, gender, berth, and food choice remained missing. Concession was Normal User; nationality was India and disabled.
4. At the user's instruction, selected **AADHAR ID/VIRTUAL ID**. Entered the supplied number through non-echoing standard input, refocusing immediately before insertion, and verified equality without outputting its value. An initial entry attempt had not populated the field. Selecting this type does not verify the identity.
5. The user suggested Window Side, then asked to see available choices. Opened the berth menu and left it unselected.
6. Subsequent UI inspection showed Window Side selected. Set Male after the user supplied gender. Direct DOB text entry did not persist, so selected the supplied year, month, and day through the calendar. Verified the resulting DOB and valid form state; the picker uses hyphens despite the slash-based placeholder.
7. After the user chose no food, selected No Food/Beverages. Verified the name, DOB, all dropdown choices, filled ID, and absence of invalid form controls.
8. Clicked Add once. Observed `POST /eticketing/protected/:value/masterpsgnlistadd` returning 200 and the success message “Passenger has been successfully added to Master List.”
9. Verified exactly one matching saved row and matching DOB, Male, Window Side, No Food/Beverages, and Aadhaar/Virtual ID. Identity verification was not established by this save. Requirements/options are in [api-flow.md](api-flow.md#saved-passenger-form).

## Evidence and implementation status

Follow-up: the existing session was reused for enquiries, then a 401 availability response led to the site's session-error page. After returning through “Click here to login,” the first credential submission displayed Invalid User. At the user's direction, submitted the browser-autofilled form; the account UI and a successful token-response structure confirmed login. Repeated the search, checked 14 October availability, selected saved Srayansh Gupta on train 15128 in 2A, and calculated the fare successfully. Continued from review to payment options without pressing Pay & Book. A separate early Node availability probe using the earlier session returned 200 without usable JSON; that early test alone established no browserless access.

The latest independent test used a fresh cookie jar, read login configuration, authenticated with the supplied credentials, checked the matching account, loaded saved passengers, searched trains, checked availability, and loaded boarding configuration. All those stages succeeded. Fare preparation returned 403 Access Denied, including on a corrected test with Origin and the required passenger-input delay. No direct payment request was made. Its browser session later showed a session error, so the ordinary UI preparation was rebuilt after fresh login. Initial enquiry success must not be described as complete browserless checkout.

The second observer retained request/response field names and sampled types while discarding original primitive values. Its reviewed export is [observed-schemas.json](observed-schemas.json). Earlier statements below about the metadata-only log apply to that first log, not the separate schema capture.

`/tmp/tatkal-network-metadata.jsonl` records timestamps, methods, first-party hosts, redacted paths, query names, resource types, HTTP status/MIME types, and loading errors. It excludes bodies, headers, cookies, tokens, and query values. It is not a HAR or replayable session. Redaction can hide version segments; alphabetic path segments can survive, so review before sharing.

The temporary browser profile may contain cookies; keep it local and out of source control. Credentials, passenger identity numbers, and payment data are excluded from these documents.

Retained code now includes [Rail desk](../README.md): the local UI in `web/`, server and browser runner in `app/`, CDP helpers in `scripts/lib/`, and tests in `tests/`. Saved and new passenger runs reached payment options automatically on 13 October 2026. The payment preflight was tested without submitting payment. The earlier temporary helper remains an investigation tool, not the shipped credential store or runner.

Unverified: complete API-only booking, session renewal, complete request/response schemas (including passenger save), successful ticket confirmation, identity verification, gateway reconciliation details, and parallel operation. Initial independent login and enquiries are now verified for this test. Check transaction state before repeating booking/payment operations.
