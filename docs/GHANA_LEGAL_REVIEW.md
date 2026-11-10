# Ghana Legal & Compliance Review Checklist (Pre-Launch)

**Purpose:** A checklist of items for the product owner to confirm with a **qualified Ghanaian lawyer** before launch.  
**Important:** This document **does not assert legal conclusions**. It lists **questions only** for professional review. AgreementHub provides document workflow and integrity tooling; it is **not** a legal advice service.

## How to use this checklist
- Review each question with qualified legal counsel in Ghana.
- Record counsel’s guidance, required wording changes, product constraints, and any launch blockers.
- Re-check after template, workflow, privacy, or payment-related changes.

## 1. Electronic signatures — recognition and evidential weight
*Context for review: Electronic Transactions Act, 2008 (Act 772).*

- [ ] For the agreement types offered by AgreementHub, which forms of electronic signature/acceptance used by the product (typed name, drawn signature, explicit electronic acceptance/consent, authenticated session actions, emailed one-time codes) are likely to carry what evidential weight, and in what circumstances?
- [ ] Are there agreement categories in Ghana that require a handwritten signature, witnesses, notarisation, stamping, registration, or a specific statutory form, making the product’s e-signature flow unsuitable or only partially suitable?
- [ ] What signer-intent, attribution, integrity, and audit evidence should the product capture and present to support reliance on an electronic signature (e.g., consent text, timestamp, identity/authentication method, document hash at signing, IP/device metadata, signing order)?
- [ ] Does the current consent/signing copy clearly describe the act the signer is taking, and is any wording risky, ambiguous, or incomplete from a Ghana law perspective?
- [ ] How should the product describe “signed”, “final”, “sealed”, and “verified” so that it does not overstate legal effect?

## 2. Dispute-resolution wording
*Context for review: Alternative Dispute Resolution Act, 2010 (Act 798).*

- [ ] Are the template dispute-resolution options (Negotiation, Mediation, Arbitration, Courts) and the conditional clause text used for each option appropriate as **neutral drafting options**, and where could the wording be misleading or incomplete?
- [ ] Does the arbitration clause text need jurisdiction/seat, appointing authority, number of arbitrators, language, rules, or other terms to be workable, and should the template collect those details or avoid implying a complete arbitration agreement?
- [ ] Does the mediation wording create any unintended procedural obligation, and is it consistent with how parties may wish to structure pre-action steps?
- [ ] Should any dispute-resolution wording differ by agreement type (freelance/service, rental, proposal, NDA, client/user terms)?
- [ ] Are there consumer, employment, tenancy, or other contexts where specific dispute-resolution wording would be inappropriate?

## 3. Data handling, privacy, and registration
*Context for review: Data Protection Act, 2012 (Act 843).*

- [ ] What personal data does AgreementHub collect and process (e.g., account name/email/phone/country/region, organization, user type, invited party names/emails, IP/user-agent/session metadata, signature evidence, uploaded/avatar/profile data, document content and metadata), and is that inventory complete?
- [ ] What is the appropriate lawful basis/consent approach for each processing purpose (account operation, authentication, invitations, signing evidence, notifications, security/audit logging, support)?
- [ ] Are retention periods for accounts, drafts, finalized agreements, audit logs, signature evidence, verification records, session/reset tokens, and backups appropriate, and what deletion/anonymisation obligations apply?
- [ ] What user/data-subject rights must be supported (access, correction, deletion/erasure limits given evidential records, objection/restriction where applicable), and how do they interact with immutable audit/hash records and finalized agreements?
- [ ] Is the consent, privacy notice, and cookie wording clear and sufficient? What notices must be presented at registration, invitation, signing, and verification?
- [ ] Whether to register as a data controller (and/or engage/process as required) with the Data Protection Commission, and what organizational/technical measures should be documented?
- [ ] What cross-border transfer, processor/sub-processor, hosting, email, and AI-provider disclosures or safeguards are needed for the actual infrastructure used?

## 4. Tenancy/rental terms
*Context for review: Rent Act, 1963 (Act 220), and any other applicable tenancy/stamping requirements.*

- [ ] Are the rental template fields and default/helper wording (including **advance rent (months)** and the note to confirm any legal limit with a qualified lawyer) appropriate, and what wording should be changed, added, or removed?
- [ ] Do tenancy duration, renewal, rent payment, deposit, notice/termination, maintenance, and handover clauses need Ghana-specific mandatory terms or warnings for the intended property/use cases?
- [ ] Should the template treat residential, commercial, short-term, or other tenancy types differently?
- [ ] Whether leases/tenancy agreements created from the template need **stamping** (and when), and should the product present any user guidance or avoid implying that an unstamped/unregistered document has a particular effect?
- [ ] Are “landlord/provider”, “tenant/user”, address, region, and Ghana Post GPS fields sufficient for the intended use, or do they create misleading assumptions?

## 5. Formalities: witnesses, notarisation, and specific form
- [ ] For each template/category (freelance/service, rental, business proposal/acceptance, NDA, client/user agreement), **whether any agreement needs witnesses, notarisation, attestation, stamping, registration, or a specific form** to be enforceable or to achieve the parties’ intended effect?
- [ ] If witnesses or additional formalities are required in some cases, should the product block e-sign completion, add a workflow step, add warnings, or exclude those cases from the template?
- [ ] Does the “proposal” acceptance flow risk being treated as a binding contract in ways users may not expect, and what wording/warnings are appropriate?

## 6. Product wording, notices, and launch controls
- [ ] Are the app’s disclaimers (“not legal advice”, AI-generated assistance review notice, verification/integrity certificate wording, and document footer text) clear, prominent, and non-misleading?
- [ ] Should any template or feature be limited, labeled “draft for review”, or removed until counsel approves the wording?
- [ ] What records should be retained to respond to disputes, regulatory inquiries, or evidential challenges?

## Wording to review with counsel (items I was unsure about)
The following product/template wording was added or touched during Ghana-localization work and should be reviewed by qualified counsel (this is a flag for review, **not** a legal assessment):

- **Document footer (rendered/PDF):** “Prepared with AgreementHub templates. This is not legal advice; consider review by a qualified lawyer.” and “This document records electronic acceptance and signature details. Integrity checks are available on the verification page.” — confirm these do not understate/overstate evidential effect or create unintended reliance.
- **Verification/certificate copy:** “Certificate of integrity”, “Verified”, “intact and matches the official document hash”, and “This page confirms integrity only; it does not display the agreement contents and does not constitute legal advice.” — confirm “verified”/certificate framing is appropriate.
- **Status labels:** “FINAL AGREEMENT”, “DRAFT: NOT FINAL”, “Agreement finalized”, “Document signed”, “electronically accepts” (render/signature UI text) — confirm alignment with Ghana e-signature/evidence concepts.
- **Governing law clause (templates):** “This agreement is governed by the laws of {{governing_law}}.” with options including Republic of Ghana and foreign options — confirm suitability as a neutral option and any required caveats.
- **Dispute-resolution clauses (templates, conditional by choice):** negotiation/mediation/arbitration/courts short-form text. In particular, the **arbitration** clause is a brief general reference and does not specify seat/rules/tribunal details; confirm whether it is adequate as an optional starting point or needs stronger warnings/additional fields.
- **Rental advance rent guidance:** “Advance rent (months)… Optional. Confirm any legal limit on advance rent with a qualified lawyer.” and payment text “Advance rent (months, if any): …” — confirm Act 220 implications and whether more specific warnings/limits/fields are required.
- **Tenancy/stamping/registration:** templates include address/region/GPS and rental terms but do not give stamping/registration guidance — confirm whether user-facing guidance is needed.
- **Data/privacy references in templates:** client/user template asks for a “Data / privacy reference” (URL or “not applicable”) — confirm adequacy and relationship to Act 843 notices.
- **AI assistance disclaimer (unchanged):** “AI-generated assistance. Review carefully. This is not legal advice.” — confirm prominence/sufficiency wherever AI suggestions appear.
- **Mobile money/payment method fields:** guidance lists provider examples (MTN MoMo, Telecel Cash, AirtelTigo Money) and states AgreementHub does not process payments — confirm examples/disclaimer remain accurate and non-misleading.

---
*Prepared for product-owner review. Obtain advice from a qualified Ghanaian lawyer before relying on this checklist or launching Ghana-specific legal/compliance features.*