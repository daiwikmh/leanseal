import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { accountUrl, jurisdictions, milestones, network, type Advice, type Company as CompanyRecord } from "shared";
import { Agreements } from "../components/Agreements";
import { TabBar, tabBarHeight, type TabKey } from "../components/TabBar";
import type { PasskeySession } from "../lib/passkey";
import { CardTitle, ScreenTitle, ToneCard, tone } from "../components/ui";
import { dark, family, space } from "../theme";

const fallbackFilings: Record<string, string[]> = {
  "wy-llc": ["Form 5472 + pro forma 1120 every year", "Wyoming Annual Report each formation month", "Registered agent renewal"],
  "de-ccorp": ["Form 1120 corporate tax return", "Form 5472 if a foreign shareholder owns 25%+", "Delaware franchise tax by March 1"],
};

export function Company({ session, company, advice, onSelectTab, onFormation }: { session: PasskeySession; company: CompanyRecord; advice: Advice | null; onSelectTab: (key: TabKey) => void; onFormation: () => void }) {
  const insets = useSafeAreaInsets();
  const status = milestones.find((m) => m.key === company.status);
  const filings: string[] = advice?.filings ?? (company.jurisdiction ? fallbackFilings[company.jurisdiction] : []);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.sm, paddingBottom: tabBarHeight + insets.bottom + space.xl }]}>
        <ScreenTitle title="Company" />
        <ToneCard fill={tone.violet}>
          <Text style={styles.kicker}>LEGAL ENTITY</Text>
          <Text style={styles.name}>{company.legal_name}</Text>
          <Text style={styles.onColor}>{company.jurisdiction ? jurisdictions[company.jurisdiction].label : "No US entity yet · payments work without one"}</Text>
          <View style={styles.grid}>
            <Stat label="Founder country" value={company.country} />
            <Stat label="Status" value={status?.label ?? company.status} />
            <Stat label="Opened" value={new Date(company.created_at_ms).toLocaleDateString()} />
            <Stat label="Account" value={company.account_id} />
          </View>
          <Pressable onPress={() => void Linking.openURL(accountUrl(network.contract))}>
            <Text style={styles.link}>On-chain record ↗</Text>
          </Pressable>
        </ToneCard>
        {!company.application_hash && (
          <Pressable onPress={onFormation} style={({ pressed }) => [styles.formation, pressed && { opacity: 0.75 }]}>
            <Text style={styles.formationTitle}>FORM A US COMPANY</Text>
            <Text style={styles.formationSub}>Optional. Wyoming LLC or Delaware C-Corp, same details as doola or Stripe Atlas. Encrypted; only a hash goes on NEAR.</Text>
          </Pressable>
        )}
        <Agreements session={session} />
        <ToneCard>
          <CardTitle>Yearly US filings</CardTitle>
          {(filings.length ? filings : ["Appear here once you choose an entity in the formation application."]).map((f) => (
            <Text key={f} style={styles.item}>
              · {f}
            </Text>
          ))}
          <Text style={styles.muted}>Drafted by the advisor. Have a US tax professional review before filing.</Text>
        </ToneCard>
        <ToneCard>
          <CardTitle>Documents</CardTitle>
          {company.doc_hashes.length === 0 ? (
            <Text style={styles.muted}>Hashes appear here as each filing completes.</Text>
          ) : (
            company.doc_hashes.map((h) => (
              <Text key={h} style={styles.mono}>
                {h}
              </Text>
            ))
          )}
        </ToneCard>
      </ScrollView>
      <TabBar active="company" onSelect={onSelectTab} />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.paper },
  content: { paddingHorizontal: space.lg, gap: space.lg },
  kicker: { fontFamily: family.medium, fontSize: 11, letterSpacing: 1.3, color: "rgba(20, 24, 26, 0.7)" },
  name: { fontFamily: family.semibold, fontSize: 30, letterSpacing: -1.2, color: tone.ink },
  onColor: { fontFamily: family.regular, fontSize: 14, color: tone.ink },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  stat: { width: "48%", padding: space.md, borderRadius: 16, backgroundColor: "rgba(20, 24, 26, 0.12)", gap: 2 },
  statLabel: { fontFamily: family.regular, fontSize: 11, color: "rgba(20, 24, 26, 0.7)" },
  statValue: { fontFamily: family.semibold, fontSize: 14, color: tone.ink },
  link: { fontFamily: family.semibold, fontSize: 14, color: tone.ink, paddingVertical: space.xs },
  item: { fontFamily: family.regular, fontSize: 14, lineHeight: 20, color: dark.ink },
  muted: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: dark.muted },
  mono: { fontFamily: "Menlo", fontSize: 11, color: dark.ink },
  formation: { borderRadius: 28, padding: space.lg, gap: space.xs, backgroundColor: tone.butter },
  formationTitle: { fontFamily: family.semibold, fontSize: 20, letterSpacing: -0.6, color: tone.ink },
  formationSub: { fontFamily: family.regular, fontSize: 13, lineHeight: 19, color: "rgba(20, 24, 26, 0.75)" },
});
