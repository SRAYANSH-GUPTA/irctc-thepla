# API investigation: independent login through fare preparation

Observed on 13 October 2026, including follow-up independent HTTP tests. This extends the earlier [request map](api-flow.md). Full field-name/type observations are in [observed-schemas.json](observed-schemas.json); no original credentials, tokens, passenger values, or ID numbers are stored there.

## Result

**Browserless checkout is not verified.** A fresh Node HTTP client, without browser cookies or tokens, successfully logged in, validated the account, read the master passenger list, searched trains, checked class availability, and loaded boarding options. The subsequent fare request returned **HTTP 403**, `text/html`, with an Access Denied page. A second complete test supplied the normal POST Origin header and honored the server's minimum passenger-input delay; it reached the same 403. No independent payment-initiation request was made.

| Independent HTTP stage | Result |
| --- | --- |
| Login configuration | 200; server explicitly enabled the normal no-CAPTCHA login flow |
| Token request | 200; access token obtained |
| Account validation | 200; decrypted account name matched the supplied login |
| Saved passengers | 200; exactly one requested passenger found |
| Train search | 200 |
| Class availability | 200; 2A, ₹1,455, PQWL4/WL2 |
| Boarding options | 200 |
| Fare preparation | 403 Access Denied, twice |
| API payment initiation / ticket confirmation | Not attempted / not established |

These tests prove partial independent HTTP access, not a supported integration contract or a complete booking client. The cause of the fare denial is unconfirmed. No access-denial workaround was attempted.

The existing signed-in session initially worked for searches. A later availability call returned 401 and the UI displayed a session-error page. One subsequent login attempt showed **Invalid User**. After the user reported that the browser had autofilled the credentials and requested another submission, login succeeded. The account control reappeared and authenticated enquiries succeeded.

Browser preparation reached `/eticket/booking/reviewBooking`, then `/eticket/payment/bkgPaymentOptions`, for:

| Item | Observed value |
| --- | --- |
| Train | KASHI V NATH EX (15128) |
| Departure | New Delhi (NDLS), 14 October 2026, 11:35 |
| Destination | Ma Belhadevi Dp (MBDP), 15 October 2026, 00:25 |
| Class / quota | AC 2 Tier (2A), General |
| Passenger | Saved Srayansh Gupta record |
| Availability | PQWL4/WL2 — waitlisted |
| Fare | ₹1,455.00 |
| UPI convenience fee including GST | ₹23.60 |
| Review total | ₹1,478.60 |

No payment was initiated for this new journey, and no ticket was issued. After the independent HTTP tests and a browser session error, the same journey was rebuilt through a fresh ordinary browser login. Fare review and payment options were verified again at the listed amount and waitlist status. The final handoff leaves the browser on payment options; Pay & Book was not pressed. Temporary HTTP session/token and passenger-payload files were deleted after testing. These amounts and statuses are observations, not future guarantees.

## What the second capture adds

The first capture kept only metadata. The second inspected request/response structures in memory and retained field names and sampled types. Primitive values were discarded. Array shapes describe the first element, not every possible member. Null and empty arrays do not establish their complete schema. Seeing a field in one request does not prove it is required or identify all permitted values.

The following exact paths were verified from browser resource URLs. The older logger's `:value` redaction had hidden the `mapps1` segment:

```text
POST https://www.irctc.co.in/authprovider/webtoken
GET  https://www.irctc.co.in/eticketing/protected/mapps1/validateUser
POST https://www.irctc.co.in/eticketing/protected/mapps1/altAvlEnq/TC
POST https://www.irctc.co.in/eticketing/protected/mapps1/allLapAvlEnq
POST https://www.irctc.co.in/eticketing/protected/mapps1/boardingStationEnq
GET  https://www.irctc.co.in/eticketing/protected/mapps1/masterpsgnlistenquiry
POST https://www.irctc.co.in/eticketing/protected/mapps1/allLapAvlFareEnq/Y
```

These are observed website interfaces, not a documented third-party integration contract.

## Login and authentication

`POST /authprovider/webtoken` used form encoding with these names:

| Field | Observed structure |
| --- | --- |
| `grant_type` | String |
| `data` | Encrypted login payload; construction checked against the current official application bundle during the HTTP follow-up |
| `captcha` | String |
| `uid` | String |
| `otpLogin` | Form string parseable as a boolean |
| `encodedPwd` | Form string parseable as a boolean |

The successful response contained `access_token` (string), `refresh_token` (string), `token_type` (string), and `expires_in` (number). The unsuccessful response also used HTTP 200 but contained `error` and `error_description`. The UI outcome is therefore essential; 200 is not proof of login.

Protected enquiries used an `Authorization: Bearer …` header. The independent implementation followed the official client's `bmirak`, `bmiyek`, `greq`, and `spa-csrf-token` handling, updating the sequence token from `csrf-token` responses. No refresh-token flow was verified. One observed token lifetime was only about 88 seconds; a later enquiry after an analysis pause returned 401. A successful login is not a durable session guarantee.

The independent sequence was:

1. Start a new HTTP cookie jar and GET the official `/eticket/` page.
2. Generate a fresh timestamp/UUID request identifier and GET `/eticketing/protected/mapps1/newandalerts` with the application's normal headers.
3. Proceed only when the server's `WITHOUT_CAPTCHA_LOGIN` configuration explicitly equals `1`. Use the official client's `NA` value only in that enabled flow. Otherwise stop for the required verification.
4. Construct the login payload using the current official client's password encoding and AES-CBC transformation, then POST the form to `/authprovider/webtoken`. Check the response body for authentication errors even on HTTP 200.
5. GET `/eticketing/protected/mapps1/validateUser?source=3` with the returned session credentials. Decode the profile fields according to the official client and verify that the account matches before proceeding.
6. Use the validated user hash and response sequence tokens for subsequent enquiries. Respect train-specific booking configuration and the minimum passenger-input time.

No browser authentication state was imported in these successful login tests. The first exploratory login omitted the server-configured CAPTCHA sentinel and returned `Invalid Request`; reading configuration and matching the normal application protocol resolved that error. This observation does not establish that future login attempts will be CAPTCHA-free.

## Search, passengers, and fare structures

| Request | Observed body structure / useful response fields |
| --- | --- |
| `altAvlEnq/TC` | JSON with `srcStn`, `destStn`, `jrnyClass`, `jrnyDate`, `quotaCode`, `ticketType`, `currentBooking`, and concession/flexi/foreign-tourist/loyalty flags. Response contains `trainBtwnStnsList`, alternate train list, and quota list. |
| `allLapAvlEnq` | JSON with booking flags and `alternateAvlInputDTO[]`; its members include `trainNo`, `srcStn`, `destStn`, `jrnyDate`, `quotaCode`, `ftBooking`, `avlClasses[]`, `concessionPassengers`. Response groups class availability/fare in `trainBtwnStnsList[].classAvlDTO[]`; dates/statuses are in `avlDayList[]`. |
| `boardingStationEnq` | Similar booking envelope, with selected `jrnyClass` in `alternateAvlInputDTO[]`. Response includes `boardingStationList[]`, `bkgCfgs[]`, and `minPsgnInputTime`. Config fields describe applicable berth/ID types, passenger limits, food, insurance, and verification settings. Values were not retained; do not hardcode assumptions from the master-list menu. |
| `masterpsgnlistenquiry` | GET with no observed request body. Response `passengerDetailList[]` includes saved identity/reference fields, DOB/age, preferences, and verification fields. Names/types only retained. |
| `allLapAvlFareEnq/Y` | JSON envelope includes session/user and transaction references, boarding/reservation stations, contact, booking/payment choices, GST/address placeholders, and `lapAvlRequestDTO[]`. Each lap includes train/date/class/quota, preferences, insurance, `passengerList[]`, and `infantList[]`. Passenger objects contain personal fields, saved-record references, concession fields, and verification flags. |

Fare responses include `avlFareResponseDTO[]`, `totalCollectibleAmount`, `totalwpServiceCharge`, and `bankDetailDTO[]`. Individual fare components and response amounts were string-typed in the sample. Availability request `paymentType` was a number; the fare request used a string. These observed differences mean a guessed universal payload should not be used.

The exact types and nested field lists are retained in [observed-schemas.json](observed-schemas.json). This is evidence from particular requests, not a generated OpenAPI specification or ready-to-submit payload template.

## Earlier direct HTTP test and its limits

Before the successful fresh login, one **read-only availability enquiry** was tested through Node's HTTP client, using the observed request body and the then-current browser session. Authorization and cookies stayed in memory. The client copied standard application headers but did not reproduce the unexplained custom headers. Redirects were disabled. Only the observed availability endpoint was eligible; no booking or payment request was replayed.

The response status was **200**, with no content-type value and no parseable availability JSON. This did **not** establish a working API enquiry. No explicit challenge was identified, and the reason for the response is unknown. A separate later browser availability request returned 401; its causal relationship to the probe is not established. No attempt was made to bypass access controls or fabricate the missing custom headers.

The probe also depended on browser-derived authentication. Even if that one enquiry had worked, it would not have demonstrated independent username/password login or browserless booking.

## Remaining implementation gaps

- Supported integration/API contract and permitted usage.
- The fare endpoint's HTTP 403 response and successful independent fare preparation.
- Complete authentication/session/CSRF lifecycle, renewal, and error handling. Initial login and enquiry headers were tested; renewal was not.
- Complete field formats, enums, requiredness, and train-specific validation.
- Booking initiation, payment, and callback body schemas, plus idempotency/reconciliation semantics.
- Independent payment handoff, reconciliation, and end-to-end ticket confirmation.

No new payment attempt was made merely to obtain its schema. The browser payment-options screen is separate from a payment gateway or a confirmed ticket; its session and availability can expire.
