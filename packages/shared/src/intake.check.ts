import assert from "node:assert/strict";
import { canonicalIntake, emptyIntake, validateIntake, type Intake } from "./intake.js";

function filled(): Intake {
  const i = emptyIntake("wy-llc");
  i.founder = { ...i.founder, first_name: "Ada", last_name: "Okafor", email: "ada@example.com", phone: "+234 803 123 4567", country: "Nigeria", address: { line1: "12 Marina", line2: "", city: "Lagos", region: "Lagos", postal: "101241", country: "Nigeria" } };
  i.company = { ...i.company, names: ["Acme Studio LLC", "Acme Labs LLC", ""], description: "Design services for startups" };
  i.llc.members = [{ name: "Ada Okafor", ownership_pct: 100 }];
  i.ein.line_of_business = "Brand and product design";
  return i;
}

assert.deepEqual(validateIntake(filled()), [], "a complete WY LLC intake passes");
const empty = validateIntake(emptyIntake());
assert.ok(empty.some((e) => e.field === "founder.email"));
assert.ok(empty.some((e) => e.field === "llc.members"));

const badName = filled();
badName.company.names[0] = "Acme Studio";
assert.ok(validateIntake(badName).some((e) => e.message.includes("must end with LLC")));

const split = filled();
split.llc.members = [{ name: "Ada", ownership_pct: 60 }, { name: "Bo", ownership_pct: 30 }];
assert.ok(validateIntake(split).some((e) => e.message.includes("add up to 100%")));

const corp = filled();
corp.company.jurisdiction = "de-ccorp";
corp.company.names = ["Acme Inc.", "", ""];
assert.ok(validateIntake(corp, "owners").some((e) => e.field === "corp.president"));
corp.corp = { ...corp.corp, president: "Ada", secretary: "Ada", treasurer: "Ada", directors: ["Ada"], shareholders: [{ name: "Ada", ownership_pct: 100 }] };
assert.deepEqual(validateIntake(corp), [], "a complete DE C-Corp intake passes");

const ssn = filled();
ssn.founder.tax_id_type = "itin";
ssn.founder.tax_id = "123";
assert.ok(validateIntake(ssn).some((e) => e.field === "founder.tax_id"));

const reordered = JSON.parse(JSON.stringify(filled()), (_k, v) => v);
assert.equal(canonicalIntake(filled()), canonicalIntake({ ...reordered, ein: reordered.ein, founder: reordered.founder }), "canonical form ignores key order");
console.log("intake checks ok");
