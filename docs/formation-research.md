# Formation research: real intake + real filing APIs

Researched 2026-11-12. Every claim has a primary-source URL, mostly provider docs, help centers or government pages.
**UNVERIFIED** means the claim came from a secondary source or we could not open the page. Nothing was signed up for or submitted.

---

## TL;DR

1. **Best option: the doola Partner API** (https://docs.doola.com/api/introduction). It is a public, documented REST API with a sandbox (`api.test.doola.com`, `dk_test_` keys).
   - It forms a WY LLC or a DE C-Corp, orders the registered agent and the EIN, and has a white-labelled SS-4/8821 signing flow for founders without an SSN.
   - It sends HMAC webhooks and returns real documents (Articles, Operating Agreement or Bylaws, SS-4, EIN letter).
   - Sandbox-only endpoints let us complete the formation and EIN steps on demand. **Catch:** the keys come only after a partner agreement (https://docs.doola.com/api/faq.md), so we can't self-serve.
2. **Fallback: FileForms (FileFormsPro API).** Signup is **self-serve**. The staging and production keys are issued immediately at apps.fileforms.com with no contract or sales call (https://fileforms.com/?p=7398).
   - It supports formation, EIN (including `responsiblePartyIsForeign: true`) and registered agent through `POST /v1/orders`.
   - **Catch:** live filings need a prepaid balance, and the docs don't show a white-labelled SS-4 signature flow.
3. **FinCEN BOI:** the final rule took effect 2026-08-14. **US-formed companies are exempt**, so we don't collect BOI (https://www.fincen.gov/boi).
4. **IRS EIN without an SSN:** the online EIN application isn't allowed. The IRS says founders must fax (≈4 business days per the IRS) or mail an SS-4, and "Foreign" goes on line 7b (https://www.irs.gov/instructions/iss4).
   - Providers quote much longer real-world times. doola: fax 8–11 weeks, or 6–9 with expedite. Atlas: 5–35 business days.

---

## Part 1: Intake flows of existing products

### 1.1 Stripe Atlas
Source: https://docs.stripe.com/atlas/signup

- **Price:** $500 one-off, which covers government fees and the first year of registered agent (https://stripe.com/pricing).
- **States and entities:** Delaware only, as a C-Corp, LLC or C-Corp subsidiary.

**Steps / fields:**
1. **Company structure:** C-Corp, LLC or subsidiary. A subsidiary also needs the parent's legal name, country and tax ID.
2. **Company name:** legal name. Atlas checks it against DE name availability. No alternates were mentioned.
3. **Company description:** a few sentences, used to screen restricted businesses.
4. **Company website**, or a LinkedIn/X profile ("to verify that you're a real person").
5. **Company address:** goes on the SS-4. A home or virtual address is allowed, and the IRS mails CP 575 there.
6. **Company US phone:** used only on the SS-4. A personal or virtual number is allowed.
7. **Founders:** for each founder:
   - first and last name as on government ID
   - email
   - **DOB (submitter only)**
   - **SSN or ITIN**, used on the SS-4 and the 83(b)
   - **home address**, used for ID verification and the 83(b)
8. **Ownership:** each founder's %. A C-Corp also sets an equity pool.
9. **Roles:** Board of Directors (or LLC Managers). A C-Corp needs a President and a Secretary, which one person may hold.
10. **E-signature:** Atlas applies the signatures in the legal sequence.

**What Atlas assumes on the SS-4:**
- no W-2 employees in the next 12 months
- no highway vehicle over 55k lb
- no Form 720
- no gambling
- no alcohol, tobacco or firearms

Atlas also files Form 8821 so it can call the IRS.

**Timelines:**
- DE filing: 1–2 business days.
- EIN: 1–3 business days with a US SSN, US address and US phone. Without an SSN: **5–35 business days**.

**Documents and what follows:**
- Certificate of Incorporation, board approval/consent, stock issuance, an 83(b) that is always filed, and the EIN letter.
- Shares are bought with IP at a $100 FMV.
- A C-Corp owes DE franchise tax and an annual report by Mar 1. A DE LLC owes $300 by Jun 1 (https://docs.stripe.com/atlas/business-taxes).

**Banking:** Stripe Payments and Treasury can start before the EIN.

### 1.2 doola (consumer flow)
Sources: MCP flow https://docs.doola.com/mcp/flow.md, docs page https://www.doola.com/?p=8009, pricing https://www.doola.com/pricing/

- **Price:** Starter $297/yr plus the state fee, covering formation, EIN and a US address. Tax & Compliance $1,999/yr adds federal/state tax filing. Business-in-a-Box $2,999/yr.
- **States and entities:** LLC or C-Corp in all 50 states. The default is a **Wyoming LLC**.
- **No passport at formation:** "You won't need to submit a passport at this stage". A passport is needed only for a bank account such as Mercury.

**Steps** (the same steps the doola MCP server runs):
1. Legal first and last name, as on ID.
2. Country of residence (ISO alpha-3).
3. Company name, without the suffix.
4. State and entity type.
5. Accept the ToS, then pay through Stripe checkout. **Payment comes before the detail questions.**
6. Industry: an exact NAICS label from `search_industries`.
7. Description: ≤50 characters. Optional selling platform.
8. Up to **2 alternate names**.
9. Registered address: doola's registered agent is included.
10. Mailing address: defaults to the RA address, which is required if the founder has no US address.
11. **Members (LLC):** legal name, **ownership %** (must total 100), address and phone.
    **Executive members (C-Corp):** President, Secretary, Treasurer and Director, plus the share structure (authorized shares and par value).
12. **Responsible party:** legal name, email (the SS-4 and 8821 go there) and address.
13. Optional SSN, entered on a doola-hosted page.
14. Review the summary and confirm. `submit_formation` is irreversible.

**DOB** isn't collected (https://docs.doola.com/mcp/flow.md).

**Timelines** (https://docs.doola.com/api/faq.md):
- State filing: about 1 week on average. Marketing says 1–2 business days.
- EIN online: 1–2 business days, only for an LLC whose responsible party has an SSN and a US address.
- EIN otherwise: fax, **8–11 weeks**, or 6–9 weeks with expedite. Slower Dec 15–Apr 30.

**Documents:**
- Articles of Organization
- Operating Agreement (LLC) or Corporate Bylaws (C-Corp)
- signed SS-4 and Form 8821
- EIN letter
- annual report filings (https://docs.doola.com/api/webhooks.md)

**Other services:** Form 5472/1120, ITIN and banking setup are offered (https://www.doola.com/company-formation-api).

### 1.3 Firstbase
Sources: https://www.firstbase.io/pricing, https://www.firstbase.io/guide/what-to-consider-before-launching-a-us-company

- **Price:** "Start" is listed at $399, shown as $99 plus the state fee.
  - It includes DE or WY formation, expedited EIN setup and a bank account through partners.
  - **Registered agent is required and extra:** Agent costs $299/yr per state and includes annual report, franchise tax and BOI filings.
  - Tax filing for a non-US single-member LLC costs $899/yr and includes **Form 5472 plus a pro forma 1120**. C-Corp or multi-member: $1,799/yr.
- **States and entities:** Delaware and Wyoming only, as LLC or C-Corp.
- **Intake fields: UNVERIFIED.** The help-center article on non-US founders returned HTTP 403 (https://help.firstbase.io/hc/en-us/articles/360056959292). Secondary reviews say the bundle includes a stock purchase agreement and bylaws (https://www.rho.co/blog/firstbase-review).
- **EIN for non-SSN founders:** supported, but no timeline is published. A secondary source says 3–4 weeks (UNVERIFIED).
- **Note:** Firstbase guides say foreign-owned entities may also owe a **BE-13** to the BEA within 45 days.

### 1.4 Clerky
Sources: https://www.clerky.com/pricing, https://help.clerky.com/article/2820-formation-timeline

- **Entity:** Delaware C-Corp only (PBC supported). No LLCs.
- **Price:**
  - Pay-per-use incorporation: $427. Includes expedited DE filing and the first year of registered agent.
  - Post-incorporation setup: $299. Covers bylaws, initial board consent, stock purchase and a pre-filled 83(b).
  - Lifetime package: $819.
  - EIN: "Outside of the US? Apply for an EIN through Clerky", price not shown.
- **Timeline:** DE returns in 1–2 business days (expedited).
- **Non-US founders:**
  - The IRS phone EIN route is unavailable for DE corporations (https://help.clerky.com/article/2928-non-us-address-ein-by-phone).
  - Clerky warns about transfer pricing and outbound-investment limits (https://help.clerky.com/article/2819-founders-located-outside-us).
- **Exact questionnaire fields: UNVERIFIED.** The intake runs behind a login. Secondary sources say it asks for company name, board of directors and incorporator email, plus authorized shares and par value per the Clerky handbook (https://handbooks.clerky.com/startup-incorporation/certificate-of-incorporation-contents).

### 1.5 StableCorp (Colosseum Frontier winner)
Sources:
- winners post: https://blog.colosseum.com/announcing-the-winners-of-the-solana-frontier-hackathon/
- accelerator Cohort 5: https://blog.colosseum.com/announcing-colosseums-accelerator-cohort-5/
- site: https://mystablecorp.xyz (stablecorp.com is a parked GoDaddy domain)

- **Who and what:** India-based, "business infrastructure for remote founders earning stablecoins".
  - WY LLC or DE C-Corp "in under 48 hours", with filing, registered agent and EIN included.
  - US accounts with ACH and wire through **Bridge (Stripe)**.
  - USDC, EURC and USDT invoicing, plus an INR off-ramp.
  - "No SSN or US address required".
- **Filing partner:** not named.
- **Intake fields:** "fill in your details once". The exact fields are not public (UNVERIFIED).
- **Pricing:** not visible.
- **Takeaway:** the same niche as ours. They almost certainly resell a provider, but this is UNVERIFIED.

### 1.6 Regulatory facts that shape the intake
- **BOI:** the final rule took effect 2026-08-14. US-created companies are exempt, and only foreign entities registered in a US state still report (https://www.fincen.gov/boi). **Drop the BOI step.**
- **SS-4 for no-SSN founders** (https://www.irs.gov/instructions/iss4):
  - Online EIN needs a US location and a responsible-party SSN, ITIN or EIN.
  - Phone 267-941-1099 works only for entities without a US location. Per Clerky, that means **not** a DE or WY company.
  - Fax: 855-215-1627 from inside the US, 304-707-9471 from abroad.
  - Line 7b gets "Foreign".
  - Line 10: one reason (Started new business / Hired employees / Banking purpose / …).
  - Line 13: agricultural, household and other employee counts.
  - Line 15: first wage date, or N/A.
  - Line 16: principal activity box.
  - Line 17: line of business.
- **Delaware:** a registered agent with a DE street address is mandatory. Expedites run from 1 hour to next day (https://icis.corp.delaware.gov/Ecorp/Static/FAQ.aspx). The base fee is ≥$89–109 by share structure; confirm it in the official schedule (https://corpfiles.delaware.gov/Fee_Schedule/AugustFee2026.pdf, UNVERIFIED line).
- **Wyoming:** the $100 base filing fee comes from the SOS guide (https://sos.wyo.gov/Business/Docs/HowToCreateAWyomingCompany.pdf). That guide only came back as binary text, so the fee is quoted from a secondary source (UNVERIFIED). The annual report license tax is a minimum of $60 (UNVERIFIED).

### 1.7 Canonical intake we should copy

This list follows doola's real API schema, so the fields map 1:1 onto a filing (https://docs.doola.com/api/api-reference/companies/create-a-company.md). It adds the SS-4 questions from FileForms (https://docs.fileforms.com/guides/products/ein/) and the IRS.

Key: R = required, O = optional, — = not applicable.

| # | Field | WY LLC | DE C-Corp | Notes / source of the rule |
|---|---|---|---|---|
| **Founder (account)** |||||
| 1 | Legal first and last name (as on ID) | R | R | Atlas, doola |
| 2 | Email | R | R | the SS-4 and 8821 signing link goes here |
| 3 | Phone (E.164) | R | R | doola requires a phone on every person's address |
| 4 | Country of residence (ISO-3) | R | R | doola customer |
| 5 | Date of birth | O | O | Atlas asks the submitter only. doola and FileForms don't. Needed for bank KYC, not for filing |
| 6 | Nationality / citizenship | O | O | not on any filing schema. Bank KYC only |
| 7 | Residential address (line1, line2, city, state/region, postal, country, phone) | R | R | doola member/officer address |
| 8 | Passport / ID upload | O | O | not needed to form ("won't need a passport", doola). Required for the bank (Mercury, Bridge). Collect it at the banking step |
| 9 | SSN or ITIN | O | O | if absent, an SS-4 wet/e-signature is required. An ITIN still triggers the signature (doola) |
| **Company** |||||
| 10 | Entity type | R | R | `LLC` / `CCorp` |
| 11 | Formation state | R (WY) | R (DE) | |
| 12 | Name option 1, with designator (LLC / Inc., Corp.) | R | R | the suffix must match the entity |
| 13 | Name options 2–3 (alternates) | O (rec.) | O (rec.) | doola allows 1–3. Atlas allows 1 |
| 14 | Industry (NAICS label) | R | R | doola reference endpoint `/references/naics` |
| 15 | Business description (≤50 chars for doola) | R | R | Atlas: free text, used for restricted-business screening |
| 16 | Website / social URL | O | O | Atlas uses it for real-person checks |
| 17 | Business address | R | R | the RA address is OK if there is no US address |
| 18 | Mailing address | R | R | defaults to the RA address |
| 19 | Registered agent | R (provider's) | R (provider's) | DE needs a DE street address. Included by the provider |
| 20 | Fiscal year-end month | O (Dec) | O (Dec) | FileForms `fiscalEndMonth` |
| **Ownership / governance** |||||
| 21 | Members: natural person?, name, ownership %, address, phone, SSN? | R (Σ=100) | — | doola `members[]` |
| 22 | LLC management: member- or manager-managed | O (member) | — | FileForms `structureType`. Atlas asks for "LLC Managers" |
| 23 | Officers: President, Secretary, Treasurer (one each) | — | R | doola `executiveMembers`. One person may hold several roles |
| 24 | Directors (≥1) | — | R | |
| 25 | Authorized shares + par value | — | R | doola `ccorpValuation {noOfShares, shareValue}`. Atlas/Clerky use 10M at $0.00001 (UNVERIFIED default) |
| 26 | Shareholder allocation % / option pool | — | R / O | Atlas |
| **EIN (SS-4)** |||||
| 27 | Order EIN? (+ expedite) | O (rec.) | O (rec.) | doola `services:[EinCreation]` |
| 28 | Responsible party: legal name, title, email, address, phone, SSN/ITIN or "foreign" | R | R | doola `responsibleParty`. FileForms `responsiblePartyIsForeign` |
| 29 | Reason for applying | R | R | default "Started new business" (SS-4 line 10) |
| 30 | Expect W-2 employees in 12 mo? → agricultural / other counts, first wage date | R | R | default 0 / N/A (lines 13–15) |
| 31 | Principal activity + line of business | R | R | lines 16–17. Derive from NAICS + description |
| 32 | Excise flags: 55k-lb vehicle, gambling, Form 720, alcohol/tobacco/firearms, Form 944 | R | R | default "no" (Atlas assumptions, FileForms booleans) |
| 33 | E-sign SS-4 (+ Form 8821 for expedite / IRS contact) | R if no SSN | R if no SSN | doola signature session |
| **Dropped / later** |||||
| 34 | BOI report | — | — | exempt since 2025-03-26, final rule 2026-08-14 |
| 35 | 83(b) election | — | O | Atlas/Clerky. Only meaningful for vesting C-Corp stock |
| 36 | Form 5472 + pro forma 1120 (foreign-owned single-member LLC), WY annual report, DE franchise tax | post | post | annual compliance. doola, Firstbase and FileForms sell these |

---

## Part 2: Filing providers with an API

| Provider | Public API? | Endpoints (verified) | Sandbox | Keys / signup | Pricing | Non-US owners | EIN without SSN via API |
|---|---|---|---|---|---|---|---|
| **doola Partner API** | **Yes**, public docs | `POST /v1/partner/customers`, `POST /v1/partner/companies`, `GET /companies/{id}`, documents list/upload/download-URL, `POST /companies/{id}/signatures` (SS-4/8821), required-actions, annual reports, reference data (states, fees, NAICS, countries); sandbox `POST /v1/partner/playground/companies/{id}/formation/complete` and `/eincreation/complete`. Webhooks with HMAC `X-Doola-Signature` | **Yes**, `https://api.test.doola.com`, `dk_test_`, no real filings or charges | Partner agreement **before** sandbox keys. Request through doola Partnerships (https://www.doola.com/company-formation-api). Time to keys not stated (UNVERIFIED). Go-live "<48h" after integration | Wholesale, by request. The FAQ says the per-company charge on a base formation is the state fee, and the first-year RA is included. Marketing quotes "from $149/entity" all-in (secondary, UNVERIFIED) | **Yes**, 175+ countries | **Yes.** White-labelled SS-4 (+8821 for expedite) signing URL; EIN delivered via `company_ein_issued` + `document_einletter_uploaded` |
| **FileForms (FileFormsPro)** | **Yes**, public docs | `POST https://api.fileforms.com/v1/orders` carrying `formation` (`legalName`, `entityType` LLC/CORP, `structureType`, `officers[]`, addresses, `alternativeNames` ≤10), `ein`, `registeredAgent`; webhooks `filing.status_changed`, `document.uploaded` | **Yes**, staging key at signup, synthetic data only | **Self-serve**: sign up at apps.fileforms.com, accept Partner Terms, copy keys from Settings › Developer. No contract or sales call | $0 account. PAYG RA/annual report $149/state/yr. Wholesale from $99/filing after a **$5,000 prepaid** balance. Retail EIN $99, formation $99–399. Live orders need a funded balance | Not stated on the formation page (UNVERIFIED) | **Yes, partly.** `responsiblePartyIsForeign: true` lets us omit the SSN. The docs don't describe how the SS-4 signature is collected or the timeline (UNVERIFIED) |
| **CorpNet API** | Yes, docs public | `GET /business-formation-v2/package`, `POST /business-formation-v2/create-order`, `GET /business-formation-v2/get-order/{orderGuid}`, `PATCH /business-formation/update-order-v1/{guid}` (RFI), `POST /send-order-document-v1`, `GET /download-order-document-v1` | Staging `api.staging24.corpnet.com` | Approved partners only: demo form, then email developer-support@corpnet.com. Static bearer token. A one-time implementation fee is mentioned (secondary snippet, UNVERIFIED) | Not published | UNVERIFIED | EIN is listed as a service. API mechanics are UNVERIFIED |
| **Palm (getpalm.com)** | Yes, public docs | `POST /v1/filing/formation/llc`, `/formation/corporation`, `GET /formation/fee`, `/formation/requirements`, `POST /v1/filing/ein` | Test mode (`sk_test_`) | **Self-serve** console signup. **Trial test mode covers California only.** Production or other states need "Book a call" | Metered, not published | UNVERIFIED | EIN takes `ssn` (SSN/ITIN) or `user_id`. **No documented foreign/no-SSN path** |
| **Firstbase** | Incorporation/Referral API marketed; **no public docs found** | Partner sends data, gets a tracking ID and a **payment redirect link** (search snippet of firstbase.io/api; page now 404) | UNVERIFIED | Partner program. API docs are a "higher-tier benefit" (https://firstbase.io/affiliates). developers.firstbase.com is a **different company** (equipment) | — | Yes (consumer) | UNVERIFIED |
| **Harbor Compliance** | Partner API for **registered agent** (https://developers.harborcompliance.com/) | RA appointments and document sync. Formation via API not shown | UNVERIFIED | Partner portal | Not published | — | Not offered via API (UNVERIFIED) |
| **Northwest Registered Agent** | "public API" claimed on the wholesale page, **no docs found** | — | — | Wholesale signup, then they contact you (https://www.northwestregisteredagent.com/wholesale-registered-agent.html) | Not published | — | No |
| **Registered Agents Inc** (also sells under "Wyoming Agents") | "public API" claimed (https://www.registeredagentsinc.com/wholesale/wholesale-program/), **no docs found** | — | — | Wholesale program | Not published | — | No |
| **Bizee (Incfile)** | No developer docs found; only a competitor claims an API (UNVERIFIED) | — | — | — | — | — | — |
| **Cogency Global** | No. Entity Central is a web/mobile app (https://www.cogencyglobal.com/entity-central) | — | — | — | — | — | — |
| **CT Corporation (Wolters Kluwer)** | hCue entity-management APIs (data sync), not formation filing (https://www.wolterskluwer.com/en/expert-insights/the-power-of-apis-in-entity-management) | — | — | Enterprise | — | — | — |
| **Middesk** | KYB / EIN *verification*, not formation (https://www.middesk.com/ein-lookup-api) | — | — | — | — | — | No |
| **Stable (usestable.com)** | RA + CMRA API (`/v1/companies`, RA locations), not formation (https://www.usestable.com/product-updates/registered-agents-api) | — | UNVERIFIED | — | — | — | No |
| **Wyoming SOS (wyobiz)** | **No API**. Online web filing only (https://sos.wyo.gov/Business/Docs/HowToCreateAWyomingCompany.pdf) | — | — | Needs a WY RA anyway | $100 + small online fee | Yes (organizer anywhere) | n/a |
| **Delaware ICIS** | **No public API found.** Online document filing service plus expedite tiers. Filing practically goes through a DE registered agent (https://icis.corp.delaware.gov/Ecorp/Static/FAQ.aspx) | — | — | — | per the fee schedule | Yes | n/a |
| **IRS** | **No EIN API.** Online EIN needs an SSN/ITIN. Foreign applicants fax or mail the SS-4 (https://www.irs.gov/instructions/iss4) | — | — | — | free | — | **The only no-SSN route is a fax/mail SS-4.** Every provider does this by hand behind its API |

Also seen, not evaluated: **File.Business** offers a formations API with a Python client (the domain didn't resolve). Naïve's "formation" primitive runs on doola (https://www.newswire.com/news/doola-powers-native-us-company-formation-inside-na-ves-ai-agent-22848579).

### Ranking for the hackathon (deadline 2026-11-14 23:59 UTC)

**1. FileForms: realistic to have working keys today.**
- Signup is self-serve, the staging key arrives on signup and there's no contract (https://fileforms.com/?p=7398).
- One `POST /v1/orders` call covers formation, EIN with a foreign responsible party and registered agent, for WY and DE. Webhooks report status and documents.
- **Risks:**
  - The docs don't confirm a white-labelled SS-4 signing flow for foreign founders.
  - A live filing needs a funded balance, so the demo runs on staging and makes no real filing.
  - Staging allows synthetic data only.

**2. doola Partner API: the best fit for our product.**
- It covers WY LLC and DE C-Corp, real no-SSN EIN with in-app SS-4 signing, Operating Agreement or Bylaws, and an EIN letter.
- Sandbox endpoints can complete the formation and EIN on demand, so the demo flow runs end to end.
- **Risk:** sandbox keys need a partner agreement. The timeline isn't stated, and getting them in under a day is **unlikely but possible** (UNVERIFIED).
- **Recommended now:** the user contacts doola Partnerships (https://www.doola.com/company-formation-api) today, while we build against FileForms staging. Both schemas match the canonical intake above, so switching later means only swapping the adapter.

Not viable in under a day:
- CorpNet: approval plus implementation, no self-serve.
- Palm: trial sandbox covers California only, and it has no no-SSN EIN path.
- Firstbase: no public docs.
- Harbor, Northwest and RAI: registered agent only, or no docs.
- WY SOS and DE ICIS directly: no API, and the IRS has no EIN API.

### Honesty note for the demo
No provider sandbox files anything real.
- doola's sandbox returns filing number `PLAYGROUND-FILING` and EIN `12-3456789`.
- FileForms staging uses synthetic data.

"No mocks" can therefore mean a real provider API in its sandbox mode. A **real** WY filing needs a live key plus payment: the $100 WY state fee plus provider fees. An EIN for a no-SSN founder then takes weeks, not hours, so the IRS step can't finish before the deadline.
