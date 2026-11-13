import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { handlePattern, network, type Company } from "shared";
import { AnimatedMark } from "../components/AnimatedMark";
import { api } from "../lib/api";
import { createPasskey, signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { family, space } from "../theme";

type StartProps = { onReady: (session: PasskeySession, company?: Company) => Promise<void> };

export function Start({ onReady }: StartProps) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [founder, setFounder] = useState("");
  const [business, setBusiness] = useState("");
  const [handle, setHandle] = useState("");
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function report(message: string, error = false) {
    setStatus(message);
    setFailed(error);
  }

  const create = () =>
    run(async () => {
      const name = handle.trim().toLowerCase();
      if (!business.trim()) return report("Enter your business name.", true);
      if (!handlePattern.test(name)) return report("Handle: lowercase letters, numbers and dashes.", true);
      if (!country.trim()) return report("Enter your country.", true);
      report("Create your passkey…");
      const session = await createPasskey(`${name}.${network.parent}`, founder.trim() || business.trim());
      report("Opening your USDC account on NEAR…");
      const { company } = await api.createCompany({ handle: name, legalName: business.trim(), country: country.trim(), publicKey: session.key.publicKey });
      await onReady(session, company);
    });

  const signIn = () =>
    run(async () => {
      report("Waiting for your passkey…");
      await onReady(await signInWithPasskey());
    });

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.hero}>
        <View style={styles.vertical} />
        <View style={styles.horizontal} />
        <View style={[styles.brand, { top: insets.top + space.md }]}>
          <Text style={styles.brandText}>
            open<Text style={styles.brandDim}>cash</Text>
          </Text>
        </View>
        <AnimatedMark size={mode === "create" ? 72 : 120} color="#ffffff" />
      </View>
      <ScrollView style={styles.card} contentContainerStyle={[styles.cardContent, { paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <View style={styles.top}>
          <Text style={styles.chip}>NEAR mainnet</Text>
          <Pressable onPress={() => setMode(mode === "create" ? "signin" : "create")} hitSlop={space.sm}>
            <Text style={styles.switch}>{mode === "create" ? "I have an account" : "Create an account"}</Text>
          </Pressable>
        </View>
        {mode === "signin" ? (
          <>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.hint}>Your passkey unlocks your account.</Text>
            <Pressable disabled={busy} onPress={signIn} style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}>
              <Text style={styles.primaryLabel}>Sign in with passkey</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.title}>Payments for everyone</Text>
            <Text style={styles.hint}>A USDC business account on NEAR. Invoice, take payments, pay anyone. No seed phrase, no gas.</Text>
            <View style={styles.fields}>
              <Field label="Your name" value={founder} onChange={setFounder} placeholder="Ada Okafor" />
              <Field label="Business name" value={business} onChange={setBusiness} placeholder="Acme Studio" />
              <Field label={`Account · ${handle.trim().toLowerCase() || "acme"}.${network.parent}`} value={handle} onChange={setHandle} placeholder="acme" />
              <Field label="Country" value={country} onChange={setCountry} placeholder="Nigeria" />
            </View>
            <Pressable disabled={busy} onPress={create} style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}>
              <Text style={styles.primaryLabel}>Create my account with a passkey</Text>
            </Pressable>
          </>
        )}
        {status !== "" && <Text style={[styles.status, failed && styles.statusFailed]}>{status}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="rgba(255, 255, 255, 0.28)" autoCapitalize="none" autoCorrect={false} style={styles.input} />
    </View>
  );
}

const white = "#ffffff";
const line = "rgba(255, 255, 255, 0.14)";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  hero: { flex: 0.6, minHeight: 0, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  vertical: { position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, backgroundColor: line },
  horizontal: { position: "absolute", left: 0, right: 0, top: "50%", height: 1, backgroundColor: line },
  brand: { position: "absolute", left: space.lg },
  brandText: { fontFamily: family.semibold, fontSize: 20, letterSpacing: -0.8, color: white },
  brandDim: { fontFamily: family.regular, color: "rgba(255, 255, 255, 0.55)" },
  card: { flex: 1.2, backgroundColor: "#121212", borderTopLeftRadius: 32, borderTopRightRadius: 32, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  cardContent: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 24 },
  chip: { fontFamily: family.medium, fontSize: 11, letterSpacing: 0.6, color: "#d9d4ff", backgroundColor: "rgba(123, 115, 240, 0.25)", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  switch: { fontFamily: family.regular, fontSize: 13, color: "rgba(255, 255, 255, 0.7)" },
  title: { fontFamily: family.light, fontSize: 40, lineHeight: 44, letterSpacing: -1.8, color: white, marginTop: space.md },
  hint: { fontFamily: family.regular, fontSize: 15, lineHeight: 21, color: "rgba(255, 255, 255, 0.55)" },
  fields: { gap: space.md },
  field: { gap: space.xs },
  label: { fontFamily: family.regular, fontSize: 11, color: "rgba(255, 255, 255, 0.55)" },
  input: { fontFamily: family.regular, fontSize: 18, color: white, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: "rgba(255, 255, 255, 0.28)" },
  primary: { height: 56, borderRadius: 28, backgroundColor: white, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  primaryLabel: { fontFamily: family.semibold, fontSize: 16, color: "#000000" },
  status: { fontFamily: family.regular, fontSize: 13, color: "rgba(255, 255, 255, 0.6)" },
  statusFailed: { color: "#ec6f5c" },
  pressed: { opacity: 0.8 },
});
