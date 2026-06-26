# Cosign — Non-Meeting GTM + the `countersign.network` Rename

*Companion to `pricing-and-gtm.md`, `moat-and-integration-roadmap.md`, and `NEXT-STEPS.md`. Written 2026-06-26.*

---

## Part 1 — A non-meeting GTM strategy

The product is already shaped for a sales-meeting-free motion: open-core, MCP-distributed, one-command install, a public falsifiable demo, and a hash-chained ledger that is itself shareable proof. The goal here is to make *everything* one-to-many and asynchronous — no calls, no scheduled demos, no "book a time." A prospect should be able to discover, install, freeze three vendors, and pay, without ever talking to a human.

### Pillar 1 — Be where agent builders already are (distribution, not outreach)

The single biggest unlock is the one item still open in `NEXT-STEPS`: **publish `@cosign/mcp`, `@cosign/sdk`, and `@cosign/x402` to npm** so install is one line. Once that exists, the front door propagates itself:

- List the MCP server in every registry and directory — Anthropic's MCP registry, Smithery, mcp.so, Glama, PulseMCP, the Cursor directory, `awesome-mcp-servers`. Each listing is an evergreen, passive install surface that costs nothing to maintain.
- Get into the ecosystems your three backends already feed: Coinbase CDP / AgentKit examples, `awesome-x402`, Turnkey and Openfort community showcases. You govern their rails, so you belong on their integration pages.
- Treat GitHub as top-of-funnel: a tight README, repo topics, and the open-source front door make the project discoverable, forkable, and trend-eligible — the "de-facto neutral standard" claim only works if the standard is one `npx` away.

### Pillar 2 — The demo *is* the marketing (proof you link, not present)

You already have the asset most startups lack: a falsifiable claim that runs in under a second (`live-freeze.ts`, ~697ms, signed ledger). Package it so nobody needs a meeting to see it.

- A 60-second screen capture (GIF + video) of three vendors frozen at once, plus an always-on public dashboard anyone can hit.
- Lead with the falsifiable test — *"don't take our word for it; run `npx @cosign/mcp` and freeze three vendors yourself in under a second."* Inviting people to falsify the claim is more persuasive than a guided demo, and it scales infinitely.
- The public, independently-verifiable ledger (public key already exposed at `/ledger`) is a trust artifact you paste into a thread, not something you walk someone through.

### Pillar 3 — Content and category SEO (asynchronous teaching)

Own the language of the category so search and word-of-mouth route to you:

- Write the canonical explainer ("a kill switch for AI agents that spend money," "cross-vendor agent-spend governance") and one integration guide per rail — Coinbase, Turnkey, Openfort, x402. These do double duty as both SEO capture and the docs an installing developer needs next.
- This content layer also routes *around* the naming problem in Part 2: today "cosign" search traffic is owned by Sigstore, so category-phrase SEO (not brand-name SEO) is the only viable organic channel until/unless you rename.

### Pillar 4 — Launch spikes (one-to-many events, still no meetings)

Concentrated, asynchronous launch moments fit a security-flavored, runnable dev tool well:

- *Show HN* — "Show HN: a kill switch for AI agents across 3 wallet vendors, freeze in <1s, fully audited." HN rewards falsifiable, runnable, security-adjacent tooling.
- Product Hunt, Lobsters, dev.to, the relevant subreddits (r/AI_Agents, r/LocalLLaMA, crypto-dev communities), build-in-public threads on X, and the agent/crypto-infra newsletters.
- Each npm release and GitHub release note is a recurring micro-launch — ship visibly.

### Pillar 5 — Self-serve monetization + inbound design partners

Keep the money motion as meeting-free as the adoption motion:

- Free testnet tier stays the adoption engine. Put the mainnet/usage tier behind **self-serve Stripe checkout** — sign up, add a card, get an API key, no call.
- For enterprise, publish pricing and a self-serve **self-host license** / signed compliance-export path wherever legally possible; close the rest async over email/issue/Discord rather than a standing sales meeting.
- Recruit design partners by **inbound** ("open an issue / DM / Discord"), and validate the core moat assumption from telemetry, not interviews — see below.

### The one thing this replaces

`NEXT-STEPS ①.3 / ③` asks you to *name design partners and interview them* to confirm operators run **more than one backend** (the entire moat). That's the only meeting-shaped task in the current plan. Replace it: instrument the connect-a-backend dashboard (the `connects` metric is already wired to the ledger per the latest commits) and **read the second-backend-connect rate from real self-serve usage**. The moat gets validated by behavior, not by a calendar invite.

### Loops and metrics (all meeting-free)

The four loops in `pricing-and-gtm.md` already run without sales contact — distribution (MCP embeds), data flywheel (`/evaluate` on every tx), trust (shareable ledger), and A2A (a payer requiring its payee be governed). Track a funnel made only of self-serve signals: npm installs/week, GitHub stars + forks, MCP-directory installs, demo/`live-freeze` runs, decisions evaluated/week, **% of operators connecting a second backend** (the moat metric), time-to-first-freeze, and free→paid self-serve conversion.

### What to do first

1. Publish the three packages to npm (the gating unlock).
2. Ship the public demo GIF/video + keep the live dashboard always-on.
3. List in the MCP directories and the Coinbase/x402/Turnkey/Openfort ecosystems.
4. Write the category explainer + four integration guides.
5. Wire self-serve Stripe checkout for the usage tier; instrument the second-backend metric.
6. Run the Show HN / Product Hunt / npm launch spike once 1–4 are live.

---

## Part 2 — Review: the rename to `countersign.network`

**Verdict: the rename is well-justified and I'd proceed — chiefly to escape the Sigstore `cosign` collision — conditional on a trademark clearance check and securing the domain. Do the refactor *before* you publish to npm and launch publicly, because that is when it is cheapest.** Note there are no `countersign` references in the repo yet; this is still a proposal.

### Why moving off "cosign" is the right call

The name "cosign" collides head-on with **Sigstore `cosign`**, the de-facto tool for signing containers and software artifacts — and it collides in *exactly* your audience (developers + software security) and your semantic field (signing, trust, provenance). That's the worst kind of collision:

- **SEO is unwinnable.** Organic search for "cosign" returns Sigstore. A product whose whole thesis is "discoverable, forkable, the de-facto neutral standard" cannot share a name with an existing de-facto standard.
- **Namespace + recall confusion.** `@cosign/*` on npm and "cosign" on GitHub sit next to a widely-installed tool that does a different kind of signing. Developers will conflate the two.

For a pre-launch project, carrying that collision into npm and a public launch is a real, compounding liability. Renaming now is the cheap moment.

### Why "countersign" is a strong choice specifically

- **It's semantically *more* accurate than "cosign."** To *countersign* is to add a second, approving signature to something already initiated — which is precisely what the product is: the second signer / approval gate on an agent's transaction (the pre-flight `/evaluate` guard, the human-in-the-loop approval, the freeze). "Co-sign" implies signing jointly; "countersign" implies approving after the fact. The product is the latter.
- **`.network` does brand work.** It reinforces the actual positioning — neutral, cross-vendor, "governance propagates along the spend graph," the agent-passport registry. You are a network, not a wallet, and the TLD says so.
- **The crypto/fintech field is clear.** No company or product named "Countersign" turned up in agent payments, wallets, or crypto security — so within your competitive space the name is open.

### The risks to clear before committing

- **Existing "Countersign" marks in the adjacent signing space.** `countersign.com` is an e-signature SaaS, and link22 ships a "Countersign" digital-signature-verification product (defense/security). Neither competes with you, but both sit close enough in the "signing/security software" field to create confusion and to complicate a trademark claim. **Action: a trademark clearance search in the software/SaaS classes (Nice 9/42) before you commit.**
- **`.com` is taken, so you're on `.network`.** Two downsides: (1) typo-leak — people default to `.com` and land on a *competitor's e-sign site*, which is actively harmful; (2) `.network` carries slightly lower default trust/recall. **Action: secure `countersign.network` plus defensive variants you can actually get (e.g. `countersign.dev`, `getcountersign.com`, `trycountersign.com`, `countersign.sh`).** The brand name and the TLD are separable decisions — if `.network` typo-leak feels unacceptable, keep "Countersign" and pick a cleaner primary domain.
- **Verify the domain is actually available.** I could not check registration from this environment (no DNS/registrar access here). **Action: confirm `countersign.network` is unregistered/available at a registrar before planning around it.**
- **Slightly longer as a CLI/package name.** `npx @countersign/mcp` is a mouthful next to `@cosign/mcp`. Minor, and worth it.

### Migration cost — and why timing is everything

The rename touches **~98 files and ~323 references** (the `@cosign/*` package namespace, the `COSIGN_API_KEYS` / `COSIGN_URL` / `COSIGN_DEMO_TRAFFIC` env vars, the repo name, the hosted Render URL, and the demo scripts). It's mechanical but real.

The decisive point: **it is dramatically cheaper now than later.** The packages are *not yet published to npm* (still an open to-do), there are no external users, and it's testnet-only. Renaming after npm publish + public launch + first design partners means deprecated packages, install redirects, broken links, and brand confusion. So the recommendation isn't just "rename" — it's **rename before the npm publish and the public push, or not at all.**

### Recommendation in one line

Proceed with **Countersign**, pending (1) trademark clearance vs. the existing e-sign marks and (2) securing `countersign.network` + defensive domains — and execute the refactor *before* publishing to npm. If clearance comes back messy, the Sigstore collision still means "cosign" should go; fall back to another coined one-word name rather than staying put.

---

### Sources

- Sigstore `cosign`: <https://github.com/sigstore/cosign> · <https://docs.sigstore.dev/cosign/signing/signing_with_containers/>
- Existing "Countersign" e-signature SaaS: <https://countersign.com/>
- link22 "Countersign" signature-verification product: <https://link22.eu/product/countersign/>
