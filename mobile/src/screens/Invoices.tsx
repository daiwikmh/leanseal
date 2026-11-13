import { useState } from "react";
import { Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatUsd, invoiceTotal, invoicesCsv, statusLabel, toUnits, txUrl, type Invoice, type InvoiceStatus, type LineItem } from "shared";
import { BottomSheet } from "../components/BottomSheet";
import { TabBar, tabBarHeight, type TabKey } from "../components/TabBar";
import { ArrowBadge, ScreenTitle, Switcher, Tag, ToneCard, tone } from "../components/ui";
import { webUrl } from "../lib/config";
import { dark, family, space, touch } from "../theme";

const dots: Record<InvoiceStatus, string> = { open: tone.butter, pending: tone.sky, paid: tone.lime, refunded: tone.coral };

export function payLink(id: string): string {
  return `${webUrl}/pay?id=${encodeURIComponent(id)}`;
}

function due(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function InvoiceCard({ invoice, onPress }: { invoice: Invoice; onPress: () => void }) {
  return (
    <ToneCard>
      <View style={styles.cardHead}>
        <View style={styles.headText}>
          <Text style={styles.client}>{invoice.client_name.toUpperCase()}</Text>
          <Text style={styles.muted} numberOfLines={1}>
            {invoice.items[0]?.description} · due {due(invoice.due_ms)}
          </Text>
        </View>
        <ArrowBadge label="Open invoice" onPress={onPress} />
      </View>
      <View style={styles.tagRow}>
        <Tag label={formatUsd(invoice.amount)} />
        <Tag label={statusLabel[invoice.status]} dot={dots[invoice.status]} />
      </View>
    </ToneCard>
  );
}

type InvoicesProps = {
  invoices: Invoice[];
  onSelectTab: (key: TabKey) => void;
  onNewInvoice: () => void;
  onOpenInvoice: (invoice: Invoice) => void;
};

export function Invoices({ invoices, onSelectTab, onNewInvoice, onOpenInvoice }: InvoicesProps) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<"all" | "open" | "paid">("all");
  const shown = invoices.filter((inv) =>
    filter === "all" ? true : filter === "paid" ? inv.status === "paid" : inv.status === "open" || inv.status === "pending",
  );
  const open = invoices.filter((inv) => inv.status === "open" || inv.status === "pending").length;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.sm, paddingBottom: tabBarHeight + insets.bottom + space.xl }]}>
        <ScreenTitle title="Invoices" right={<ArrowBadge label="Export CSV" onPress={() => void Share.share({ message: invoicesCsv(invoices) })} />} />
        <Switcher
          items={[
            { key: "all", label: "All", dot: tone.violet, count: invoices.length },
            { key: "open", label: "Waiting", dot: tone.butter, count: open },
            { key: "paid", label: "Paid", dot: tone.lime, count: invoices.length - open },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {shown.length === 0 ? <Text style={styles.muted}>Nothing here yet.</Text> : shown.map((inv) => <InvoiceCard key={inv.id} invoice={inv} onPress={() => onOpenInvoice(inv)} />)}
        <Pressable onPress={onNewInvoice} style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}>
          <Text style={styles.newLabel}>+ New invoice</Text>
        </Pressable>
      </ScrollView>
      <TabBar active="invoices" onSelect={onSelectTab} />
    </View>
  );
}

export function InvoiceSheet({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  return (
    <BottomSheet title={invoice ? `Invoice ${invoice.id}` : null} onClose={onClose}>
      {invoice && (
        <>
          <Text style={styles.amount}>{formatUsd(invoice.amount)}</Text>
          <View style={styles.tagRow}>
            <Tag label={statusLabel[invoice.status]} dot={dots[invoice.status]} />
            <Tag label={`Due ${due(invoice.due_ms)}`} />
          </View>
          {invoice.items.map((item, i) => (
            <View key={i} style={styles.line}>
              <Text style={styles.lineText}>{item.description}</Text>
              <Text style={styles.lineText}>{formatUsd(toUnits(item.amount))}</Text>
            </View>
          ))}
          <Pressable
            onPress={() => void Share.share({ message: `Invoice from opencash — pay from any chain: ${payLink(invoice.id)}` })}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            <Text style={styles.primaryLabel}>Share pay link</Text>
          </Pressable>
          {invoice.paid_at_ms !== null && <Detail label="Paid on" value={new Date(invoice.paid_at_ms).toLocaleDateString()} />}
          {invoice.payment && <Detail label="Client paid with" value={`${invoice.payment.origin_asset} on ${invoice.payment.origin_chain}`} />}
          {invoice.payment?.amount_in ? <Detail label="Client sent" value={`${invoice.payment.amount_in} ${invoice.payment.origin_asset}`} /> : null}
          {invoice.payment?.refund_reason ? <Detail label="Refund reason" value={invoice.payment.refund_reason} /> : null}
          {invoice.payment?.origin_tx_url && (
            <Pressable onPress={() => void Linking.openURL(invoice.payment!.origin_tx_url!)}>
              <Text style={styles.link}>Payment transaction (client's chain) ↗</Text>
            </Pressable>
          )}
          {invoice.settle_tx && (
            <Pressable onPress={() => void Linking.openURL(txUrl(invoice.settle_tx!))}>
              <Text style={styles.link}>Settlement transaction (NEAR) ↗</Text>
            </Pressable>
          )}
        </>
      )}
    </BottomSheet>
  );
}

export function NewInvoiceSheet({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { client_name: string; due_ms: number; items: LineItem[] }) => Promise<void>;
}) {
  const [client, setClient] = useState("");
  const [days, setDays] = useState("14");
  const [items, setItems] = useState<LineItem[]>([{ description: "", amount: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  let total = "0";
  try {
    total = invoiceTotal(items.map((i) => ({ ...i, amount: i.amount || "0" })));
  } catch {
    total = "0";
  }

  const update = (index: number, patch: Partial<LineItem>) => setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  async function submit() {
    if (!client.trim()) return setError("Add the client's name.");
    if (items.some((i) => !i.description.trim() || !/^\d+(\.\d{1,2})?$/.test(i.amount.trim()))) return setError("Each line needs a description and an amount like 250.00.");
    setBusy(true);
    setError("Signing with your passkey key…");
    try {
      await onCreate({ client_name: client.trim(), due_ms: Date.now() + Number(days || "14") * 86_400_000, items });
      setClient("");
      setItems([{ description: "", amount: "" }]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet title={open ? "New invoice" : null} onClose={onClose}>
      <Input label="Client" value={client} onChange={setClient} placeholder="Northwind Inc." />
      <Input label="Due in days" value={days} onChange={setDays} placeholder="14" numeric />
      {items.map((item, index) => (
        <View key={index} style={styles.itemRow}>
          <View style={styles.flex}>
            <Input label="Description" value={item.description} onChange={(v) => update(index, { description: v })} placeholder="Design sprint" />
          </View>
          <View style={styles.amountField}>
            <Input label="USD" value={item.amount} onChange={(v) => update(index, { amount: v })} placeholder="250.00" numeric />
          </View>
        </View>
      ))}
      <Pressable onPress={() => setItems([...items, { description: "", amount: "" }])}>
        <Text style={styles.link}>+ Add line</Text>
      </Pressable>
      <View style={styles.line}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalLabel}>{formatUsd(total)}</Text>
      </View>
      <Text style={styles.muted}>Your client pays from any chain. You receive USDC. Gas is on opencash.</Text>
      {error !== "" && <Text style={styles.error}>{error}</Text>}
      <Pressable disabled={busy} onPress={submit} style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}>
        <Text style={styles.primaryLabel}>Create invoice</Text>
      </Pressable>
    </BottomSheet>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.lineText}>{value}</Text>
    </View>
  );
}

function Input({ label, value, onChange, placeholder, numeric }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; numeric?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={dark.muted}
        keyboardType={numeric ? "decimal-pad" : "default"}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.paper },
  content: { paddingHorizontal: space.lg, gap: space.lg },
  pressed: { opacity: 0.75 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  headText: { flex: 1, gap: 2 },
  client: { fontFamily: family.semibold, fontSize: 16, letterSpacing: -0.4, color: dark.ink },
  muted: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: dark.muted },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  newButton: { minHeight: touch + space.md, borderRadius: 999, borderWidth: 1, borderStyle: "dashed", borderColor: dark.line, alignItems: "center", justifyContent: "center" },
  newLabel: { fontFamily: family.medium, fontSize: 15, color: dark.ink },
  amount: { fontFamily: family.semibold, fontSize: 40, letterSpacing: -1.6, color: dark.ink },
  line: { flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: dark.line },
  lineText: { fontFamily: family.regular, fontSize: 14, color: dark.ink },
  detailLabel: { fontFamily: family.regular, fontSize: 14, color: dark.muted },
  totalLabel: { fontFamily: family.semibold, fontSize: 16, color: dark.ink },
  primary: { minHeight: touch + space.md, borderRadius: 999, backgroundColor: dark.accent, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  primaryLabel: { fontFamily: family.semibold, fontSize: 16, color: dark.onAccent },
  link: { fontFamily: family.medium, fontSize: 14, color: tone.violet, paddingVertical: space.sm },
  itemRow: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  amountField: { width: 104 },
  field: { gap: space.xs },
  fieldLabel: { fontFamily: family.medium, fontSize: 10, letterSpacing: 1.4, color: dark.muted },
  input: { minHeight: touch, paddingHorizontal: space.md, borderRadius: 12, borderWidth: 1, borderColor: dark.line, fontFamily: family.regular, fontSize: 15, color: dark.ink },
  error: { fontFamily: family.regular, fontSize: 12, color: dark.red },
});
