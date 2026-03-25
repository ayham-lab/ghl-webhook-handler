// Stripe Payment Webhook Handler
// Fires when someone completes a Stripe checkout → moves opportunity to "Paid" stage

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_TOKEN = process.env.GHL_API_TOKEN;
const LOCATION_ID = "l2N3djqStQvYaZrwcImU";
const AYHAM_PHONE = "+12152010106";

const PIPELINES = {
  crm: { id: "vH8yI1Tdsj63OK3wqSuj", paidStage: "0fea7267-f1f5-4ff3-913a-2d8792fa4342" },
  website: { id: "QMpi6FmZQh0Ga8SMithB", paidStage: "a02532e9-0073-45e6-803f-15b9c544ceca" },
};

async function ghl(method, path, body) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${GHL_TOKEN}`,
      "Version": "2021-07-28",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${GHL_API}${path}`, opts);
  return res.json().catch(() => ({}));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Stripe-Signature");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const event = req.body;

    // Handle Stripe checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const name = session.customer_details?.name || "Unknown";
      const amount = (session.amount_total || 0) / 100;

      if (!email) {
        return res.status(200).json({ skipped: true, reason: "No email in session" });
      }

      // Find the contact in GHL
      const search = await ghl("GET", `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(email)}&limit=1`);
      const contact = search?.contacts?.[0];

      if (contact) {
        // Find their open opportunities and move to Paid
        for (const pipKey of ["crm", "website"]) {
          const pip = PIPELINES[pipKey];
          const opps = await ghl("GET", `/opportunities/search?location_id=${LOCATION_ID}&pipeline_id=${pip.id}&contact_id=${contact.id}`);

          if (opps?.opportunities?.length > 0) {
            for (const opp of opps.opportunities) {
              if (opp.status === "open") {
                await ghl("PUT", `/opportunities/${opp.id}`, {
                  pipelineStageId: pip.paidStage,
                  monetaryValue: amount || opp.monetaryValue,
                });
                console.log(`[stripe] Moved opp ${opp.id} to Paid in ${pipKey}`);
              }
            }
          }
        }

        // Notify Ayham
        const notifySearch = await ghl("GET", `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent("Ayham@safarstrategies.com")}&limit=1`);
        const ayhamContact = notifySearch?.contacts?.[0];
        if (ayhamContact) {
          await ghl("POST", "/conversations/messages", {
            type: "SMS",
            contactId: ayhamContact.id,
            message: `\u2705 PAYMENT CONFIRMED!\n${name} (${email})\nAmount: $${amount}\nStripe session: ${session.id}`,
          });
        }
      }

      return res.status(200).json({ success: true, email, amount });
    }

    // Acknowledge other event types
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("[stripe-webhook] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
