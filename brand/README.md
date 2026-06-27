# Countersign — Brand & Ecosystem Kit

One identity for the control plane of agent money. Everything here is themed from a
single token file, so a developer surface and a marketing surface always look like the
same company.

Open **`index.html`** as the hub.

| File | What it is | Surface |
|---|---|---|
| `tokens.css` | The design tokens — color, type, space, motion. **Single source of truth.** Import it; build only with `var(--cs-*)`. | dev + marketing |
| `design-system.html` | Brand foundation, logo & usage, color, type, component library, motifs, voice & tone. | dev + marketing |
| `system-map.html` | Interactive architecture — evaluate a spend, then freeze all four rails and watch the ledger fill. | marketing + docs |
| `roadmap.html` | The five moats + the Tier 0–4 integration horizon. | marketing + strategy |
| `whitepaper.html` | The full technical & strategic white paper (web). Print-ready. | marketing + sales |
| `countersign-whitepaper.pdf` | The downloadable white paper (11pp, A4). | sales / share |
| `index.html` | The brand hub linking all of the above. | entry point |

## Using the tokens

```html
<link rel="stylesheet" href="tokens.css" />
<style>
  .cta { background: var(--cs-accent); color: var(--cs-accent-ink); }
  .panel { background: var(--cs-surface); border: 1px solid var(--cs-border); }
</style>
```

Core decisions encoded in the tokens:

- **Canvas** near-black `#07080b`; **signal green** `#5cf2a9` = live/allowed/safe; **brand blue**
  `#7c9cff` = structure; **amber** = caution; **red** = the freeze. Color carries meaning, never decoration.
- **Inter** is the human voice (prose, headlines); **SF Mono** is the machine voice (labels, metrics, code).
- Signature motifs: the hairline **blueprint grid**, one **signal-green aurora**, and the **+ node**.

## Regenerating the white-paper PDF

The PDF is rendered from `whitepaper.html` with a print-emulating headless browser
(`print_background: true`, A4). Re-run after editing the white paper. The `@media print`
block in `whitepaper.html` controls pagination and forces gradient headlines to a solid
color so they print cleanly.

> Testnet only; mainnet follows a third-party audit. Countersign holds policy, freeze, and a
> tamper-evident ledger — it never takes custody of funds. © 2026 Countersign. Apache-2.0 open core.
