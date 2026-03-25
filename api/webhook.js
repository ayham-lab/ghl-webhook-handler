// GHL Webhook Handler — AcquiredCRM Automations
// Receives webhooks from Lovable website & routes to GHL API

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_TOKEN = process.env.GHL_API_TOKEN;
const LOCATION_ID = "l2N3djqStQvYaZrwcImU";
const AYHAM_USER_ID = "yuw45CXELxVrEqHMGj9S";

// Also forward to existing GHL webhook (keeps Lead Ingestion workflow working)
const GHL_WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/l2N3djqStQvYaZrwcImU/webhook-trigger/768b08c3-ac69-46a7-b0cb-7ee0c29f8756";

// Pipeline & Stage IDs
const PIPELINES = {
  crm: {
    id: "vH8yI1Tdsj63OK3wqSuj",
    stages: {
      newLead:      "fdcd728b-63dd-4661-8887-9dbb7fb03123",
      meetingBooked: "c0711737-e98e-42ec-9b8b-b26fad2497b3",
      proposalSent: "b258e1b4-ca3b-49d5-96e5-e82b0b337618",
      paid:         "0fea7267-f1f5-4ff3-913a-2d8792fa4342",
      inProgress:   "56ba1916-07d0-4193-9eed-a5ba374bd42b",
      delivered:    "791cad18-cd83-47b7-a697-276e2e43b1bc",
    }
  },
  website: {
    id: "QMpi6FmZQh0Ga8SMithB",
    stages: {
      newLead:      "03db8d37-7653-441c-8091-78771fac58ab",
      meetingBooked: "1264dfc6-6502-451c-9e7a-743288bff788",
      proposalSent: "d1418170-9418-4d12-b9a4-918e31a9b394",
      paid:         "a02532e9-0073-45e6-803f-15b9c544ceca",
      inProgress:   "67327f31-d56b-4d21-bc7e-d2802cd1e003",
      delivered:    "85cb95c4-971b-4826-abb0-6d0315db0f0b",
    }
  }
};

// ─── Helpers ───────────────────────────────────────────────

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
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Find or create contact
async function upsertContact({ name, email, phone, company }) {
  // Search by email first
  if (email) {
    const search = await ghl("GET", `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(email)}&limit=1`);
    if (search.data?.contacts?.length > 0) {
      const existing = search.data.contacts[0];
      // Update if needed
      await ghl("PUT", `/contacts/${existing.id}`, {
        name: name || existing.name,
        phone: phone || existing.phone,
        companyName: company || existing.companyName,
      });
      return existing.id;
    }
  }

  // Create new contact
  const [firstName, ...lastParts] = (name || "Unknown").split(" ");
  const lastName = lastParts.join(" ") || "";

  const create = await ghl("POST", "/contacts/", {
    locationId: LOCATION_ID,
    firstName,
    lastName,
    email,
    phone,
    companyName: company,
    source: "AcquiredCRM Website",
  });

  return create.data?.contact?.id;
}

// Create opportunity in the right pipeline
async function createOpportunity(contactId, { plan, value, pipeline, stage, name }) {
  const pip = PIPELINES[pipeline] || PIPELINES.crm;
  const stageId = pip.stages[stage] || pip.stages.newLead;

  const opp = await ghl("POST", "/opportunities/", {
    pipelineId: pip.id,
    locationId: LOCATION_ID,
    name: name || `${plan || "New"} - Website Lead`,
    pipelineStageId: stageId,
    contactId,
    status: "open",
    monetaryValue: parseFloat(value) || 0,
    assignedTo: AYHAM_USER_ID,
  });

  return opp.data;
}

// Send internal SMS notification to Ayham
// Uses Ayham's GHL contact ID (the one with his phone +12152010106)
const AYHAM_CONTACT_ID = process.env.AYHAM_CONTACT_ID || "JqyBpK2VaQd0TgDG2gQ9";

async function notifyAyham(message) {
  const result = await ghl("POST", `/conversations/messages`, {
    type: "SMS",
    contactId: AYHAM_CONTACT_ID,
    message,
  });

  if (result.status !== 201) {
    console.error("SMS notification failed:", JSON.stringify(result.data));
  }
}

// Determine which pipeline based on plan/package name
function detectPipeline(plan) {
  if (!plan) return "crm";
  const lower = plan.toLowerCase();
  if (lower.includes("website") || lower.includes("launch") || lower.includes("brand") ||
      lower.includes("seo") || lower.includes("black label") || lower.includes("care plan") ||
      lower.includes("growth plan") || lower.includes("maintenance") || lower.includes("concierge")) {
    return "website";
  }
  return "crm";
}

// ─── Main Handler ──────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const body = req.body;
    const { type, name, email, phone, company, plan, value, package: pkg } = body;

    console.log(`[webhook] type=${type} name=${name} email=${email} plan=${plan || pkg}`);

    // 0. Forward to existing GHL webhook (keeps Lead Ingestion workflow working)
    fetch(GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(err => console.error("[webhook] GHL forward failed:", err.message));

    // 1. Create/update contact
    const contactId = await upsertContact({ name, email, phone, company });
    if (!contactId) {
      return res.status(500).json({ error: "Failed to create contact" });
    }

    // 2. Route by type
    let pipeline, stage, smsMessage, oppName;

    switch (type) {
      case "checkout":
        // Someone is checking out — they're about to pay
        pipeline = detectPipeline(plan);
        stage = "paid";
        oppName = `${plan || "CRM"} Checkout - ${name}`;
        smsMessage = `\u{1F4B0} NEW CHECKOUT!\n${name} (${email})\nPlan: ${plan || "Unknown"}\nValue: $${value || "N/A"}\nPhone: ${phone || "N/A"}`;
        break;

      case "sales_inquiry":
        // Someone wants to talk to sales
        pipeline = detectPipeline(plan || pkg);
        stage = "meetingBooked";
        oppName = `Sales Call - ${name}`;
        smsMessage = `\u{1F4DE} NEW SALES INQUIRY!\n${name} (${email})\nPlan: ${plan || pkg || "General"}\nPhone: ${phone || "N/A"}\nCompany: ${company || "N/A"}`;
        break;

      case "book_call":
        // Someone booked a call
        pipeline = detectPipeline(plan || pkg);
        stage = "meetingBooked";
        oppName = `Booked Call - ${name}`;
        smsMessage = `\u{1F4C5} NEW CALL BOOKED!\n${name} (${email})\nPhone: ${phone || "N/A"}\nCompany: ${company || "N/A"}`;
        break;

      case "website_inquiry":
        // Website package inquiry
        pipeline = "website";
        stage = "newLead";
        oppName = `Website Inquiry - ${name} - ${pkg || plan || "General"}`;
        smsMessage = `\u{1F310} NEW WEBSITE INQUIRY!\n${name} (${email})\nPackage: ${pkg || plan || "General"}\nPhone: ${phone || "N/A"}`;
        break;

      default:
        // Generic lead
        pipeline = "crm";
        stage = "newLead";
        oppName = `New Lead - ${name}`;
        smsMessage = `\u{1F514} NEW LEAD!\n${name} (${email})\nType: ${type || "unknown"}\nPhone: ${phone || "N/A"}`;
    }

    // 3. Create opportunity
    await createOpportunity(contactId, {
      plan: plan || pkg,
      value,
      pipeline,
      stage,
      name: oppName,
    });

    // 4. Notify Ayham via SMS
    await notifyAyham(smsMessage);

    console.log(`[webhook] \u2705 Processed: ${type} for ${name} \u2192 ${pipeline}/${stage}`);
    return res.status(200).json({ success: true, contactId, pipeline, stage });

  } catch (err) {
    console.error("[webhook] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
