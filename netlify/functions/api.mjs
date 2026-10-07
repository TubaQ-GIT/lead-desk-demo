// Mock lending API for test-automation demos (Netlify Function, v2 syntax).
// Routes under /api/*. Data persists in Netlify Blobs; falls back to memory if unavailable.

const PINS = {
  "400001": ["Maharashtra", "Marathi", 1], "411001": ["Maharashtra", "Marathi", 1],
  "600001": ["Tamil Nadu", "Tamil", 1], "560001": ["Karnataka", "Kannada", 1],
  "500001": ["Telangana", "Telugu", 1], "520001": ["Andhra Pradesh", "Telugu", 0],
  "302001": ["Rajasthan", "Hindi", 1], "110001": ["Delhi", "Hindi", 1],
  "380001": ["Gujarat", "Gujarati", 0],
};
const BLOCKED = ["682001", "700001"];
const LIMITS = {
  gold: { branch: [3000, 1e7], door: [50000, 1e7] },
  home: { buy: [3e5, 5e7], build: [3e5, 5e7], bt: [3e5, 5e7] },
  lap: { aff: [2e5, 2499999], reg: [2.5e6, 3e7] },
  biz: { uns: [1e5, 5e6] },
};
const DOC_TYPES = ["id", "addr", "inc", "prop", "pan", "bank"];
const H = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const out = (s, j) => new Response(JSON.stringify(j), { status: s, headers: H });

let mem = [];
async function db() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const st = getStore("leads");
    return {
      read: async () => (await st.get("all", { type: "json" })) || [],
      write: async (v) => { await st.setJSON("all", v); },
    };
  } catch {
    return { read: async () => mem, write: async (v) => { mem = v; } };
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  const path = new URL(req.url).pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
  let body = {};
  if (req.method === "POST") {
    try { body = await req.json(); }
    catch { return out(400, { error: "BAD_JSON", message: "The request body must be valid JSON." }); }
  }
  const store = await db();

  if (path === "/health") return out(200, { status: "ok" });

  if (path === "/pincode/lookup" && req.method === "POST") {
    const pin = String(body.pincode || "");
    if (!/^\d{6}$/.test(pin)) return out(400, { error: "INVALID_PINCODE", message: "PIN code must be 6 digits." });
    if (BLOCKED.includes(pin)) return out(404, { error: "NOT_SERVICEABLE", message: "We do not serve this PIN code yet." });
    const x = PINS[pin];
    if (!x) return out(404, { error: "PIN_NOT_FOUND", message: "PIN code not found." });
    return out(200, { pincode: pin, state: x[0], language: x[1], doorstepEligible: !!x[2] });
  }

  if (path === "/leads" && req.method === "POST") {
    const { name = "", mobile = "", email = "", pincode = "", product, sub, amount, goldGrams } = body;
    const bad = [];
    if (!/^[A-Za-z][A-Za-z .'-]{1,59}$/.test(name)) bad.push("name");
    if (!/^[6-9]\d{9}$/.test(mobile)) bad.push("mobile");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) bad.push("email");
    if (BLOCKED.includes(pincode)) return out(422, { error: "NOT_SERVICEABLE", message: "We do not serve this PIN code yet." });
    const pin = PINS[pincode];
    if (!pin) bad.push("pincode");
    const lim = LIMITS[product] && LIMITS[product][sub];
    if (!lim) bad.push("product/sub");
    else if (!(amount >= lim[0] && amount <= lim[1])) bad.push("amount");
    if (product === "gold" && !(goldGrams > 0)) bad.push("goldGrams");
    if (bad.length) return out(422, { error: "VALIDATION_FAILED", fields: bad, message: "Check these fields: " + bad.join(", ") + "." });
    if (sub === "door" && !pin[2]) return out(422, { error: "DOORSTEP_NOT_AVAILABLE", message: "Doorstep service is not available for this PIN code." });
    const leads = await store.read();
    if (leads.some((l) => l.mobile === mobile && l.product === product))
      return out(409, { error: "DUPLICATE_LEAD", message: "A lead with this mobile number already exists for this product." });
    const n = leads.reduce((m, l) => Math.max(m, Number(l.id.slice(3))), 1000) + 1;
    const lead = {
      id: "LD-" + n, name, mobile, email, pincode, product, sub, amount, goldGrams,
      state: pin[0], language: pin[1], call: "Queued (" + pin[1] + ")", docCount: 0, docs: [],
      createdAt: new Date().toISOString(),
    };
    leads.unshift(lead);
    await store.write(leads);
    return out(201, { leadId: lead.id, status: "CREATED", state: lead.state, language: lead.language, aiCall: { status: "QUEUED", language: lead.language } });
  }

  if (path === "/leads" && req.method === "GET") {
    const leads = await store.read();
    return out(200, { count: leads.length, leads });
  }

  const m = path.match(/^\/leads\/(LD-\d+)(\/documents)?$/);
  if (m) {
    const leads = await store.read();
    const lead = leads.find((l) => l.id === m[1]);
    if (!lead) return out(404, { error: "LEAD_NOT_FOUND", message: "No lead with this ID." });
    if (!m[2] && req.method === "GET") return out(200, lead);
    if (m[2] && req.method === "POST") {
      const { type, fileName = "", size } = body;
      const ext = fileName.split(".").pop().toLowerCase();
      if (!DOC_TYPES.includes(type)) return out(422, { error: "INVALID_DOCUMENT_TYPE", message: "Unknown document type." });
      if (!["pdf", "jpg", "jpeg", "png"].includes(ext)) return out(422, { error: "UNSUPPORTED_FILE_TYPE", message: "Upload a PDF, JPG or PNG." });
      if (!(size > 0)) return out(422, { error: "EMPTY_FILE", message: "The file is empty." });
      if (size > 2 * 1024 * 1024) return out(422, { error: "FILE_TOO_LARGE", message: "The file is larger than 2 MB." });
      lead.docs.push({ type, fileName, size });
      lead.docCount = lead.docs.length;
      await store.write(leads);
      return out(201, { leadId: lead.id, document: type, fileName, status: "ACCEPTED" });
    }
  }

  if (path === "/reset" && req.method === "POST") { await store.write([]); return out(200, { status: "RESET" }); }
  return out(404, { error: "NOT_FOUND", message: "Unknown endpoint." });
};

export const config = { path: "/api/*" };
