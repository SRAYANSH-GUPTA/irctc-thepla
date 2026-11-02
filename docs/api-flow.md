# IRCTC observed requests and passenger requirements

Observed in Chromium on **13 October 2026 (Asia/Kolkata)**. This records requests made by the website during ordinary browser actions. It is not a verified browserless API contract. See [browser-and-login.md](browser-and-login.md) for the setup and chronological record.

**Follow-up:** [api-investigation.md](api-investigation.md) records independent HTTP login, account validation, saved passengers, search, availability, and boarding enquiries. Fare preparation still returns HTTP 403, so browserless checkout is not verified. [observed-schemas.json](observed-schemas.json) contains sanitized field names/types.

## What we have established

- Login, journey search, class availability, selection of an existing passenger, fare calculation, review, and payment-provider selection were exercised through the UI.
- An IRCTC iPay attempt reached a server error. A later Paytm UPI attempt reached its QR page. No confirmed ticket or PNR was observed. The latest home-page inspection showed **Payment Failed** for the last transaction. Bank debit/refund status was not independently verified.
- **Srayansh Gupta was successfully added to the master list** with the supplied DOB, Male, Window Side, No Food/Beverages, and **AADHAR ID/VIRTUAL ID** plus the supplied number. The success message and exactly one matching saved row were verified. Identity verification itself was not established.
- A fresh HTTP client now completes login and enquiries through boarding options without using browser authentication. Fare preparation returns HTTP 403 Access Denied. Complete schemas, session renewal, independent payment, and ticket confirmation remain unverified; there is no complete API-only booking client.

## How to read the map

`I` = `https://www.irctc.co.in`; `W` = `https://www.wps.irctc.co.in`.

`:value` is observer redaction, which can hide version segments as well as identifiers. These are not directly callable URLs. Query names are retained; values are omitted. HTTP 200 alone does not prove login, payment, or booking success.

The observer recorded first-party XHR, Fetch, and Document metadata, excluding headers, bodies, cookies, tokens, and query values. The methods/statuses below come from network events. Purpose descriptions are UI correlations or endpoint-name interpretations, not verified response contracts. Observation was not continuous across all tabs and session transitions.

## Request inventory

| Apparent purpose / stage | Host | Method | Redacted path | HTTP statuses | Evidence / limitation |
| --- | --- | --- | --- | --- | --- |
| Station data | I | GET | `/eticketing/protected/:value/stationData` | 200 | Initial loading; purpose inferred from name |
| News/alerts | I | GET | `/eticketing/protected/:value/newandalerts` | 200 | Initial loading; purpose inferred from name |
| Countries | I | GET | `/eticketing/protected/:value/country` | 200 | Loading/forms; payload not inspected |
| Countries/dialing codes | I | GET | `/eticketing/protected/:value/countryWithISD` | 200 | Profile flow; purpose inferred from name |
| Unclassified profile helper | I | GET | `/eticketing/protected/profile/textToNumber/:value` | 200 | Plain-text response; purpose unverified |
| Login/session flow | I | POST | `/authprovider/webtoken` | 200 | Seen around login; token format/headers unknown |
| User/session validation | I | GET | `/eticketing/protected/:value/validateUser` | 200 | Query name: `source`; payload unknown |
| Wallet/bank information | I | POST | `/eticketing/protected/ewallet/depositBankList` | 200 | Not proven necessary for every booking |
| Journey search | I | POST | `/eticketing/protected/:value/altAvlEnq/TC` | 200 | Search Trains flow |
| Train/class availability | I | POST | `/eticketing/protected/:value/allLapAvlEnq` | 200, 401 | Class results; a later 401 led to session-error UI |
| Boarding stations | I | POST | `/eticketing/protected/:value/boardingStationEnq` | 200 | Passenger-stage entry; payload unknown |
| Saved passengers | I | GET | `/eticketing/protected/:value/masterpsgnlistenquiry` | 200 | Existing Passenger/master-list flow |
| Add saved passenger | I | POST | `/eticketing/protected/:value/masterpsgnlistadd` | 200 | Add once; success message and exactly one matching saved row verified |
| Fare enquiry | I | POST | `/eticketing/protected/:value/allLapAvlFareEnq/Y` | 200 | Calculate Fare flow |
| Add-on services | I | POST | `/eticketing/protected/:value/addonServices` | 200 | Exact dependency/order unverified |
| Initiate booking/payment | I | POST | `/eticketing/protected/:value/bookingInitPayment/:value` | 200, 401 | Query name exactly observed: `insurenceApplicable`; transaction-changing |
| Payment redirect | W | POST | `/eticketing/PaymentRedirect` | 200, 500 | One iPay attempt displayed a server error |
| Provider return/callback | W | POST | `/eticketing/BankResponse` | 200 | Callback reception does not prove payment success |
| Booking data | W | GET | `/eticketing/protected/:value/bookingData/:value` | 200 | Returned schema unknown |
| Recent transactions | I | GET | `/eticketing/protected/:value/recentTxnsDetails` | 200 | Last-transaction/status flow |
| Failed history | I | GET | `/eticketing/protected/:value/failedTxnHistorySearch` | 200 | Failed history showed the earlier attempt |
| Booked history | I | GET | `/eticketing/protected/:value/bookedHistorySearch` | 200 | Used to check for an issued ticket |
| Account profile | I | POST | `/eticketing/protected/:value/getUserProfile` | 200 | My Profile inspection; no profile edit submitted |

The browser also reached `https://secure.paytmpayments.com/theia/processTransaction`. This gateway was outside the first-party observer. Its page showed a QR payment flow; method, payload, and callback contract were not captured. The supplied UPI address was not entered into that QR flow.

**Add-master-passenger mutation observed:** clicking Add submitted `POST /eticketing/protected/:value/masterpsgnlistadd` and returned HTTP 200. The UI reported “Passenger has been successfully added to Master List,” and exactly one matching saved record appeared. Method/path/outcome are verified; its request/response body contract was not captured. Do not infer JSON keys from DOM form-control names.

## Browser sequence and dependencies

1. Open the official site and verify authenticated account UI. If needed, use LOGIN and complete any verification the site requests.
2. Select origin, destination, date, quota, and concession; click Search Trains. Search route: `/eticket/train-search`; results: `/eticket/booking/train-list`.
3. Check the intended train's availability, choose class, then BOOK. Passenger route: `/eticket/booking/psgninput`.
4. Review boarding station and passengers. Existing Passenger opens the saved list; select its actual checkbox and click Add. Clicking the name alone did not reliably select it.
5. Review contact data and preferences. Observed controls included insurance, auto-upgradation, confirmed-berth choice, preferred coach, reservation choice, optional GST details, and payment category.
6. Click Calculate Fare and wait for `/eticket/booking/reviewBooking`. One calculation exceeded the helper's initial 20-second timeout but eventually completed. A timeout does not prove submission failure.
7. Verify itinerary, passengers, availability, and total, then Continue To Payment to `/eticket/payment/bkgPaymentOptions`.
8. Select a provider and verify its selected state. Pay & Book starts the transaction-changing payment flow; initiation is not ticket confirmation.
9. Complete the gateway interaction. Observed Paytm UPI required scanning a QR and approving on the user's device.
10. Reconcile the provider return with IRCTC status and booked history. Require confirmed ticket details and PNR before recording success. This final success state has not been demonstrated here.

This is a UI-stage sequence, not a proven server-call dependency graph. Some inventory requests are supporting calls, not necessarily mandatory steps.

## Saved-passenger form

Account menu → **My Profile** → **Modify master list**. Route: `/eticket/profile/add-masterpassenger`.

Requirements below come from visible labels and current form validation, not a server-side specification. This is the reusable master list; one-off booking entry may have different fields.

| Field | Observed requirement / choices | Saved record / observed entry |
| --- | --- | --- |
| Concession | Required: Normal User, Person With Disability, Escort | Normal User |
| Full name as per Govt. ID | Required | Srayansh Gupta entered |
| Date Of Birth | Required; placeholder says `DD/MM/YYYY`, but picker produces `DD-MM-YYYY`; no separate age field here | Supplied DOB selected through calendar and verified |
| Nationality | India preselected and disabled in this form | India |
| Gender | Required: Male, Female, Transgender | Male, supplied by user |
| Berth Preference | Required; choices below | Window Side, as requested and observed selected |
| Catering Service Option | Required: Veg, Non Veg, No Food/Beverages, Tea/Coffee | No Food/Beverages, supplied by user |
| ID Card Type | No required marker; user requested AADHAR ID/VIRTUAL ID | Selected |
| ID Card Number | Placeholder “Enter number”; no required marker or length constraint visible | Supplied number entered and verified in field; excluded from this document |

Berth choices: **No preference, Lower, Middle, Upper, Side Lower, Side Middle, Side Upper, Window Side, Cabin, Coupe**. This generic menu does not establish which choices apply to a given train/class or guarantee allotment.

Other ID types listed: Bank Passbook, Credit Card with Photo, Driving License, Govt Issued ID-Card, PAN Card, Passport/Travel Document, Student ID-Card, Voter ID-Card. Conditional validation and verification after submitting an ID have not been exercised. Selecting Aadhaar does not verify it.

DOM form-control names observed: `masterConcessionType`, `masterPassengerName`, `dob`, `nationality`, `gender`, `berthPreference`, `foodPreference`, `idCardType`, `idCardNumber`. These are useful browser selectors; they are **not verified API payload keys**.

The DOB control is `p-calendar[formcontrolname="dob"]` with `dateformat="dd-mm-yy"`. Direct text entry did not persist in this session. Selecting year, month, and day through the visible calendar produced a valid `DD-MM-YYYY` field. Verify the resulting value and validation state instead of assuming a successful text-insertion command populated it. For identity entry, refocus immediately before inserting text and verify a match without logging the value.

Save sequence exercised: obtain all required choices, verify the form has no invalid controls, click Add once, wait for the success message, and verify exactly one matching saved passenger row. Its displayed DOB, gender, berth, food, and ID type matched the requested values. A click or HTTP 200 alone is insufficient. No additional identity-verification step was completed; record creation and Aadhaar verification are separate outcomes.

## Automation inputs and remaining work

Credentials alone are insufficient. A runner needs:

- Journey: station codes, date, train, class, quota, boarding point, permitted alternatives.
- Passengers: exact saved-record selection or complete passenger details, with duplicate detection.
- Preferences: berth/food, insurance, upgrade/confirmation constraints, applicable concession.
- Contact/invoice data: review site contact fields; GST details only when requested.
- Payment: maximum total, category/provider, user approval when required.
- Runtime state: session validity, verification wait, current stage, pending transaction reference, reconciliation status.

Keep passwords, tokens, Aadhaar/VID, payment credentials, and OTPs out of committed files and logs. The temporary browser profile contains session state even though the metadata log excludes it.

Before claiming browserless booking works:

1. Establish the applicable supported integration and obtain its specification/credentials. Observing website endpoints does not establish a supported third-party API contract.
2. Verify authentication/session lifecycle, complete request/response schemas, errors, and permitted request rates. The follow-up resolved six protected paths to `mapps1` and sampled field types, but this does not establish the full contract.
3. Implement verification, payment-approval, session-expiry, and uncertain-outcome states.
4. Serialize booking/payment changes for one intent. Do not make duplicate parallel submissions or blindly retry a timeout, 401, 500, or callback. Reconcile transaction status first; idempotency behavior is unknown.
5. Re-read live availability and the final amount. Payment category and insurance changed the observed total in this session.
6. Verify a complete successful confirmation and interrupted-payment recovery in a supported test environment or an intended booking. Independent login and enquiries through boarding now work in the experimental test, but fare preparation is denied. Direct payment and parallel booking have not been tested.

The project now includes [Rail desk](../README.md), a runnable local interface and browser booking runner. Saved and new passenger preparation were verified through payment options. The independent API-only client remains incomplete; this app uses the website's visible controls.
