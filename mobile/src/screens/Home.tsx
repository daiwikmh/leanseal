import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatUsd, type Company, type Invoice } from "shared";
import { TabBar, tabBarHeight, type TabKey } from "../components/TabBar";
import { CardTitle, RoundButton, Tag, ToneCard, tone } from "../components/ui";
import { InvoiceCard } from "./Invoices";
import { dark, family, space, touch, track } from "../theme";

type HomeProps = {
  company: Company;
  invoices: Invoice[];
  balance: string | null;
  onSelectTab: (key: TabKey) => void;
  onNewInvoice: () => void;
  onRefresh: () => void;
  onOpenInvoice: (invoice: Invoice) => void;
};

function split(units: string): { whole: string; cents: string } {
  const [whole, cents] = formatUsd(units).split(".");
  return { whole, cents: `.${cents}` };
}

export function Home({ company, invoices, balance, onSelectTab, onNewInvoice, onRefresh, onOpenInvoice }: HomeProps) {
  const insets = useSafeAreaInsets();
  const money = split(balance ?? "0");
  const waiting = invoices.filter((inv) => inv.status === "open" || inv.status === "pending");

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.sm, paddingBottom: tabBarHeight + insets.bottom + space.xl }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.greetRow}>
          <Text style={styles.greet} numberOfLines={1}>
            {company.legal_name}
          </Text>
          <RoundButton glyph="⟳" label="Refresh" light onPress={onRefresh} />
          <RoundButton glyph="+" label="New invoice" fill={tone.coral} onPress={onNewInvoice} />
        </View>

        <View style={styles.wallet}>
          <View style={styles.walletFace}>
            <View style={[styles.dot, styles.dotTopLeft]} />
            <View style={[styles.dot, styles.dotTopRight]} />
            <View style={[styles.dot, styles.dotBottomLeft]} />
            <View style={[styles.dot, styles.dotBottomRight]} />
            <Text style={styles.walletAccount} numberOfLines={1}>
              {company.account_id}
            </Text>
            <Text style={styles.walletBalance} numberOfLines={1} adjustsFontSizeToFit>
              {money.whole}
              <Text style={styles.walletCents}>{money.cents}</Text>
            </Text>
            <Text style={styles.walletChange}>USDC on NEAR</Text>
          </View>
          <View style={styles.walletActions}>
            <Pressable style={styles.walletAction} onPress={onNewInvoice} accessibilityRole="button">
              <Text style={styles.walletIcon}>+</Text>
              <Text style={styles.walletActionLabel}>Invoice</Text>
            </Pressable>
            <View style={styles.walletDivider} />
            <Pressable style={styles.walletAction} onPress={() => onSelectTab("invoices")} accessibilityRole="button">
              <Text style={styles.walletIcon}>≡</Text>
              <Text style={styles.walletActionLabel}>{waiting.length} open</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.quick}>
          <Pressable onPress={() => onSelectTab("payouts")} style={({ pressed }) => [styles.quickItem, { backgroundColor: tone.coral }, pressed && styles.pressed]}>
            <Text style={styles.quickTitle}>PAY</Text>
            <Text style={styles.quickSub}>USDC to any chain</Text>
          </Pressable>
          <Pressable onPress={() => onSelectTab("invoices")} style={({ pressed }) => [styles.quickItem, { backgroundColor: tone.sky }, pressed && styles.pressed]}>
            <Text style={styles.quickTitle}>INVOICES</Text>
            <Text style={styles.quickSub}>{waiting.length} waiting</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>RECENT INVOICES</Text>
        {invoices.length === 0 ? (
          <Text style={styles.muted}>No invoices yet. Create one and share the link with your client.</Text>
        ) : (
          invoices.slice(0, 3).map((inv) => <InvoiceCard key={inv.id} invoice={inv} onPress={() => onOpenInvoice(inv)} />)
        )}

        <View style={styles.quick}>
          <Pressable onPress={onNewInvoice} style={({ pressed }) => [styles.quickItem, { backgroundColor: tone.butter }, pressed && styles.pressed]}>
            <Text style={styles.quickTitle}>INVOICE</Text>
            <Text style={styles.quickSub}>Paid from any chain</Text>
          </Pressable>
          <Pressable onPress={() => onSelectTab("company")} style={({ pressed }) => [styles.quickItem, { backgroundColor: tone.peach }, pressed && styles.pressed]}>
            <Text style={styles.quickTitle}>COMPANY</Text>
            <Text style={styles.quickSub}>Optional US entity</Text>
          </Pressable>
        </View>
      </ScrollView>
      <TabBar active="home" onSelect={onSelectTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.paper },
  content: { paddingHorizontal: space.lg, gap: space.lg },
  pressed: { opacity: 0.75 },
  greetRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  greet: { flex: 1, fontFamily: family.semibold, fontSize: 20, letterSpacing: -0.6, color: dark.ink },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  wallet: { padding: space.md, borderRadius: space.xl + space.md, borderWidth: 1, borderColor: dark.surfaceLine, backgroundColor: dark.wallet },
  walletFace: { alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.xl, borderRadius: space.xl, backgroundColor: dark.lime },
  dot: { position: "absolute", width: space.sm, height: space.sm, borderRadius: space.xs, backgroundColor: dark.wallet },
  dotTopLeft: { top: space.xl, left: space.xl },
  dotTopRight: { top: space.xl, right: space.xl },
  dotBottomLeft: { bottom: space.xl, left: space.xl },
  dotBottomRight: { bottom: space.xl, right: space.xl },
  walletAccount: { fontFamily: family.medium, fontSize: 13, color: dark.limeInk },
  walletBalance: { fontFamily: family.semibold, fontSize: 56, letterSpacing: track(56, -0.05), color: dark.limeInk, marginTop: space.md },
  walletCents: { fontSize: 30, letterSpacing: track(30, -0.03) },
  walletChange: { fontFamily: family.medium, fontSize: 18, color: dark.limeInk, marginTop: space.sm },
  walletActions: { flexDirection: "row", alignItems: "center", paddingVertical: space.xl },
  walletAction: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, minHeight: touch },
  walletIcon: { fontSize: 24, lineHeight: 28, color: dark.onWallet },
  walletActionLabel: { fontFamily: family.medium, fontSize: 22, color: dark.onWallet },
  walletDivider: { width: 1, height: space.section, backgroundColor: dark.line },
  step: { flexDirection: "row", gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: 16 },
  stepNow: { backgroundColor: tone.ink },
  stepMark: { width: space.sm, height: space.sm, marginTop: 6, transform: [{ rotate: "45deg" }], backgroundColor: "rgba(20, 24, 26, 0.3)" },
  stepDone: { backgroundColor: tone.ink },
  stepMarkNow: { backgroundColor: tone.lime },
  stepText: { flex: 1, gap: 2 },
  stepLabel: { fontFamily: family.semibold, fontSize: 15, color: tone.ink },
  stepLabelNow: { color: tone.paper },
  stepDetail: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: "rgba(243, 244, 241, 0.7)" },
  section: { fontFamily: family.semibold, fontSize: 22, letterSpacing: -0.8, color: dark.ink },
  muted: { fontFamily: family.regular, fontSize: 13, lineHeight: 19, color: dark.muted },
  quick: { flexDirection: "row", gap: space.md },
  quickItem: { flex: 1, borderRadius: 28, padding: space.lg, gap: space.xs, minHeight: 112, justifyContent: "flex-end" },
  quickTitle: { fontFamily: family.semibold, fontSize: 22, letterSpacing: -0.8, color: tone.ink },
  quickSub: { fontFamily: family.regular, fontSize: 12, color: "rgba(20, 24, 26, 0.75)" },
});
