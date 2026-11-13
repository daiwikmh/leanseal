import { DMSans_300Light, DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, useFonts } from "@expo-google-fonts/dm-sans";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { BackHandler, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Advice, Company as CompanyRecord, Invoice, LineItem } from "shared";
import type { TabKey } from "./src/components/TabBar";
import { Toast } from "./src/components/Toast";
import { api } from "./src/lib/api";
import { relayCall } from "./src/lib/near";
import type { PasskeySession } from "./src/lib/passkey";
import { showToast } from "./src/lib/toast";
import { Account } from "./src/screens/Account";
import { Company } from "./src/screens/Company";
import { Home } from "./src/screens/Home";
import { InvoiceSheet, Invoices, NewInvoiceSheet } from "./src/screens/Invoices";
import { Formation } from "./src/screens/Formation";
import { Payouts } from "./src/screens/Payouts";
import { Start } from "./src/screens/Start";
import { dark } from "./src/theme";

export default function App() {
  const [loaded, error] = useFonts({ DMSans_300Light, DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold });
  const [session, setSession] = useState<PasskeySession | null>(null);
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [balance, setBalance] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("home");
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<Invoice | null>(null);
  const [forming, setForming] = useState(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!session || tab === "home") return false;
      setTab("home");
      return true;
    });
    return () => subscription.remove();
  }, [session, tab]);

  async function refresh(account: string) {
    const [list, held] = await Promise.all([api.invoices(account), api.balance(account)]);
    setInvoices(list.sort((a, b) => b.created_at_ms - a.created_at_ms));
    setBalance(held.usdc);
  }

  async function enter(next: PasskeySession, opened?: CompanyRecord) {
    setAdvice(null);
    setCompany(opened ?? (await api.company(next.accountId)));
    setSession(next);
    setTab("home");
    await refresh(next.accountId).catch(() => {});
  }

  async function createInvoice(input: { client_name: string; due_ms: number; items: LineItem[] }) {
    if (!session) return;
    await relayCall(session, "create_invoice", input);
    await refresh(session.accountId);
    setCreating(false);
    showToast("Invoice created");
  }

  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: dark.paper }} />;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {!session || !company ? (
        <Start onReady={enter} />
      ) : forming ? (
        <Formation
          session={session}
          company={company}
          onCancel={() => setForming(false)}
          onDone={(updated, given) => {
            setCompany(updated);
            setAdvice(given);
            setForming(false);
            showToast("Application submitted");
          }}
        />
      ) : (
        <>
          {tab === "home" && (
            <Home
              company={company}
              invoices={invoices}
              balance={balance}
              onSelectTab={setTab}
              onNewInvoice={() => setCreating(true)}
              onRefresh={() => void refresh(session.accountId)}
              onOpenInvoice={setOpened}
            />
          )}
          {tab === "invoices" && <Invoices invoices={invoices} onSelectTab={setTab} onNewInvoice={() => setCreating(true)} onOpenInvoice={setOpened} />}
          {tab === "payouts" && <Payouts session={session} onSelectTab={setTab} />}
          {tab === "company" && <Company session={session} company={company} advice={advice} onSelectTab={setTab} onFormation={() => setForming(true)} />}
          {tab === "account" && (
            <Account
              session={session}
              onSelectTab={setTab}
              onSignOut={() => {
                setSession(null);
                setCompany(null);
                setInvoices([]);
              }}
            />
          )}
          <NewInvoiceSheet open={creating} onClose={() => setCreating(false)} onCreate={createInvoice} />
          <InvoiceSheet invoice={opened} onClose={() => setOpened(null)} />
        </>
      )}
      <Toast />
    </SafeAreaProvider>
  );
}
