import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatUsd, payoutStatusLabel, txUrl, type PayToken, type Payout } from "shared";
import { TabBar, tabBarHeight, type TabKey } from "../components/TabBar";
import { CardTitle, ScreenTitle, SelectPill, Tag, ToneCard, tone } from "../components/ui";
import { api } from "../lib/api";
import { businessAuth, sendUsdc } from "../lib/near";
import type { PasskeySession } from "../lib/passkey";
import { showToast } from "../lib/toast";
import { dark, family, space, touch } from "../theme";

const dots: Record<Payout["status"], string> = { quoted: tone.butter, sent: tone.sky, completed: tone.lime, refunded: tone.coral, failed: tone.coral, expired: tone.coral };

export function Payouts({ session, onSelectTab }: { session: PasskeySession; onSelectTab: (key: TabKey) => void }) {
  const insets = useSafeAreaInsets();
  const [tokens, setTokens] = useState<PayToken[]>([]);
  const [history, setHistory] = useState<Payout[]>([]);
  const [chain, setChain] = useState("base");
  const [assetId, setAssetId] = useState("");
  const [name, setName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Payout | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const chains = useMemo(() => [...new Set(tokens.map((t) => t.blockchain))], [tokens]);
  const chainTokens = tokens.filter((t) => t.blockchain === chain);

  async function load() {
    const [list, payouts] = await Promise.all([api.tokens(), api.payouts(await businessAuth(session, "list-payouts"))]);
    setTokens(list);
    setHistory(payouts.filter((p) => p.status !== "quoted" && p.status !== "expired"));
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [session.accountId]);

  useEffect(() => {
    setAssetId(chainTokens.find((t) => t.symbol === "USDC")?.assetId ?? chainTokens[0]?.assetId ?? "");
  }, [chain, tokens.length]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const getQuote = () =>
    run(async () => {
      setMessage("Getting a quote from NEAR Intents…");
      const result = await api.quotePayouts(await businessAuth(session, "quote-payouts"), { items: [{ payee_name: name, asset_id: assetId, recipient, amount }] });
      setQuote(result.payouts[0]);
      setConfirmed(false);
      setMessage("");
    });

  const send = () =>
    run(async () => {
      if (!quote) return;
      setMessage("Signing with your passkey…");
      await sendUsdc(session, [quote]);
      await api.savePayee(await businessAuth(session, "save-payee"), { name: quote.payee_name, asset_id: quote.asset_id, recipient: quote.recipient }).catch(() => undefined);
      showToast("Payout sent");
      setQuote(null);
      setName("");
      setRecipient("");
      setAmount("");
      setMessage("");
      await load();
    });

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.sm, paddingBottom: tabBarHeight + insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <ScreenTitle title="Pay someone" />
        <ToneCard>
          <Text style={styles.muted}>You pay USDC from your NEAR account; they receive the token and chain they want. No gas.</Text>
          <Input label="Name" value={name} onChange={setName} placeholder="Ada Okafor" />
          <Text style={styles.label}>CHAIN</Text>
          <View style={styles.pills}>
            {chains.map((c) => (
              <SelectPill key={c} label={c} active={chain === c} onPress={() => setChain(c)} />
            ))}
          </View>
          <Text style={styles.label}>THEY RECEIVE</Text>
          <View style={styles.pills}>
            {chainTokens.map((t) => (
              <SelectPill key={t.assetId} label={t.symbol} active={assetId === t.assetId} onPress={() => setAssetId(t.assetId)} />
            ))}
          </View>
          <Input label={`Their address on ${chain}`} value={recipient} onChange={setRecipient} placeholder="0x… / wallet address" />
          <Input label="Amount in USD" value={amount} onChange={setAmount} placeholder="250.00" numeric />
          {quote ? (
            <>
              <Text style={styles.quote}>
                {quote.payee_name} receives {quote.amount_out} {quote.symbol} on {quote.chain} for {formatUsd(quote.amount_units)} USDC.
              </Text>
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>Send now. USDC leaves this account; failed deliveries refund to it.</Text>
                <Switch value={confirmed} onValueChange={setConfirmed} trackColor={{ true: tone.lime }} />
              </View>
              <Pressable disabled={!confirmed || busy} onPress={send} style={({ pressed }) => [styles.primary, (!confirmed || busy || pressed) && styles.pressed]}>
                <Text style={styles.primaryLabel}>Send with passkey</Text>
              </Pressable>
            </>
          ) : (
            <Pressable disabled={busy} onPress={getQuote} style={({ pressed }) => [styles.primary, (busy || pressed) && styles.pressed]}>
              <Text style={styles.primaryLabel}>Get quote</Text>
            </Pressable>
          )}
          {message !== "" && <Text style={styles.muted}>{message}</Text>}
        </ToneCard>
        <ToneCard>
          <CardTitle>History</CardTitle>
          {history.length === 0 ? (
            <Text style={styles.muted}>No payouts yet. Payroll for many people at once is on the web app.</Text>
          ) : (
            history.map((p) => (
              <Pressable key={p.id} onPress={() => p.transfer_tx && void Linking.openURL(p.delivery_tx_url ?? txUrl(p.transfer_tx))} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.name}>{p.payee_name}</Text>
                  <Text style={styles.muted}>
                    {p.amount_out} {p.symbol} on {p.chain}
                  </Text>
                </View>
                <Tag label={payoutStatusLabel[p.status]} dot={dots[p.status]} />
              </Pressable>
            ))
          )}
        </ToneCard>
      </ScrollView>
      <TabBar active="payouts" onSelect={onSelectTab} />
    </View>
  );
}

function Input({ label, value, onChange, placeholder, numeric }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; numeric?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={dark.muted} autoCapitalize="none" autoCorrect={false} keyboardType={numeric ? "decimal-pad" : "default"} style={styles.input} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.paper },
  content: { paddingHorizontal: space.lg, gap: space.lg },
  muted: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: dark.muted },
  label: { fontFamily: family.medium, fontSize: 10, letterSpacing: 1.4, color: dark.muted },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  field: { gap: space.xs },
  input: { minHeight: touch, paddingHorizontal: space.md, borderRadius: 12, borderWidth: 1, borderColor: dark.line, fontFamily: family.regular, fontSize: 15, color: dark.ink },
  quote: { fontFamily: family.medium, fontSize: 15, lineHeight: 21, color: dark.ink },
  confirm: { flexDirection: "row", alignItems: "center", gap: space.md },
  confirmText: { flex: 1, fontFamily: family.regular, fontSize: 13, lineHeight: 19, color: dark.ink },
  primary: { minHeight: touch + space.md, borderRadius: 999, backgroundColor: dark.accent, alignItems: "center", justifyContent: "center" },
  primaryLabel: { fontFamily: family.semibold, fontSize: 16, color: dark.onAccent },
  pressed: { opacity: 0.6 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch + space.sm, borderTopWidth: 1, borderTopColor: dark.surfaceLine },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: family.semibold, fontSize: 15, color: dark.ink },
});
