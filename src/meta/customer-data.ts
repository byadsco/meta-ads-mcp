import { createHash } from "node:crypto";

/**
 * Customer-list data for POST|DELETE /{audience_id}/users, normalized and
 * hashed the way Meta's customer-file guide and its SDK's normalizer do it.
 * Nothing here logs, and nothing it returns carries a raw value: a field that
 * cannot be normalized is reported by row and field name only.
 */
export interface CustomerRow {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  first_initial?: string;
  gender?: string;
  birth_year?: string;
  birth_month?: string;
  birth_day?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  external_id?: string;
  mobile_advertiser_id?: string;
}

type Field = keyof CustomerRow;
export type CustomerKey =
  | "EMAIL" | "PHONE" | "FN" | "LN" | "FI" | "GEN" | "DOBY" | "DOBM" | "DOBD"
  | "CT" | "ST" | "ZIP" | "COUNTRY" | "EXTERN_ID" | "MADID";

export interface RejectedRow {
  /** 1-based, as the caller counts the rows it sent. */
  row: number;
  field: Field | "row";
  reason: string;
}

/**
 * A normalizer returns the normalized text, or a reason it cannot be one.
 * `us` says the row's country is the United States, whose ZIP codes and
 * states Meta takes in a form of their own.
 */
type Normalizer = (value: string, context: { us: boolean }) => { ok: string } | { reason: string };

const SHA256 = /^[a-f0-9]{64}$/;
// Marks stay with their letters: without them a name in Devanagari or Thai
// becomes another name.
const lettersOnly = (value: string) => value.normalize("NFC").replace(/[^\p{L}\p{M}]/gu, "");
const firstGrapheme = (value: string) => [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)][0]?.segment ?? "";
const asciiLettersOnly = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const twoDigits = (value: string, max: number, what: string): { ok: string } | { reason: string } => {
  const n = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  return n >= 1 && n <= max ? { ok: String(n).padStart(2, "0") } : { reason: `${what} must be a number from 1 to ${max}` };
};

const NORMALIZERS: Record<Field, { key: CustomerKey; hash: boolean; normalize: Normalizer }> = {
  email: {
    key: "EMAIL", hash: true,
    normalize: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { ok: v } : { reason: "is not an email address" }),
  },
  phone: {
    key: "PHONE", hash: true,
    // An international number: + or 00 and the country code. A single
    // leading 0 is a national trunk prefix, without the country code, so
    // the hash would match nobody.
    normalize: (v) => {
      let digits = v.replace(/[\s\-().]/g, "");
      if (digits.startsWith("+")) digits = digits.slice(1);
      else if (digits.startsWith("00")) digits = digits.slice(2);
      else if (digits.startsWith("0")) return { reason: "needs its country code (+57…), not a leading 0" };
      return /^[1-9]\d{7,14}$/.test(digits) ? { ok: digits } : { reason: "must be an international number: country code and 8 to 15 digits" };
    },
  },
  first_name: { key: "FN", hash: true, normalize: (v) => (lettersOnly(v) ? { ok: lettersOnly(v) } : { reason: "has no letters" }) },
  last_name: { key: "LN", hash: true, normalize: (v) => (lettersOnly(v) ? { ok: lettersOnly(v) } : { reason: "has no letters" }) },
  first_initial: { key: "FI", hash: true, normalize: (v) => (lettersOnly(v) ? { ok: firstGrapheme(lettersOnly(v)) } : { reason: "has no letters" }) },
  gender: {
    key: "GEN", hash: true,
    normalize: (v) => (["m", "male"].includes(v) ? { ok: "m" } : ["f", "female"].includes(v) ? { ok: "f" } : { reason: "must be m or f" }),
  },
  birth_year: {
    key: "DOBY", hash: true,
    normalize: (v) => (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= new Date().getUTCFullYear()
      ? { ok: v }
      : { reason: "must be a four-digit year from 1900" }),
  },
  birth_month: { key: "DOBM", hash: true, normalize: (v) => twoDigits(v, 12, "the month") },
  birth_day: { key: "DOBD", hash: true, normalize: (v) => twoDigits(v, 31, "the day") },
  city: { key: "CT", hash: true, normalize: (v) => (asciiLettersOnly(v) ? { ok: asciiLettersOnly(v) } : { reason: "has no letters" }) },
  state: {
    key: "ST", hash: true,
    normalize: (v, { us }) => {
      const state = asciiLettersOnly(v);
      if (!state) return { reason: "has no letters" };
      if (!us) return { ok: state };
      const code = US_STATE_CODES.has(state) ? state : Object.hasOwn(US_STATES, state) ? US_STATES[state] : undefined;
      return code ? { ok: code } : { reason: "must be a US state or its two-letter code" };
    },
  },
  zip: {
    key: "ZIP", hash: true,
    normalize: (v, { us }) => {
      const zip = v.replace(/\s/g, "").split("-")[0];
      if (!zip) return { reason: "is empty" };
      if (!us) return { ok: zip };
      return /^\d{5}(\d{4})?$/.test(zip) ? { ok: zip.slice(0, 5) } : { reason: "must be a five-digit US ZIP code" };
    },
  },
  country: {
    key: "COUNTRY", hash: true,
    normalize: (v) => (ISO_COUNTRIES.has(v.replace(/\s/g, ""))
      ? { ok: v.replace(/\s/g, "") }
      : { reason: "must be a two-letter ISO 3166 country code (GB for the United Kingdom)" }),
  },
  // Meta asks for these two unhashed.
  external_id: { key: "EXTERN_ID", hash: false, normalize: (v) => (v.length <= 256 ? { ok: v } : { reason: "is longer than 256 characters" }) },
  mobile_advertiser_id: {
    key: "MADID", hash: false,
    // IDFA and AAID are both UUIDs.
    normalize: (v) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
      ? { ok: v }
      : { reason: "must be a device advertising id (IDFA or AAID, a UUID)" }),
  },
};

const ORDER: Field[] = [
  "email", "phone", "first_name", "last_name", "first_initial", "gender", "birth_year", "birth_month", "birth_day",
  "city", "state", "zip", "country", "external_id", "mobile_advertiser_id",
];

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const US_HASH = sha256("us");

function cell(field: Field, raw: string, context: { us: boolean }): { ok: string } | { reason: string } {
  const rule = NORMALIZERS[field];
  // The external id keeps its case: Meta matches it as sent.
  const value = field === "external_id" ? raw.trim() : raw.trim().toLowerCase();
  if (rule.hash && SHA256.test(value)) return { ok: value };
  const normalized = rule.normalize(value, context);
  if ("reason" in normalized) return normalized;
  return { ok: rule.hash ? sha256(normalized.ok) : normalized.ok };
}

export function buildCustomerPayload(rows: CustomerRow[]): { schema: CustomerKey[]; data: string[][]; rejected: RejectedRow[] } {
  const accepted: Array<Partial<Record<Field, string>>> = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((row, i) => {
    const out: Partial<Record<Field, string>> = {};
    const country = typeof row.country === "string" && row.country.trim() !== "" ? cell("country", row.country, { us: false }) : undefined;
    const context = { us: country !== undefined && "ok" in country && country.ok === US_HASH };
    for (const field of ORDER) {
      const raw = row[field];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const result = cell(field, raw, context);
      if ("reason" in result) {
        rejected.push({ row: i + 1, field, reason: `${field} ${result.reason}` });
        return;
      }
      out[field] = result.ok;
    }
    if (Object.keys(out).length === 0) {
      rejected.push({ row: i + 1, field: "row", reason: "has no values" });
      return;
    }
    accepted.push(out);
  });
  const present = ORDER.filter((field) => accepted.some((row) => row[field] !== undefined));
  return {
    schema: present.map((field) => NORMALIZERS[field].key),
    data: accepted.map((row) => present.map((field) => row[field] ?? "")),
    rejected,
  };
}

// ISO 3166-1 alpha-2, the codes Meta's COUNTRY key takes.
const ISO_COUNTRIES = new Set((
  "ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz " +
  "ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr " +
  "ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp " +
  "ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt " +
  "mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw " +
  "sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz " +
  "ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw"
).split(" "));

// The 50 states, the District of Columbia and the inhabited territories, by
// their names as asciiLettersOnly leaves them.
const US_STATES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct",
  delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi",
  minnesota: "mn", mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", newhampshire: "nh",
  newjersey: "nj", newmexico: "nm", newyork: "ny", northcarolina: "nc", northdakota: "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", rhodeisland: "ri", southcarolina: "sc", southdakota: "sd", tennessee: "tn",
  texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa", westvirginia: "wv", wisconsin: "wi",
  wyoming: "wy", districtofcolumbia: "dc", washingtondc: "dc", puertorico: "pr", guam: "gu", americansamoa: "as",
  northernmarianaislands: "mp", virginislands: "vi", usvirginislands: "vi", unitedstatesvirginislands: "vi",
};
const US_STATE_CODES = new Set(Object.values(US_STATES));
