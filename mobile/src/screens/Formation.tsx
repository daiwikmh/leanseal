import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  einReasons,
  emptyIntake,
  industries,
  intakeHash,
  jurisdictions,
  principalActivities,
  signWithNearKey,
  signedRequest,
  validateIntake,
  type Advice,
  type Company,
  type Intake,
  type IntakeStep,
  type Member,
} from "shared";
import { SelectPill } from "../components/ui";
import { api } from "../lib/api";
import type { PasskeySession } from "../lib/passkey";
import { family, space } from "../theme";

const plans = [
  { key: "services", label: "Client work" },
  { key: "saas", label: "Subscriptions" },
  { key: "venture", label: "Raising money" },
];

const order: IntakeStep[] = ["founder", "company", "owners", "ein"];
const titles: Record<IntakeStep, string> = { founder: "About you", company: "Company", owners: "Owners", ein: "Tax ID (EIN)" };

type FormationProps = { session: PasskeySession; company: Company; onDone: (company: Company, advice: Advice | null) => void; onCancel: () => void };

function setPath<T>(target: T, path: string, value: unknown): T {
  const copy = structuredClone(target) as Record<string, unknown>;
  const keys = path.split(".");
  let node = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
  return copy as T;
}

export function Formation({ session, company, onDone, onCancel }: FormationProps) {
  const insets = useSafeAreaInsets();
  const [intake, setIntake] = useState<Intake>(() => {
    const blank = emptyIntake();
    blank.founder.country = company.country;
    blank.company.names[0] = `${company.legal_name} LLC`;
    return blank;
  });
  const [plan, setPlan] = useState("services");
  const [step, setStep] = useState(0);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (path: string, value: unknown) => setIntake((current) => setPath(current, path, value));
  const founderName = `${intake.founder.first_name} ${intake.founder.last_name}`.trim();
  const llc = intake.company.jurisdiction === "wy-llc";
  const ownersKey = llc ? "llc.members" : "corp.shareholders";
  const owners: Member[] = llc ? intake.llc.members : intake.corp.shareholders;

  function report(message: string, error = false) {
    setStatus(message);
    setFailed(error);
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  }

  function go(next: number) {
    if (next > step) {
      const error = validateIntake(intake, order[step])[0]?.message ?? null;
      if (error) return report(error, true);
    }
    if (order[next] === "owners") {
      setIntake((current) => {
        let updated = current;
        for (const key of ["llc.members", "corp.shareholders"]) {
          const list = key === "llc.members" ? current.llc.members : current.corp.shareholders;
          if (list.length === 0) updated = setPath(updated, key, [{ name: founderName, ownership_pct: 100 }]);
        }
        for (const role of ["president", "secretary", "treasurer"] as const) {
          if (!updated.corp[role]) updated = setPath(updated, `corp.${role}`, founderName);
        }
        if (updated.corp.directors.length === 0) updated = setPath(updated, "corp.directors", [founderName]);
        return updated;
      });
    }
    report("");
    setStep(next);
  }

  const ask = () =>
    run(async () => {
      if (!intake.founder.country.trim()) return report("Fill in your country on the first step.", true);
      report("Asking the advisor…");
      const next = await api.advise({ country: intake.founder.country.trim(), plan, company: intake.company.names[0] });
      setAdvice(next);
      set("company.jurisdiction", next.jurisdiction);
      report("");
    });

  const start = () =>
    run(async () => {
      const errors = validateIntake(intake);
      if (errors.length > 0) {
        setStep(order.indexOf(errors[0].step));
        return report(errors[0].message, true);
      }
      report("Signing and sending your encrypted application…");
      const result = await api.submitApplication({ ...signedRequest(session.accountId, session.key, intakeHash(intake), signWithNearKey), intake });
      onDone(result.company, advice);
    });

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={{ height: insets.top }} />
      <ScrollView style={styles.card} contentContainerStyle={[styles.cardContent, { paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <View style={styles.top}>
          <Text style={styles.chip}>Optional</Text>
          <Pressable onPress={onCancel} hitSlop={space.sm}>
            <Text style={styles.switch}>Close</Text>
          </Pressable>
        </View>
        {(
          <>
            <Text style={styles.title}>Form a US company</Text>
            <Text style={styles.hint}>The same details doola and Stripe Atlas ask for. Encrypted; only a hash goes on NEAR.</Text>
            <View style={styles.steps}>
              {order.map((key, i) => (
                <View key={key} style={[styles.stepTab, i < step && styles.stepDone, i === step && styles.stepNow]}>
                  <Text style={[styles.stepLabel, i <= step && styles.stepLabelOn]}>0{i + 1} {titles[key]}</Text>
                </View>
              ))}
            </View>

            {order[step] === "founder" && (
              <View style={styles.fields}>
                <Field label="Legal first name (as on ID)" value={intake.founder.first_name} onChange={(v) => set("founder.first_name", v)} />
                <Field label="Legal last name" value={intake.founder.last_name} onChange={(v) => set("founder.last_name", v)} />
                <Field label="Email · the IRS signature link goes here" value={intake.founder.email} onChange={(v) => set("founder.email", v)} keyboard="email-address" />
                <Field label="Phone, international format" value={intake.founder.phone} onChange={(v) => set("founder.phone", v)} placeholder="+91 98765 43210" keyboard="phone-pad" />
                <Field label="Country you live in" value={intake.founder.country} onChange={(v) => set("founder.country", v)} placeholder="Nigeria" />
                <Field label="Nationality (optional)" value={intake.founder.nationality} onChange={(v) => set("founder.nationality", v)} />
                <Field label="Date of birth, YYYY-MM-DD (optional)" value={intake.founder.date_of_birth} onChange={(v) => set("founder.date_of_birth", v)} />
                <Pills label="US tax ID" value={intake.founder.tax_id_type} options={[["none", "None"], ["ssn", "SSN"], ["itin", "ITIN"]]} onChange={(v) => set("founder.tax_id_type", v)} />
                {intake.founder.tax_id_type !== "none" && <Field label="SSN or ITIN" value={intake.founder.tax_id} onChange={(v) => set("founder.tax_id", v)} keyboard="number-pad" />}
                <Text style={styles.sub}>HOME ADDRESS</Text>
                <Field label="Street address" value={intake.founder.address.line1} onChange={(v) => set("founder.address.line1", v)} />
                <Field label="Apartment, suite (optional)" value={intake.founder.address.line2} onChange={(v) => set("founder.address.line2", v)} />
                <Field label="City" value={intake.founder.address.city} onChange={(v) => set("founder.address.city", v)} />
                <Field label="State / region" value={intake.founder.address.region} onChange={(v) => set("founder.address.region", v)} />
                <Field label="Postal code" value={intake.founder.address.postal} onChange={(v) => set("founder.address.postal", v)} />
                <Field label="Country" value={intake.founder.address.country} onChange={(v) => set("founder.address.country", v)} />
              </View>
            )}

            {order[step] === "company" && (
              <View style={styles.fields}>
                <Pills label="What will the company do?" value={plan} options={plans.map((p) => [p.key, p.label])} onChange={(v) => (setPlan(v), setAdvice(null))} />
                <Pressable disabled={busy} onPress={ask} style={({ pressed }) => [styles.secondary, (pressed || busy) && styles.pressed]}>
                  <Text style={styles.secondaryLabel}>Ask the advisor</Text>
                </Pressable>
                {advice && (
                  <View style={styles.advice}>
                    <Text style={styles.adviceLabel}>OPENCASH ADVISOR · NEAR AI</Text>
                    <Text style={styles.advicePick}>{jurisdictions[advice.jurisdiction].label}</Text>
                    <Text style={styles.adviceWhy}>{advice.reason}</Text>
                  </View>
                )}
                <Pills label="Entity type" value={intake.company.jurisdiction} options={[["wy-llc", "Wyoming LLC"], ["de-ccorp", "Delaware C-Corp"]]} onChange={(v) => set("company.jurisdiction", v)} />
                {[0, 1, 2].map((i) => (
                  <Field
                    key={i}
                    label={["Company name, 1st choice", "2nd choice (if taken)", "3rd choice (optional)"][i]}
                    value={intake.company.names[i]}
                    onChange={(v) => set("company.names", intake.company.names.map((n, j) => (j === i ? v : n)))}
                    placeholder={`Acme ${["Studio", "Labs", "Works"][i]} ${llc ? "LLC" : "Inc."}`}
                  />
                ))}
                <Pills label="Industry" value={intake.company.industry} options={industries.map((x) => [x, x])} onChange={(v) => set("company.industry", v)} />
                <Field label="What it does, ≤ 50 characters" value={intake.company.description} onChange={(v) => set("company.description", v.slice(0, 50))} />
                <Field label="Website (optional)" value={intake.company.website} onChange={(v) => set("company.website", v)} placeholder="https://acme.studio" />
                <Toggle label="Use the registered agent's address (no US address needed)" value={intake.company.use_agent_address} onChange={(v) => set("company.use_agent_address", v)} />
                {!intake.company.use_agent_address && (
                  <>
                    <Field label="Business street address" value={intake.company.business_address.line1} onChange={(v) => set("company.business_address.line1", v)} />
                    <Field label="City" value={intake.company.business_address.city} onChange={(v) => set("company.business_address.city", v)} />
                    <Field label="State" value={intake.company.business_address.region} onChange={(v) => set("company.business_address.region", v)} />
                    <Field label="ZIP code" value={intake.company.business_address.postal} onChange={(v) => set("company.business_address.postal", v)} />
                    <Field label="Country" value={intake.company.business_address.country} onChange={(v) => set("company.business_address.country", v)} />
                  </>
                )}
              </View>
            )}

            {order[step] === "owners" && (
              <View style={styles.fields}>
                {llc ? (
                  <Pills label="Who runs the LLC?" value={intake.llc.management} options={[["member", "The members"], ["manager", "Managers"]]} onChange={(v) => set("llc.management", v)} />
                ) : (
                  <>
                    <Field label="President" value={intake.corp.president} onChange={(v) => set("corp.president", v)} />
                    <Field label="Secretary" value={intake.corp.secretary} onChange={(v) => set("corp.secretary", v)} />
                    <Field label="Treasurer" value={intake.corp.treasurer} onChange={(v) => set("corp.treasurer", v)} />
                    <Field label="Directors, comma separated" value={intake.corp.directors.join(", ")} onChange={(v) => set("corp.directors", v.split(",").map((d) => d.trim()).filter(Boolean))} />
                    <Field label="Authorized shares" value={String(intake.corp.authorized_shares)} onChange={(v) => set("corp.authorized_shares", Number(v.replace(/\D/g, "")))} keyboard="number-pad" />
                    <Field label="Par value per share (USD)" value={intake.corp.par_value} onChange={(v) => set("corp.par_value", v)} keyboard="decimal-pad" />
                  </>
                )}
                <Text style={styles.sub}>{llc ? "MEMBERS" : "SHAREHOLDERS"} · MUST ADD UP TO 100%</Text>
                {owners.map((owner, i) => (
                  <View key={i} style={styles.ownerRow}>
                    <View style={styles.flex}>
                      <Field label="Full legal name" value={owner.name} onChange={(v) => set(ownersKey, owners.map((o, j) => (j === i ? { ...o, name: v } : o)))} />
                    </View>
                    <View style={styles.pct}>
                      <Field label="%" value={owner.ownership_pct ? String(owner.ownership_pct) : ""} onChange={(v) => set(ownersKey, owners.map((o, j) => (j === i ? { ...o, ownership_pct: Number(v) || 0 } : o)))} keyboard="decimal-pad" />
                    </View>
                  </View>
                ))}
                <Pressable onPress={() => set(ownersKey, [...owners, { name: "", ownership_pct: 0 }])}>
                  <Text style={styles.switch}>+ Add {llc ? "a member" : "a shareholder"}</Text>
                </Pressable>
              </View>
            )}

            {order[step] === "ein" && (
              <View style={styles.fields}>
                <Toggle label="Apply for an EIN. Without an SSN the IRS form SS-4 is signed by you and faxed; it takes days to weeks." value={intake.ein.order} onChange={(v) => set("ein.order", v)} />
                <Pills label="Reason for applying" value={intake.ein.reason} options={einReasons.map((x) => [x, x])} onChange={(v) => set("ein.reason", v)} />
                <Pills label="Principal activity" value={intake.ein.principal_activity} options={principalActivities.map((x) => [x, x])} onChange={(v) => set("ein.principal_activity", v)} />
                <Field label="What you sell or the service you provide" value={intake.ein.line_of_business} onChange={(v) => set("ein.line_of_business", v)} />
                <Toggle label="I expect to pay US employees (W-2) in the next 12 months" value={intake.ein.expects_employees} onChange={(v) => set("ein.expects_employees", v)} />
                {intake.ein.expects_employees && (
                  <>
                    <Field label="How many employees" value={intake.ein.employee_count ? String(intake.ein.employee_count) : ""} onChange={(v) => set("ein.employee_count", Number(v) || 0)} keyboard="number-pad" />
                    <Field label="First wage date, YYYY-MM-DD" value={intake.ein.first_wage_date} onChange={(v) => set("ein.first_wage_date", v)} />
                  </>
                )}
                <Toggle label="None of these apply: heavy highway vehicles, gambling, Form 720 excise, alcohol/tobacco/firearms, Form 944" value={intake.ein.excise_none} onChange={(v) => set("ein.excise_none", v)} />
              </View>
            )}

            <View style={styles.actions}>
              {step === order.length - 1 ? (
                <Primary label="Sign and submit application" onPress={start} busy={busy} />
              ) : (
                <Primary label="Continue" onPress={() => go(step + 1)} busy={busy} />
              )}
              {step > 0 && (
                <Pressable onPress={() => go(step - 1)} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                  <Text style={styles.secondaryLabel}>← Back</Text>
                </Pressable>
              )}
            </View>
          </>
        )}
        {status !== "" && <Text style={[styles.status, failed && styles.statusFailed]}>{status}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Primary({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  return (
    <Pressable disabled={busy} onPress={onPress} style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}>
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

function Pills({ label, value, options, onChange }: { label: string; value: string; options: string[][]; onChange: (value: string) => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pills}>
        {options.map(([key, text]) => (
          <SelectPill key={key} label={text} active={value === key} onPress={() => onChange(key)} />
        ))}
      </View>
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: "#b4f58c" }} />
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  keyboard?: "email-address" | "phone-pad" | "number-pad" | "decimal-pad";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="rgba(255, 255, 255, 0.28)"
        autoCapitalize={keyboard === "email-address" ? "none" : undefined}
        autoCorrect={false}
        keyboardType={keyboard ?? "default"}
        style={styles.input}
      />
    </View>
  );
}

const white = "#ffffff";
const line = "rgba(255, 255, 255, 0.14)";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  hero: { flex: 0.8, minHeight: 0, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  heroSmall: { flex: 0.3 },
  vertical: { position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, backgroundColor: line },
  horizontal: { position: "absolute", left: 0, right: 0, top: "50%", height: 1, backgroundColor: line },
  brand: { position: "absolute", left: space.lg },
  brandText: { fontFamily: family.semibold, fontSize: 20, letterSpacing: -0.8, color: white },
  brandDim: { fontFamily: family.regular, color: "rgba(255, 255, 255, 0.55)" },
  card: { flex: 1.2, backgroundColor: "#121212", borderTopLeftRadius: 32, borderTopRightRadius: 32, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  cardContent: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 24 },
  chip: { fontFamily: family.medium, fontSize: 11, letterSpacing: 0.6, color: "#d9d4ff", backgroundColor: "rgba(123, 115, 240, 0.25)", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  switch: { fontFamily: family.regular, fontSize: 13, color: "rgba(255, 255, 255, 0.7)" },
  title: { fontFamily: family.light, fontSize: 40, lineHeight: 44, letterSpacing: -1.8, color: white, marginTop: space.md },
  hint: { fontFamily: family.regular, fontSize: 15, color: "rgba(255, 255, 255, 0.55)" },
  fields: { gap: space.md, marginTop: space.sm },
  field: { gap: space.xs },
  label: { fontFamily: family.regular, fontSize: 11, color: "rgba(255, 255, 255, 0.55)" },
  input: { fontFamily: family.regular, fontSize: 18, color: white, paddingVertical: space.sm, paddingHorizontal: 0, borderBottomWidth: 1, borderBottomColor: "rgba(255, 255, 255, 0.28)" },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  advice: { gap: space.xs, padding: space.lg, borderRadius: 20, backgroundColor: "rgba(123, 115, 240, 0.16)", marginTop: space.sm },
  adviceLabel: { fontFamily: family.medium, fontSize: 11, letterSpacing: 1.2, color: "#d9d4ff" },
  advicePick: { fontFamily: family.semibold, fontSize: 22, letterSpacing: -0.6, color: white },
  adviceWhy: { fontFamily: family.regular, fontSize: 14, lineHeight: 20, color: "rgba(255, 255, 255, 0.75)" },
  adviceFiling: { fontFamily: family.regular, fontSize: 13, lineHeight: 19, color: "rgba(255, 255, 255, 0.6)" },
  actions: { gap: space.sm, marginTop: space.md },
  steps: { flexDirection: "row", gap: space.xs, marginTop: space.sm },
  stepTab: { flex: 1, paddingTop: space.sm, borderTopWidth: 2, borderTopColor: "rgba(255, 255, 255, 0.14)" },
  stepNow: { borderTopColor: white },
  stepDone: { borderTopColor: "#b4f58c" },
  stepLabel: { fontFamily: family.regular, fontSize: 11, color: "rgba(255, 255, 255, 0.45)" },
  stepLabelOn: { color: white },
  sub: { fontFamily: family.medium, fontSize: 11, letterSpacing: 1.2, color: "rgba(255, 255, 255, 0.55)", marginTop: space.sm },
  secondary: { height: 56, borderRadius: 28, borderWidth: 1, borderColor: "rgba(255, 255, 255, 0.28)", alignItems: "center", justifyContent: "center" },
  secondaryLabel: { fontFamily: family.semibold, fontSize: 16, color: white },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md },
  toggleLabel: { flex: 1, fontFamily: family.regular, fontSize: 14, lineHeight: 20, color: "rgba(255, 255, 255, 0.75)" },
  ownerRow: { flexDirection: "row", gap: space.md },
  flex: { flex: 1 },
  pct: { width: 80 },
  primary: { height: 56, borderRadius: 28, backgroundColor: white, alignItems: "center", justifyContent: "center" },
  primaryLabel: { fontFamily: family.semibold, fontSize: 16, color: "#000000" },
  status: { fontFamily: family.regular, fontSize: 13, color: "rgba(255, 255, 255, 0.6)" },
  statusFailed: { color: "#ec6f5c" },
  pressed: { opacity: 0.8 },
});
