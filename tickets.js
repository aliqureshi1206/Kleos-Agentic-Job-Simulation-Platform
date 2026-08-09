// tickets.js — the curated ticket banks for the Meridian checkout story,
// one per live track (Product Management, Design, Frontend Engineering).
//
// This is content, not logic: each ticket is a real (fictional) piece of
// work, in order, so a full run through a bank reads as one continuous job
// rather than disconnected exercises. content.js decides *when* a ticket
// gets assigned and *whether* a hiccup fires on it; this file only defines
// *what the work is*, per track.
//
// Fields:
//   id, pri, est      — same as the old single-ticket UI expected
//   title, desc       — backlog card text
//   brief             — HTML shown in the "Brief" tab (context + raw input)
//   delivLabel        — HTML shown above the deliverable textarea
//   rubric            — 4-6 short bullets the reviewer judges the
//                       submission against — this is what agents.js turns
//                       into the actual review system prompt
//   pivotEligible     — can a mid-ticket pivot hiccup fire on this ticket?
//   reviewer          — which agent formally reviews this ticket (the
//                       Product track is reviewed by 'tlead'; Design by
//                       'design'; Frontend by 'tlead')

const TICKETS_PM = [
  {
    id: 'QE-402', pri: 'high', est: '2 days',
    title: "Rewrite the checkout PRD from Tuesday's stakeholder call",
    desc: "Omar's call transcript is in the thread. He contradicts himself on payment priority and never states a success metric. Produce a PRD engineering can estimate against.",
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> Meridian is a checkout layer for commerce in MENA and South Asia. This sprint is the checkout rebuild for Cairo, Riyadh and Karachi.</p>
      <p style="margin-top:10px"><b>Raw transcript excerpt (Omar Farouk, VP Growth):</b></p>
      <p style="margin-top:8px;font-family:var(--mono);font-size:11.5px;color:var(--ink-3);line-height:1.7">"…so cards are the priority, obviously. Everyone uses cards. Although — the Egypt numbers, the wallet numbers are wild, Vodafone Cash especially. Let's do both. Actually let's do it properly, I don't want a half-experience. Ship it this sprint."</p>
      <p style="margin-top:12px"><b>Deliverable.</b> A PRD containing: problem statement, in-scope, explicitly out-of-scope, success metrics with baselines, and a named risk.</p>`,
    delivLabel: '<b>Deliverable — PRD.</b> Problem, scope, out-of-scope, success metrics, one named risk. Engineering must be able to estimate from it.',
    rubric: [
      'Clear problem statement grounded in real data from the brief',
      'Explicit in-scope AND out-of-scope sections',
      'Success metrics with baselines, not just targets',
      'A named, specific risk — not generic',
      'A guardrail or rollback metric',
      "If the sprint has pivoted: the pivot is explicitly acknowledged, scope is genuinely cut to compensate (not just added on top), and the decision is logged/dated"
    ]
  },
  {
    id: 'QE-405', pri: 'med', est: '1 day',
    title: 'Define the success measurement plan for the Vodafone Cash rollout',
    desc: 'Wallet-first shipped. Nobody agreed on what "working" means, and Finance wants a rollback trigger before the next board update.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Vodafone Cash went live in Egypt last week. Early signal is mixed: completion is up, but Sentinel is seeing intermittent auth failures nobody has quantified yet.</p>
      <p style="margin-top:10px"><b>What you have.</b> Raw funnel numbers in <code>#general</code>, a Finance ask for "a number we can put in the board deck," and no agreed definition of success yet.</p>
      <p style="margin-top:12px"><b>Deliverable.</b> A short measurement plan: the primary metric, 1-2 secondary/guardrail metrics with numeric thresholds, who owns the dashboard, and what triggers a rollback conversation.</p>`,
    delivLabel: '<b>Deliverable — measurement plan.</b> Primary metric, guardrails with numbers, an owner, and a rollback trigger.',
    rubric: [
      'One clearly primary metric, not a list with no hierarchy',
      'Guardrail metrics have actual numeric thresholds, not "monitor closely"',
      'An explicit rollback trigger — what number, sustained how long, causes what action',
      'A named owner for the dashboard/monitoring, not "the team"',
      'Distinguishes leading indicators (auth failure rate) from lagging ones (completion rate)'
    ]
  },
  {
    id: 'QE-410', pri: 'high', est: '2 days',
    title: "Write the PRD for Riyadh's Mada card launch",
    desc: "Saudi is next. Mada has its own compliance and UX requirements Omar keeps calling 'basically the same as cards' — it isn't.",
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> Mada is the Saudi domestic card scheme — most Saudi shoppers use it, and it is not a drop-in extension of the existing international card flow. It requires local acquiring, a different 3DS-equivalent step, and Arabic-first receipts for compliance.</p>
      <p style="margin-top:10px"><b>Known constraint.</b> Legal has flagged that Mada transactions must settle through a KSA-licensed acquirer — Meridian doesn't have one yet, and onboarding one takes 3-4 weeks minimum.</p>
      <p style="margin-top:12px"><b>Deliverable.</b> A PRD scoped to what can actually ship before the acquirer is ready, with the acquirer dependency called out as a blocking risk, not a footnote.</p>`,
    delivLabel: '<b>Deliverable — PRD.</b> Problem, scope, out-of-scope, success metrics, and the acquirer dependency treated as a first-class risk.',
    rubric: [
      'Problem statement is specific to the Saudi/Mada context, not a copy of the Egypt PRD',
      'The acquirer licensing dependency is named as a blocking risk with a rough timeline, not buried',
      'Scope explicitly excludes anything that requires the acquirer before it is ready',
      'Success metrics make sense for a market launch (adoption, not just completion rate)',
      'A rollback or delay plan if the acquirer slips'
    ]
  },
  {
    id: 'QE-414', pri: 'med', est: '1 day',
    title: 'Set the refund policy for wallet payments',
    desc: 'Support is fielding wallet refund complaints with no documented SLA. Finance and Support disagree on timing.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Card refunds settle in 5-7 days and everyone accepts that. Wallet refunds (Vodafone Cash, Fawry) have no agreed SLA — Support has been promising "24-48 hours" without checking if that's actually possible, and Finance says wallet settlement partners take up to 5 business days to confirm a reversal.</p>
      <p style="margin-top:10px"><b>Tension.</b> Support wants a customer-facing promise. Finance wants to under-promise given the partner's real settlement window. You are writing the policy that reconciles this.</p>
      <p style="margin-top:12px"><b>Deliverable.</b> A refund policy doc: the customer-facing SLA, the internal/operational timeline it's based on, and what Support should say when a refund is late.</p>`,
    delivLabel: '<b>Deliverable — refund policy.</b> Customer-facing SLA, the real operational timeline behind it, and a script for late refunds.',
    rubric: [
      'The customer-facing SLA is realistic against the stated partner settlement window, not just what Support wants to promise',
      'Distinguishes the customer-facing number from the internal operational timeline',
      "Addresses what Support says when a refund runs past the promised SLA — doesn't leave that gap open",
      'Named owner for tracking wallet refund exceptions',
      'Scoped to wallet payments specifically, not a generic rewrite of the card refund policy'
    ]
  },
  {
    id: 'QE-419', pri: 'high', est: '2 days',
    title: 'Cash-on-delivery pilot brief for Karachi',
    desc: 'Growth wants COD in Karachi to unlock a segment that doesn\'t trust digital payment yet. Fraud and Ops both have real concerns.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> A meaningful share of Karachi shoppers abandon checkout because they don't trust prepaying online. Omar wants a cash-on-delivery pilot to unlock them. Fraud is worried about fake-order abuse; Ops is worried about failed-delivery cash reconciliation, which COD makes much harder to track.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A pilot brief: scope (which merchants/order sizes), the fraud guardrail, the ops reconciliation approach, and a clear success/kill criteria for the pilot before it expands.</p>`,
    delivLabel: '<b>Deliverable — pilot brief.</b> Scope, fraud guardrail, ops reconciliation approach, and explicit pilot success/kill criteria.',
    rubric: [
      'Pilot is explicitly bounded (specific merchants, order value cap, or region) rather than a full rollout',
      'Names a concrete fraud guardrail (e.g. order value cap, repeat-failed-delivery block), not just "we will monitor for fraud"',
      'Addresses cash reconciliation with Ops as a real operational question, not an afterthought',
      'Explicit kill criteria — a number that ends the pilot, not just a success number that continues it',
      'Timeline for the pilot decision, so it doesn\'t run indefinitely'
    ]
  },
  {
    id: 'QE-423', pri: 'med', est: '1 day',
    title: 'Requirements for the merchant settlement dashboard',
    desc: "Merchants are emailing support asking when they'll get paid. Internal tooling has no self-serve answer. Different customer this time: the merchant, not the shopper.",
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Every payment method now has a different settlement timeline (cards T+2, Fawry T+2, Vodafone Cash varies). Merchants have no way to see where their money is without emailing support, and support has no good answer either.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> Requirements for a merchant-facing settlement dashboard: what a merchant needs to see, at minimum, to stop emailing support, and what's explicitly out of scope for v1.</p>`,
    delivLabel: '<b>Deliverable — requirements doc.</b> What the merchant sees, what data feeds it, and what is explicitly out of v1 scope.',
    rubric: [
      'Requirements are written from the merchant\'s actual question ("where is my money") rather than an internal data model',
      'Distinguishes must-have-for-v1 from nice-to-have',
      'Names which backend data sources the dashboard needs (settlement timelines per payment method), even at a high level',
      'A stated cutover plan for reducing the support email volume this is meant to fix',
      'Explicit v1 scope boundary, given how many payment methods now exist'
    ]
  },
  {
    id: 'QE-427', pri: 'high', est: '2 days',
    title: 'Investigate the checkout abandonment spike and write the fix brief',
    desc: 'Abandonment jumped 6 points region-wide last week with no obvious single cause. You need to find the real driver before proposing a fix.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Checkout abandonment rose from 22% to 28% across all three markets in the last 7 days. No single deploy correlates cleanly. Sentinel's dashboards are in <code>#incidents</code>; several teams have theories (a payment SDK update, a promo banner change, a slow third-party fraud check).</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A brief: what you believe the actual driver is (with evidence, not just a guess), what you ruled out and why, and a fix proposal.</p>`,
    delivLabel: '<b>Deliverable — investigation brief.</b> Root cause with evidence, what was ruled out, and a fix proposal.',
    rubric: [
      'States a specific root-cause hypothesis backed by something concrete from the data, not "multiple factors"',
      'Explicitly lists what was investigated and ruled out — shows real elimination, not just a conclusion',
      'Fix proposal is scoped to the actual root cause, not a generic "improve checkout" plan',
      'Acknowledges uncertainty honestly if the evidence is not fully conclusive',
      'Names how you\'ll confirm the fix worked (a metric and a timeframe)'
    ]
  },
  {
    id: 'QE-433', pri: 'med', est: '1 day',
    title: 'Deprecation plan for the legacy checkout SDK',
    desc: 'External merchant developers are still integrating against v1 of the SDK. Engineering wants it gone. Partners will be upset regardless — the plan is about how upset.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> The v1 checkout SDK is used by roughly a third of integrated merchants, mostly smaller ones with less engineering capacity. v2 has been stable for two quarters. Engineering wants v1 fully retired to stop maintaining two code paths.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A deprecation plan: timeline, communication approach to affected merchants, and what happens to merchants who don't migrate in time.</p>`,
    delivLabel: '<b>Deliverable — deprecation plan.</b> Timeline, merchant communication approach, and a stated consequence for non-migration.',
    rubric: [
      'Timeline gives affected merchants (specifically smaller ones with less capacity) a realistic migration window',
      'Communication plan has more than one touchpoint — not a single "you have 30 days" email',
      'States clearly what happens to merchants who miss the deadline, and whether there\'s a grace mechanism',
      'Acknowledges the asymmetry: smaller/less-resourced merchants need more support, not just more time',
      'Includes a way to measure migration progress before the hard cutoff'
    ]
  },
  {
    id: 'QE-438', pri: 'high', est: '2 days',
    title: 'Ramadan readiness plan for checkout',
    desc: 'Ramadan traffic historically spikes checkout volume 3-4x with a shifted daily pattern. Last year there was a near-outage nobody planned for.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> Shopping traffic in Egypt and Saudi shifts heavily during Ramadan — a late-evening spike after iftar that hit 3.8x normal peak load last year and nearly took down checkout. There was no freeze window or on-call plan in place at the time.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A readiness plan: load expectations, a feature-freeze window if needed, on-call coverage during the spike hours, and a rollback plan if something breaks during the highest-traffic days.</p>`,
    delivLabel: '<b>Deliverable — readiness plan.</b> Load expectations, freeze window, on-call coverage, and a rollback plan for the highest-traffic days.',
    rubric: [
      'Uses last year\'s actual load numbers as the basis for this year\'s expectations, not a generic estimate',
      'Names a specific freeze window (dates) if one is warranted, with a rationale',
      'On-call coverage is concrete — who, when, during the actual spike hours, not "the team will be available"',
      'Includes a rollback or mitigation plan specifically for the peak days, separate from normal incident response',
      'If a pivot happened: the plan still protects the highest-risk days even if scope elsewhere was cut'
    ]
  },
  {
    id: 'QE-442', pri: 'low', est: '1 day',
    title: 'Scope the regional payment-config consolidation',
    desc: 'Three regions, three separately maintained payment configs, increasingly out of sync. Not urgent, but it is costing engineering time every sprint.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Egypt, Saudi and Pakistan each have their own payment-method configuration, maintained separately since each market launched under time pressure. They've drifted — feature flags exist in one region and not another for no real reason. Nothing is on fire, but every regional launch now takes longer because of it.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A scoping brief for a consolidation project: what would actually change, the migration risk, and whether it's worth doing now versus later.</p>`,
    delivLabel: '<b>Deliverable — scoping brief.</b> What changes, the migration risk, and a real recommendation on timing — including "not now" if that\'s the honest answer.',
    rubric: [
      'Gives an honest recommendation on timing rather than assuming the project should happen now just because it was assigned',
      'Names the actual migration risk (config drift causing a regional outage during cutover), not just the benefit',
      'Scopes what "consolidation" concretely means rather than staying abstract',
      'Considers the opportunity cost against other active work this sprint',
      'If recommending "later," gives a concrete trigger for revisiting it'
    ]
  },
  {
    id: 'QE-447', pri: 'high', est: '1 day',
    title: 'Incident postmortem: checkout outage root cause and prevention',
    desc: "Write the postmortem for the recent incident. Daniyal reviews postmortems harder than PRDs — vague accountability fails immediately.",
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Checkout had a partial outage — some fraction of sessions failed to complete for roughly 40 minutes before a rollback fixed it. Sentinel's incident log and timeline are in <code>#incidents</code>. Leadership wants the postmortem within 48 hours per policy.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A postmortem: timeline of what happened, root cause (not just "a bad deploy"), impact, and concrete prevention items with owners and dates — not "we will be more careful."</p>`,
    delivLabel: '<b>Deliverable — postmortem.</b> Timeline, real root cause, impact, and prevention items with named owners and dates.',
    rubric: [
      'Timeline is specific (what happened, in what order) rather than a vague summary',
      'Root cause goes past the surface trigger to the actual underlying gap (e.g. missing test coverage, no canary, no alert) — not just "a bad deploy went out"',
      'Impact is quantified, not just described as "some users"',
      'Every prevention item has a named owner and a date — a postmortem with no owners is a fail regardless of how good the writing is',
      'No blame language directed at an individual — process and system framing throughout'
    ]
  },
  {
    id: 'QE-451', pri: 'med', est: '1 day',
    title: 'Sunset plan for the underperforming BNPL pilot',
    desc: 'The buy-now-pay-later pilot never hit adoption targets. Killing a feature is its own kind of PM work — and Omar championed this one publicly.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> The BNPL (buy-now-pay-later) pilot launched two quarters ago with real fanfare — Omar presented it at a company all-hands. Adoption has stayed under 2%, well below the 15% target, and it adds real complexity to the checkout flow and reconciliation. The honest call is to sunset it.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A sunset plan: the data behind the call, a migration/comms plan for the small number of active users, and the actual removal timeline.</p>`,
    delivLabel: '<b>Deliverable — sunset plan.</b> The data behind the decision, a plan for existing users, and a removal timeline.',
    rubric: [
      'States the actual adoption numbers against the original target plainly, without softening the miss',
      'Has a real plan for existing active users of the feature, not just "notify them"',
      'Removal timeline accounts for the checkout complexity this was adding, so it doesn\'t just delete the option and break in-flight payments',
      'Addresses how this gets communicated internally, given Omar publicly championed it — professionally, not evasively',
      'Names what, if anything, is learned/kept from the pilot for future payment-method decisions'
    ]
  },
  {
    id: 'QE-448', pri: 'med', est: '1 day',
    title: 'Multi-currency pricing brief for the Riyadh expansion',
    desc: "Prices are hardcoded in USD-equivalent everywhere. Finance wants SAR-native pricing before the Riyadh launch, and nobody has scoped what that actually touches.",
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Checkout currently converts every price to a USD-pegged number at display time, which Finance has flagged as both confusing to Saudi buyers (prices that don't look like round SAR amounts) and risky (FX rate lag between quote and charge). Riyadh launches in 6 weeks.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A brief scoping what "native SAR pricing" actually requires: where prices are set, where they're stored, what rounds oddly, and what's explicitly out of scope for launch (e.g. real-time FX hedging).</p>`,
    delivLabel: '<b>Deliverable — pricing brief.</b> What changes, what stays USD-pegged for now, and what is explicitly deferred.',
    rubric: [
      'Identifies the actual mechanism causing odd-looking SAR prices, not just "convert to SAR"',
      'Distinguishes display currency from settlement currency — these are not the same problem',
      'Explicitly defers real-time FX hedging or rate-lock features rather than scope-creeping into them',
      'Names who owns keeping SAR list prices updated on an ongoing basis after launch',
      'Realistic about the 6-week timeline given what has to change'
    ]
  },
  {
    id: 'QE-449', pri: 'high', est: '2 days',
    title: 'Chargeback and dispute-handling policy for card payments',
    desc: 'Card chargebacks are being handled ad hoc by whoever picks up the Zendesk ticket. Finance wants a real policy before volume grows further.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> Card chargeback volume has grown quietly alongside overall checkout volume, and there's no documented process — different support agents have handled disputes inconsistently, and Finance has no visibility into chargeback rate as a health metric.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A dispute-handling policy: the process from chargeback notification to resolution, who owns each step, a target chargeback-rate threshold that triggers escalation, and what evidence gets collected automatically versus manually.</p>`,
    delivLabel: '<b>Deliverable — dispute policy.</b> End-to-end process, ownership at each step, an escalation threshold, and the evidence-collection approach.',
    rubric: [
      'Process is a real sequence of steps with named owners, not "support handles it"',
      'States a specific chargeback-rate threshold (a number) that triggers escalation, not "if it gets high"',
      'Distinguishes evidence that should be automated (order/delivery records) from what requires manual work',
      'Addresses consistency — the actual problem stated in the brief — not just documentation for its own sake',
      "If a pivot fired: acknowledges the changed priority and adjusts scope rather than ignoring it"
    ]
  },
  {
    id: 'QE-450', pri: 'med', est: '1 day',
    title: 'Accessibility audit brief for the checkout flow',
    desc: 'A prospective enterprise client asked about WCAG compliance during a sales call. Nobody could answer. Scope a real audit.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Ryan flagged that a large prospective merchant asked directly whether checkout meets WCAG 2.1 AA during a sales call, and the honest answer was "we don't know." Nobody has audited it. This ticket is about scoping the audit, not fixing every issue found.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An audit brief: what gets checked, in what order of priority (screen reader flow, keyboard navigation, contrast, form labeling), who does the checking, and how findings get triaged into fix-now versus backlog.</p>`,
    delivLabel: '<b>Deliverable — audit brief.</b> Scope and priority order for what gets checked, an owner, and a triage approach for findings.',
    rubric: [
      'Prioritizes checkout-critical accessibility paths (completing a purchase) over cosmetic issues',
      'Names a concrete triage rule for what becomes a fix-now bug versus a backlog item',
      'Scoped as an audit, not an implicit promise to fix everything found immediately',
      'Addresses the actual trigger (a sales conversation) without overcorrecting into a multi-quarter accessibility overhaul',
      'Realistic about who actually has the expertise to run the audit'
    ]
  },
  {
    id: 'QE-452', pri: 'high', est: '2 days',
    title: 'Data residency brief for a new regional data-protection requirement',
    desc: "Legal flagged a new regional requirement that payment data for local transactions be processed within-region. This changes more than it sounds like.",
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> A new regional data-protection requirement (similar in spirit to GDPR/PDPL-style rules) requires that payment and personal transaction data for in-country customers be processed and stored within that country's borders. Meridian's infrastructure is currently centralized in one region regardless of customer location.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A brief: what data is actually in scope (not everything the company stores), a realistic assessment of what changes are required versus nice-to-have, and a rough timeline given the compliance deadline.</p>`,
    delivLabel: '<b>Deliverable — compliance brief.</b> What data is in scope, required vs. nice-to-have changes, and a realistic timeline against the deadline.',
    rubric: [
      'Scopes exactly which data is covered by the requirement rather than assuming "everything"',
      'Distinguishes legally required changes from adjacent improvements that aren\'t actually mandated',
      'Names the infrastructure/engineering dependency honestly rather than treating this as a pure policy document',
      'Gives a realistic timeline assessment, including whether the stated deadline is achievable',
      'If a pivot fired on this ticket: treats the compliance deadline as non-negotiable even while scope elsewhere gets cut'
    ]
  },
  {
    id: 'QE-453', pri: 'med', est: '1 day',
    title: 'Support escalation path for payment failures during checkout',
    desc: 'Support has no clear path for escalating an in-progress payment failure to engineering. Customers are left stuck mid-checkout.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> When a payment fails in a confusing way (charged but order not confirmed, stuck in a pending state, etc.), Support has no defined path to escalate to engineering quickly — tickets sit in a general queue. A few of these have taken over 24 hours to resolve while a customer's money was in limbo.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An escalation path: how Support identifies a payment-limbo case, who they escalate to and how, a target response time, and what Support tells the customer while it's being investigated.</p>`,
    delivLabel: '<b>Deliverable — escalation path.</b> Identification criteria, escalation route, a target response time, and customer-facing communication guidance.',
    rubric: [
      'Gives Support concrete criteria for identifying a payment-limbo case, not just "if something seems wrong"',
      'Names a specific escalation route and a target response time in hours, not "as soon as possible"',
      'Includes what Support should tell the customer in the meantime — the brief specifically calls out customers left stuck',
      'Realistic about on-call/engineering capacity rather than promising instant response for every case',
      'Addresses how this gets tracked so recurring failure patterns are visible, not just resolved one at a time'
    ]
  },
  {
    id: 'QE-454', pri: 'low', est: '1 day',
    title: 'Executive dashboard requirements for checkout health',
    desc: 'Leadership wants a single dashboard instead of asking the PM for numbers before every leadership sync.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Rania and Claire have both separately asked for checkout health numbers ahead of recent leadership syncs — completion rate, payment method mix, incident count — each time as a one-off request. It's worth just building a dashboard.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> Requirements for an executive-facing dashboard: the handful of metrics that actually matter at that level (not every metric the team tracks internally), refresh cadence, and who maintains it.</p>`,
    delivLabel: '<b>Deliverable — requirements doc.</b> The executive-level metric set, refresh cadence, and ongoing ownership.',
    rubric: [
      'Metric set is genuinely executive-level (a handful of numbers) rather than a dump of every internal metric',
      'States a specific refresh cadence appropriate for leadership consumption, not real-time for its own sake',
      'Names a maintenance owner so the dashboard doesn\'t go stale after the first month',
      'Grounded in the actual stated trigger (repeated one-off requests) rather than a generic "build a dashboard" brief',
      'Reasonable in scope for a low-priority, 1-day ticket — doesn\'t balloon into a full BI project'
    ]
  },
  {
    id: 'QE-457', pri: 'high', est: '2 days',
    title: 'Competitive response brief: PayLoop\'s new instant-refund feature',
    desc: "PayLoop just announced instant refunds. Sales is already fielding questions. Leadership wants a response position, not necessarily a matching feature.",
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> ${`PayLoop`}, the Riyadh-based rival, just publicly launched instant refunds (funds returned in minutes instead of days). Ryan has already had two client calls where this came up. Leadership wants a considered response, which might be "match it," "differentiate instead," or "wait and see" — not an automatic yes to building the same thing.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A competitive response brief: what PayLoop's move actually threatens, a recommended position with reasoning, and if building something is recommended, a rough scope — not a full PRD yet.</p>`,
    delivLabel: '<b>Deliverable — competitive response brief.</b> What\'s actually at risk, a recommended position with reasoning, and a rough scope if a response is warranted.',
    rubric: [
      'Assesses the actual competitive threat specifically, rather than reflexively recommending feature parity',
      'Considers at least one non-obvious response (differentiation, pricing, messaging) alongside "build the same feature"',
      'If recommending a build, keeps it at rough-scope level appropriate for a brief, not a full PRD',
      'Grounded in the real operational cost of instant refunds (settlement risk, fraud exposure), not just the customer-facing win',
      'If a pivot fired: treats the competitive timeline pressure as real without abandoning sound reasoning for a rushed match'
    ]
  },
  {
    id: 'QE-455', pri: 'high', est: '2 days',
    title: 'Next-quarter roadmap and OKRs for checkout',
    desc: 'The capstone: synthesize everything shipped this run into a real roadmap with measurable goals, not a wishlist.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> This is the closing ticket. Leadership wants next quarter's checkout roadmap and OKRs, informed by what actually happened this run — the wallet launch, the Riyadh expansion, the incident, the BNPL sunset, all of it.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A roadmap: 2-4 priorities for next quarter, each with a measurable objective and key results, explicitly informed by what you learned working the tickets before this one.</p>`,
    delivLabel: '<b>Deliverable — roadmap + OKRs.</b> 2-4 priorities, each with a measurable objective and key results, grounded in this run\'s actual outcomes.',
    rubric: [
      'Priorities are explicitly justified by what happened earlier in the run (a launch, an incident, a sunset) rather than generic checkout best-practices',
      'Each objective has key results that are actually measurable, not aspirational adjectives',
      'Reasonable in scope — 2-4 priorities, not a ten-item wishlist with no prioritization',
      'Shows awareness of trade-offs (why these priorities and not others)',
      'Reads as a synthesis of the whole run, not a document that could have been written on day one'
    ]
  }
];

// ── Design track: UI/UX product design, same Meridian checkout story ──────
const TICKETS_DESIGN = [
  {
    id: 'QD-401', pri: 'high', est: '2 days',
    title: 'Adapt the checkout flow for Arabic RTL',
    desc: "The Cairo build ships with the LTR grid mirrored by CSS alone. Icons flip that shouldn't, the total row breaks under text expansion, and nobody has specified the rules.",
    reviewer: 'design',
    pivotEligible: true,
    brief: `<p><b>Context.</b> Checkout for Cairo ships in 6 days. The current build mirrors the layout with <code>direction: rtl</code> and nothing else.</p>
      <p style="margin-top:10px"><b>Known breakages from the Cairo QA pass:</b></p>
      <p style="margin-top:8px;line-height:1.8">· The back chevron mirrors correctly. The clock icon and the Vodafone Cash logo also mirror, and should not.<br>
      · "Complete payment" becomes "إتمام الدفع ٱلآن" and the button clips at 320px.<br>
      · The order total right-aligns in LTR. In RTL it lands under the label.</p>
      <p style="margin-top:12px"><b>Deliverable.</b> A written layout spec engineering can implement without asking you follow-up questions.</p>`,
    delivLabel: '<b>Deliverable — RTL layout spec.</b> Mirroring rules, expansion handling, touch targets. Written so engineering does not need to ask you anything.',
    rubric: [
      'A clear mirror / never-mirror taxonomy (directional icons mirror; clock and brand/payment marks never do)',
      'Every rule is a number, not an adjective — button min-widths, line-height, breakpoints actually tested',
      'Specifies logical properties (inline-start/end) rather than physical left/right anywhere in the spec',
      'Names concrete touch-target sizes, especially anything QA already flagged as too small',
      'If a pivot fired: the spec still holds — or is explicitly updated — for whatever changed'
    ]
  },
  {
    id: 'QD-404', pri: 'med', est: '1 day',
    title: 'Design system audit for the checkout component library',
    desc: 'Three regional launches have each quietly forked their own button/input variants. Nobody has looked at the drift in one place.',
    reviewer: 'design',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Cairo, Riyadh, and Karachi checkout each shipped under deadline pressure, and each one has small unsanctioned variants of shared components (button radius, input focus states, spacing) that never made it back into the design system.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An audit: what's actually drifted, which variant should become canonical (with reasoning), and a prioritized list of what to reconcile first.</p>`,
    delivLabel: '<b>Deliverable — audit.</b> What drifted, the canonical choice with reasoning, and a prioritized reconciliation list.',
    rubric: [
      'Names specific, real drift (not a generic "components are inconsistent" statement)',
      'Picks a canonical variant with actual reasoning, not just "whichever shipped first"',
      'Prioritizes the reconciliation list — highest-visibility or highest-risk drift first',
      'Realistic about not reconciling everything at once given engineering capacity',
      'Proposes how to prevent this drift recurring after the next regional launch'
    ]
  },
  {
    id: 'QD-408', pri: 'med', est: '1 day',
    title: 'Spec empty and error states across the checkout flow',
    desc: 'Every checkout screen has a designed happy path and almost no designed failure path. Support tickets trace back to undesigned error states.',
    reviewer: 'design',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Engineering has been improvising error and empty states (a declined card, an empty cart, a timed-out payment) because none were ever actually designed — just implemented ad hoc, inconsistently, screen to screen.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A spec covering the highest-traffic error/empty states in checkout: what the user sees, what they can do next, and how it's visually distinct from a normal state.</p>`,
    delivLabel: '<b>Deliverable — error/empty state spec.</b> Coverage of the highest-traffic cases, each with a clear next action for the user.',
    rubric: [
      'Covers the states that actually matter most (declined payment, timeout) rather than an exhaustive but unprioritized list',
      'Every state gives the user a concrete next action, not just an apology message',
      'Visually and structurally consistent with the existing design system rather than one-off treatments',
      'Distinguishes a recoverable error (retry the payment) from a dead-end one (contact support)',
      'Specific enough that engineering does not have to invent copy or layout on the spot'
    ]
  },
  {
    id: 'QD-412', pri: 'high', est: '2 days',
    title: 'Onboard Vodafone Cash into the payment method selection UI',
    desc: 'The payment method list was designed for exactly one card type. It now needs to hold wallets too, with room for more later.',
    reviewer: 'design',
    pivotEligible: true,
    brief: `<p><b>Context.</b> The current payment method screen was designed assuming card-only. Vodafone Cash needs to be added as a real first-class option, not squeezed in below the fold, and Fawry is coming next quarter after this.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A redesigned payment method selection UI that scales past two options, with a clear default/priority ordering rule (not just "cards first because that's how it's always been").</p>`,
    delivLabel: '<b>Deliverable — payment method selection spec.</b> A layout that scales to 3+ methods, plus the rule for what orders/defaults to what.',
    rubric: [
      'The layout genuinely scales past 2 methods, not just visually accommodates the one being added right now',
      'States an explicit ordering/default rule (e.g. by locale, by conversion data) rather than leaving it arbitrary',
      'Considers how a returning user\'s last-used method is (or isn\'t) remembered',
      'Addresses visual hierarchy so wallets don\'t read as an afterthought bolted onto a card-first design',
      'If a pivot fired (e.g. wallet-first direction): the ordering rule actually reflects the new priority, not the old one'
    ]
  },
  {
    id: 'QD-416', pri: 'med', est: '1 day',
    title: 'Accessibility pass on checkout: contrast, focus states, and touch targets',
    desc: 'A prospective enterprise client asked about WCAG compliance. This ticket is the actual design fixes, not just the audit plan.',
    reviewer: 'design',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Following an initial accessibility scoping pass, several concrete issues were flagged in checkout: low-contrast secondary text, no visible focus ring on the payment method radio buttons, and touch targets under 44px on the order summary's edit controls.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> Specific fixes for the flagged issues: corrected contrast values, a defined focus-state treatment, and touch-target sizing — ready for engineering to implement directly.</p>`,
    delivLabel: '<b>Deliverable — accessibility fix spec.</b> Corrected values for contrast, focus states, and touch targets, ready to implement.',
    rubric: [
      'Contrast fixes reference actual target ratios (e.g. WCAG AA 4.5:1), not just "make it darker"',
      'Defines one consistent focus-state treatment reusable across checkout, not a one-off per element',
      'Touch targets meet a stated minimum (44px or similar) with specifics on which elements need it',
      'Fixes stay within the existing visual language rather than introducing an unrelated new style',
      'Prioritized if not everything can ship at once — states what matters most'
    ]
  },
  {
    id: 'QD-420', pri: 'high', est: '2 days',
    title: 'Redesign the order summary for wallet-first checkout',
    desc: "Wallet-first changes what information matters most on the order summary screen — the old layout assumed card as the default mental model.",
    reviewer: 'design',
    pivotEligible: true,
    brief: `<p><b>Context.</b> The order summary screen was designed around a card-first mental model (a "pay with card ending in ****" line is the visual anchor). Wallet-first checkout doesn't have that anchor in the same way, and early wallet users have reported confusion about what they're actually confirming.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A redesigned order summary that works for both wallet and card, with a clear confirmation moment regardless of payment method.</p>`,
    delivLabel: '<b>Deliverable — order summary redesign.</b> Works for wallet and card alike, with an unambiguous confirmation moment.',
    rubric: [
      'Identifies the actual root confusion (missing confirmation anchor for wallets), not just "wallets need a new icon"',
      'The redesign genuinely works for both payment types rather than being wallet-only with card as an afterthought',
      'Confirmation moment (what the user is agreeing to pay) is unambiguous regardless of method',
      'Consistent with the rest of the checkout visual language',
      'Grounded in the real user confusion reported, not a generic visual refresh'
    ]
  },
  {
    id: 'QD-424', pri: 'med', est: '1 day',
    title: 'Design-to-engineering handoff spec for the Riyadh launch components',
    desc: 'Handoffs have been informal Figma comments. Daniyal wants a real spec before the next regional launch adds more surface area.',
    reviewer: 'design',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Design handoff for previous launches has been ad hoc Figma comments and Slack threads, which has caused rework when engineering implemented something slightly different than intended. Riyadh adds new Mada-specific UI on top of an already-growing component set.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A structured handoff spec for the Riyadh components: states, spacing, interaction behavior, and edge cases — the kind of document that prevents a round of "that's not quite what I meant."</p>`,
    delivLabel: '<b>Deliverable — handoff spec.</b> States, spacing, interaction behavior, and edge cases for the Riyadh-specific components.',
    rubric: [
      'Covers component states beyond default (hover, disabled, loading, error) — not just the happy-path screenshot',
      'Interaction behavior is described precisely enough to avoid engineering guessing (what happens on tap, on error)',
      'Names edge cases specific to Mada/Riyadh rather than a generic handoff template',
      'Structured so it is genuinely reusable as a reference during implementation, not a one-time wall of text',
      'Reasonable in scope for a 1-day ticket — covers the actual new components, not a full system rewrite'
    ]
  },
  {
    id: 'QD-428', pri: 'high', est: '2 days',
    title: 'Propose the checkout design system\'s next-quarter priorities',
    desc: 'The capstone: synthesize the drift, the RTL work, the accessibility fixes, and the handoff process into a real design-system roadmap.',
    reviewer: 'design',
    pivotEligible: false,
    brief: `<p><b>Context.</b> This is the closing ticket. Emma wants a proposal for what the checkout design system should prioritize next quarter, informed by everything that came up this run — the RTL spec, the component drift audit, the accessibility fixes, the handoff friction.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A roadmap: 2-4 design-system priorities for next quarter, each grounded in something concrete that happened this run.</p>`,
    delivLabel: '<b>Deliverable — design-system roadmap.</b> 2-4 priorities, each grounded in this run\'s actual outcomes.',
    rubric: [
      'Each priority is explicitly justified by something that happened earlier in the run, not a generic best-practices list',
      'Reasonable in scope — 2-4 priorities, prioritized, not an unranked wishlist',
      'Shows awareness of trade-offs between competing priorities',
      'Considers the handoff-friction problem specifically, since that recurred across multiple tickets this run',
      'Reads as a synthesis of the whole run, not something that could have been written on day one'
    ]
  }
];

// ── Frontend Engineering track: same Meridian checkout story, client-side ──
const TICKETS_FE = [
  {
    id: 'QF-401', pri: 'high', est: '2 days',
    title: 'Get checkout usable on 3G',
    desc: 'Checkout ships a 480KB JS bundle. On the Cairo test device (Redmi 9A, throttled 3G) time-to-interactive is 11.2s. Target is under 5s. Do not break the payment path.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> 41% of Cairo sessions arrive on 3G or worse. Checkout currently ships one bundle containing every payment adapter, including the ones that locale will never use.</p>
      <p style="margin-top:10px"><b>Measured baseline (Redmi 9A, throttled 3G):</b></p>
      <p style="margin-top:8px;font-family:var(--mono);font-size:11.5px;color:var(--ink-3);line-height:1.8">bundle.js        480 KB<br>time-to-interactive  11.2 s<br>payment adapters     6 loaded / 1 used</p>
      <p style="margin-top:12px"><b>Deliverable.</b> An optimization plan with the specific changes, expected savings, and the failure mode of each change.</p>`,
    delivLabel: '<b>Deliverable — optimization plan.</b> Named changes, expected savings, and what breaks if each one goes wrong.',
    rubric: [
      'Every proposed change states a failure mode and how it is mitigated, not just an expected saving',
      'Explicitly names something ruled out and why (shows real trade-off thinking, not just a list of wins)',
      'Preserves the payment path\'s reliability on a bad connection — the brief calls this out directly',
      'Gives a projected before/after number for bundle size and time-to-interactive',
      'If a pivot fired: adjusts which adapter is prioritized for preloading without abandoning the rest of the plan'
    ]
  },
  {
    id: 'QF-404', pri: 'high', est: '2 days',
    title: 'Client-side integration plan for the Vodafone Cash SDK',
    desc: 'The wallet provider SDK has its own auth flow, its own error codes, and a different latency profile than the card adapter. It cannot be bolted on the same way cards were.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> The Vodafone Cash SDK requires an OTP-style auth redirect mid-checkout, has its own retry/error semantics, and historically has had higher p95 latency than the card adapter. Bolting it on with the same integration pattern as cards risks a confusing hang state for the user.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An integration plan: how the SDK's auth flow fits into the existing checkout state machine, timeout/retry handling, and what the user sees while it's pending.</p>`,
    delivLabel: '<b>Deliverable — integration plan.</b> Auth-flow fit, timeout/retry handling, and the pending-state UX contract with design.',
    rubric: [
      'Addresses the OTP/auth-redirect flow as a genuinely different pattern from card auth, not a copy-paste',
      'Specifies timeout and retry behavior with actual numbers, not "handle errors gracefully"',
      'Defines what happens to checkout state if the user abandons mid-auth-redirect',
      'Calls out the pending-state UX as something requiring a design contract, not an engineering-only decision',
      'If a pivot fired: treats the wallet path as the priority path, not a bolted-on afterthought'
    ]
  },
  {
    id: 'QF-408', pri: 'med', est: '1 day',
    title: 'Error boundary and resilience pass on the checkout tree',
    desc: 'A single component throwing during render currently takes down the whole checkout page. Sentinel has logged three of these this month.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Checkout has no error boundaries — an unhandled exception anywhere in the render tree (a malformed price, a null field from a flaky API response) white-screens the entire page instead of failing just that component.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A resilience plan: where error boundaries go, what each shows on failure, and how failures get reported without spamming the error tracker.</p>`,
    delivLabel: '<b>Deliverable — resilience plan.</b> Boundary placement, fallback UI per boundary, and a sane error-reporting approach.',
    rubric: [
      'Boundary placement is deliberate (isolates genuinely independent sections) rather than one boundary around everything',
      'Each boundary\'s fallback still lets the user do something (retry, contact support) rather than just showing a blank error card',
      'Addresses error-reporting noise — not every caught error needs to page someone',
      'Grounded in the actual incidents mentioned in the brief where relevant',
      'Reasonable in scope for a 1-day ticket — a plan, not a full component-by-component rewrite'
    ]
  },
  {
    id: 'QF-412', pri: 'high', est: '2 days',
    title: 'Implementation plan for the RTL checkout spec',
    desc: "Design handed off an RTL layout spec. Translate it into an actual engineering approach — logical properties, breakpoints, and the seams where a third-party SDK won't cooperate.",
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Design's RTL spec calls for logical CSS properties throughout and a defined mirror/never-mirror icon taxonomy. The checkout codebase currently uses physical left/right properties extensively, and at least one payment provider SDK renders its own iframe that may not respect page-level RTL settings.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An implementation plan: the migration approach from physical to logical properties, how the icon mirroring gets enforced (lint rule, component API, etc.), and how the SDK iframe seam gets handled.</p>`,
    delivLabel: '<b>Deliverable — implementation plan.</b> Migration approach, an enforcement mechanism for the mirroring rules, and the SDK iframe seam handled explicitly.',
    rubric: [
      'Proposes a concrete migration approach (incremental vs. big-bang) with a stated reason for the choice',
      'The mirroring rule enforcement is a real mechanism (lint rule, shared component), not "developers will remember"',
      'Directly addresses the SDK iframe seam design flagged as an open question, rather than ignoring it',
      'Realistic about the size of the physical-to-logical-properties migration given the existing codebase',
      'Traceable back to the actual design spec rather than reinventing the RTL rules independently'
    ]
  },
  {
    id: 'QF-416', pri: 'med', est: '1 day',
    title: 'Test coverage plan for the checkout critical path',
    desc: 'Checkout has almost no automated test coverage on the payment-submission path — every regression is caught by users, not CI.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> The last three production incidents on checkout were all regressions that would have been caught by a test that didn't exist. There's no disagreement that more coverage is needed — the question is what to cover first given limited engineering time.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A coverage plan: which paths get tested first and why, what kind of test each needs (unit vs. integration vs. e2e), and a rough estimate of effort.</p>`,
    delivLabel: '<b>Deliverable — test coverage plan.</b> Prioritized paths, the right test type for each, and a rough effort estimate.',
    rubric: [
      'Prioritization is based on actual risk/incident history, not generic "test everything" advice',
      'Matches test type to what\'s actually being verified (an e2e test for something a unit test could cover is a red flag)',
      'Gives a realistic effort estimate rather than a vague "as soon as possible"',
      'Addresses the payment-submission path specifically, since that\'s what the brief calls out',
      'Acknowledges what will NOT be covered yet, and why that\'s an acceptable near-term trade-off'
    ]
  },
  {
    id: 'QF-420', pri: 'high', est: '2 days',
    title: 'Fix the performance regression introduced by the wallet-first pivot',
    desc: 'Moving Vodafone Cash to the top of the payment list eagerly loads its SDK earlier, and time-to-interactive quietly got worse for everyone, including card users.',
    reviewer: 'tlead',
    pivotEligible: true,
    brief: `<p><b>Context.</b> After the wallet-first pivot, the Vodafone Cash SDK now loads eagerly on page load instead of lazily, because it's now the default/first payment method shown. This regressed time-to-interactive for all users, including the majority still using cards, which nobody caught before it shipped.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A fix plan: how to keep wallet-first prioritization in the UI without eagerly loading its SDK for every single session, plus how this kind of regression gets caught before shipping next time.</p>`,
    delivLabel: '<b>Deliverable — fix plan.</b> How wallet-first UI priority and lazy SDK loading coexist, plus a prevention mechanism for next time.',
    rubric: [
      'Correctly separates "what\'s shown first in the UI" from "what\'s loaded eagerly" — these got conflated in the regression',
      'The fix genuinely doesn\'t regress the wallet UX in the process of fixing the performance issue',
      'Proposes a concrete prevention mechanism (a performance budget in CI, a bundle-size check) rather than "be more careful"',
      'Quantifies the regression and the expected fix impact with real numbers',
      'Directly acknowledges this was caused by the earlier pivot rather than treating it as an unrelated bug'
    ]
  },
  {
    id: 'QF-424', pri: 'med', est: '1 day',
    title: 'Implementation plan for keyboard navigation and ARIA on checkout',
    desc: 'Design specified focus states and touch targets. This ticket is the engineering side: actual keyboard nav order and ARIA roles.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> Design delivered a spec for visible focus states and touch target sizing. The remaining gap is keyboard navigation order through the payment method list and form fields, and correct ARIA roles/labels for screen readers — neither of which a visual spec fully covers.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> An implementation plan: the intended tab order through checkout, which ARIA roles/labels apply where, and how this gets verified (manual pass, automated audit tool, or both).</p>`,
    delivLabel: '<b>Deliverable — a11y implementation plan.</b> Tab order, ARIA roles/labels, and a verification approach.',
    rubric: [
      'Specifies an actual tab order through the payment method list and form, not just "make it keyboard accessible"',
      'Names specific ARIA roles/labels for the non-obvious cases (custom radio-like payment method rows, dynamic error messages)',
      'Proposes a real verification approach, ideally combining an automated tool with a manual screen-reader pass',
      'Builds on design\'s existing spec rather than re-deriving visual requirements from scratch',
      'Reasonable in scope for a 1-day ticket — a plan for the checkout flow specifically, not the whole product'
    ]
  },
  {
    id: 'QF-428', pri: 'high', est: '2 days',
    title: 'Propose next quarter\'s technical roadmap for checkout',
    desc: 'The capstone: synthesize the perf work, the RTL migration, the test-coverage gaps, and the wallet integration lessons into a real technical roadmap.',
    reviewer: 'tlead',
    pivotEligible: false,
    brief: `<p><b>Context.</b> This is the closing ticket. Daniyal wants a technical roadmap for next quarter, informed by everything that came up this run — the 3G performance work, the RTL migration, the wallet SDK integration, the test-coverage gaps, the pivot-induced regression.</p>
      <p style="margin-top:10px"><b>Deliverable.</b> A roadmap: 2-4 technical priorities for next quarter, each grounded in something concrete that happened this run, with a rough effort estimate.</p>`,
    delivLabel: '<b>Deliverable — technical roadmap.</b> 2-4 priorities, each grounded in this run\'s actual outcomes, with rough effort estimates.',
    rubric: [
      'Each priority is explicitly justified by something that happened earlier in the run, not generic engineering best-practices',
      'Reasonable in scope — 2-4 priorities, prioritized against each other, not an unranked wishlist',
      'Gives rough effort estimates, showing awareness of what\'s actually achievable next quarter',
      'Addresses technical debt (physical CSS properties, missing tests) alongside new capability work, not just new features',
      'Reads as a synthesis of the whole run, not something that could have been written on day one'
    ]
  }
];

// ── track-aware lookup ──────────────────────────────────────────────────
const BANKS = { pm: TICKETS_PM, design: TICKETS_DESIGN, fe: TICKETS_FE };

function getTicket(track, idx) {
  // Backward-compatible: a single numeric argument means "PM track, that
  // index" (the original single-track signature).
  if (typeof track === 'number') { idx = track; track = 'pm'; }
  const bank = BANKS[track] || TICKETS_PM;
  return bank[idx] || null;
}

function totalTickets(track) {
  return (BANKS[track] || TICKETS_PM).length;
}

module.exports = {
  TICKETS: TICKETS_PM, // legacy alias — PM was the only track when this was named generically
  TICKETS_PM, TICKETS_DESIGN, TICKETS_FE,
  getTicket, totalTickets,
  TOTAL_TICKETS: TICKETS_PM.length // legacy alias, PM-track count specifically
};
