import * as Clipboard from "expo-clipboard";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { accountUrl } from "shared";
import { TabBar, tabBarHeight, type TabKey } from "../components/TabBar";
import { ScreenTitle, ToneCard, tone } from "../components/ui";
import type { PasskeySession } from "../lib/passkey";
import { showToast } from "../lib/toast";
import { dark, family, space, touch } from "../theme";

export function Account({ session, onSelectTab, onSignOut }: { session: PasskeySession; onSelectTab: (key: TabKey) => void; onSignOut: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.sm, paddingBottom: tabBarHeight + insets.bottom + space.xl }]}>
        <ScreenTitle title="Account" />
        <ToneCard fill={tone.lime}>
          <Text style={styles.kicker}>BUSINESS ACCOUNT</Text>
          <Text style={styles.account}>{session.accountId}</Text>
        </ToneCard>
        <View style={styles.group}>
          <Row label="Copy account" onPress={async () => (await Clipboard.setStringAsync(session.accountId), showToast("Account copied"))} />
          <Row label="View on NearBlocks" onPress={() => void Linking.openURL(accountUrl(session.accountId))} />
          <Row label="Sign out" danger onPress={onSignOut} />
        </View>
        <ToneCard>
          <Text style={styles.label}>SIGNING KEY</Text>
          <Text style={styles.mono}>{session.key.publicKey}</Text>
          <Text style={styles.muted}>Derived from your passkey each time you sign in and never stored. No seed phrase to lose.</Text>
        </ToneCard>
      </ScrollView>
      <TabBar active="account" onSelect={onSelectTab} />
    </View>
  );
}

function Row({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Text style={[styles.rowLabel, danger && styles.danger]}>{label}</Text>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.paper },
  content: { paddingHorizontal: space.lg, gap: space.lg },
  kicker: { fontFamily: family.medium, fontSize: 11, letterSpacing: 1.3, color: dark.limeInk },
  account: { fontFamily: family.semibold, fontSize: 22, letterSpacing: -0.6, color: tone.ink },
  group: { borderRadius: 24, backgroundColor: tone.card, overflow: "hidden" },
  row: { minHeight: touch + space.md, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: dark.surfaceLine },
  rowLabel: { fontFamily: family.medium, fontSize: 15, color: dark.ink },
  danger: { color: dark.red },
  chev: { fontSize: 20, color: dark.muted },
  pressed: { opacity: 0.75 },
  label: { fontFamily: family.medium, fontSize: 11, letterSpacing: 1.3, color: dark.muted },
  mono: { fontFamily: "Menlo", fontSize: 11, color: dark.ink },
  muted: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: dark.muted },
});
