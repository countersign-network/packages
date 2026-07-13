/**
 * The "guarded payee" pattern — governance propagating along the payment graph.
 *
 * When agents hire agents (A2A + AP2), the agent PAYING carries the risk of the
 * agent being PAID: a rogue payee mid-job is the payer's incident. So the payer
 * wants two things before money moves:
 *
 *   1. the payee to be GOVERNED — a policy, a kill switch, and an audit ledger
 *      someone can actually pull, and
 *   2. its OWN spend to be guarded — the payment checked against the payer's
 *      policy at the moment of paying, not after.
 *
 * This example runs both sides against the hosted Countersign Core, end to end,
 * with a self-serve key. No account, no configuration, testnet-only.
 *
 *   npx tsx src/index.ts
 */
import { CountersignClient } from "@countersign/sdk";
import { parseAp2, withAp2Guard, Ap2Denied, type Ap2Mandate } from "@countersign/ap2";

const CORE = process.env.COUNTERSIGN_URL ?? "https://app.countersign.network";

// ---------------------------------------------------------------------------
// Payee side: advertise governance on the agent card.
//
// A2A agent cards are JSON descriptors (served at /.well-known/agent.json).
// The exact extension schema is still settling upstream, so treat the shape as
// illustrative — the PATTERN is the point: a payee that is governed says so,
// verifiably, on its card.
// ---------------------------------------------------------------------------
interface GuardedAgentCard {
  name: string;
  description: string;
  url: string;
  extensions: {
    countersign: {
      guarded: true;
      /** The Core this agent's policy/freeze/ledger live on. */
      core: string;
      agentId: string;
      /** Where an auditor (or a payer) pulls the signed, hash-chained ledger. */
      ledger: string;
    };
  };
}

function buildAgentCard(agentId: string): GuardedAgentCard {
  return {
    name: "translator-bot",
    description: "Translates documents for a fee. Guarded by Countersign — npx @countersign/mcp",
    url: "https://translator.example",
    extensions: {
      countersign: { guarded: true, core: CORE, agentId, ledger: `${CORE}/ledger` },
    },
  };
}

// ---------------------------------------------------------------------------
// Payer side.
// ---------------------------------------------------------------------------
function assertPayeeGoverned(card: GuardedAgentCard): void {
  const g = card.extensions?.countersign;
  if (!g?.guarded || !g.core || !g.ledger) {
    throw new Error(`payee "${card.name}" does not advertise spend governance — not paying it`);
  }
  // In production, don't take the card's word for it: pull the payee's ledger
  // and verify the hash chain against its published Ed25519 key. The ledger is
  // the proof; the card is just the pointer to it.
  console.log(`✓ payee "${card.name}" is governed (core: ${g.core})`);
}

/** A minimal AP2 Gen-2 PaymentMandate (amount = integer minor/base units). */
function mandateFor(amountBaseUnits: number): Ap2Mandate {
  return {
    vct: "mandate.payment.1",
    transaction_id: `tx_${amountBaseUnits}`,
    payee: { id: "translator-bot", name: "Translator Bot" },
    payment_amount: { amount: amountBaseUnits, currency: "USDC" },
    payment_instrument: { type: "x402" },
  };
}

async function main(): Promise<void> {
  // Self-serve tenant — an isolated sandbox with a seeded demo fleet.
  const signup = await fetch(`${CORE}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "a2a-ref" }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
  const { apiKey } = (await signup.json()) as { apiKey: string };
  const cs = new CountersignClient({ baseUrl: CORE, apiKey });

  const payerAgentId = "payments-bot"; // one of the seeded demo agents

  // The payer's own policy: pay for jobs, but never more than 1 USDC per job.
  await cs.applyPolicy({
    agentId: payerAgentId,
    policy: { schemaVersion: 1, asset: "USDC", perTxCap: "1000000", dailyCap: "5000000" },
  });

  // 1. Governance check on the payee.
  const card = buildAgentCard("translator-bot");
  assertPayeeGoverned(card);

  // 2. Guard our own payment — in policy (0.40 USDC): the pay callback runs.
  const ok = parseAp2(mandateFor(400_000));
  if (!ok) throw new Error("mandate failed to parse");
  await withAp2Guard(cs, payerAgentId, ok, async () => {
    console.log(`✓ ALLOWED  ${ok.amount} ${ok.asset} — signing the PaymentMandate`);
  });

  // 3. Over-cap (2 USDC): withAp2Guard throws BEFORE the mandate is signed.
  const over = parseAp2(mandateFor(2_000_000));
  if (!over) throw new Error("mandate failed to parse");
  try {
    await withAp2Guard(cs, payerAgentId, over, async () => {
      throw new Error("unreachable — the guard must deny first");
    });
  } catch (e) {
    if (!(e instanceof Ap2Denied)) throw e;
    console.log(`✓ DENIED   ${over.amount} ${over.asset} — ${e.decision.reason ?? e.decision.outcome}`);
  }

  // Every decision above is already in the tamper-evident ledger.
  const ledger = await cs.ledger();
  console.log(`✓ ledger: ${ledger.records.length} records, signed hash chain`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
