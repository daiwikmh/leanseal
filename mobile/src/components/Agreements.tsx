import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { agreementKinds, agreementSigningSubject, fromBase64, type Agreement, type StoredDocument } from "shared";
import { api } from "../lib/api";
import { webUrl } from "../lib/config";
import { passkeyAuth } from "../lib/near";
import type { PasskeySession } from "../lib/passkey";
import { showToast } from "../lib/toast";
import { dark, family, space, touch } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { CardTitle, Tag, ToneCard, tone } from "./ui";

const consent =
  "I have read this document, I agree to sign it electronically, and I intend my NEAR account's signature over its SHA-256 fingerprint to be my legally binding signature.";

function statusLabel(a: Agreement): string {
  return a.status === "executed" ? "Executed" : a.status === "voided" ? "Voided" : `${a.signatures.length} of ${a.parties.length} signed`;
}

export function Agreements({ session }: { session: PasskeySession }) {
  const [list, setList] = useState<Agreement[] | null>(null);
  const [open, setOpen] = useState<Agreement | null>(null);
  const [doc, setDoc] = useState<StoredDocument | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    const auth = await passkeyAuth(session, "list-agreements", session.accountId);
    const [mine, toSign] = await Promise.all([api.agreements(auth, session.accountId), api.agreements(auth, session.accountId, true)]);
    const byId = new Map([...mine, ...toSign].map((a) => [a.id, a]));
    setList([...byId.values()].sort((a, b) => b.created_at_ms - a.created_at_ms));
  }

  useEffect(() => {
    load().catch((error) => setMessage(String(error instanceof Error ? error.message : error)));
  }, [session.accountId]);

  async function show(a: Agreement) {
    setOpen(a);
    setDoc(null);
    setAgreed(false);
    setMessage("");
    try {
      setDoc(await api.document(await passkeyAuth(session, "read-document", a.doc_hash), a.doc_hash, a.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function sign(a: Agreement) {
    try {
      setMessage("Signing…");
      await api.signAgreement(await passkeyAuth(session, "sign-agreement", agreementSigningSubject(a.id, a.doc_hash)), a.id);
      showToast("Signed");
      setOpen(null);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const canSign = open !== null && open.status === "pending" && open.parties.includes(session.accountId) && !open.signatures.some((s) => s.account_id === session.accountId);

  return (
    <ToneCard>
      <CardTitle>Agreements</CardTitle>
      {list === null ? (
        <Text style={styles.muted}>{message || "Loading…"}</Text>
      ) : list.length === 0 ? (
        <Text style={styles.muted}>No agreements yet. Create your Operating Agreement or a client contract on the web app.</Text>
      ) : (
        list.map((a) => (
          <Pressable key={a.id} onPress={() => void show(a)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.title} numberOfLines={1}>{a.title}</Text>
              <Text style={styles.muted}>{agreementKinds[a.kind]}</Text>
            </View>
            <Tag label={statusLabel(a)} dot={a.status === "executed" ? tone.lime : a.status === "voided" ? tone.coral : tone.butter} />
          </Pressable>
        ))
      )}
      <BottomSheet title={open?.title ?? null} onClose={() => setOpen(null)}>
        {open && (
          <>
            <Text style={styles.mono}>{open.doc_hash}</Text>
            {open.parties.map((p) => {
              const s = open.signatures.find((x) => x.account_id === p);
              return (
                <View key={p} style={styles.party}>
                  <Text style={styles.partyName}>{p}</Text>
                  <Text style={styles.muted}>{s ? `✓ ${new Date(s.signed_at_ms).toLocaleDateString()}` : "Waiting"}</Text>
                </View>
              );
            })}
            {doc?.mime === "text/plain" && <Text style={styles.doc}>{new TextDecoder().decode(fromBase64(doc.content_base64))}</Text>}
            {doc?.mime === "application/pdf" && (
              <Pressable onPress={() => void Linking.openURL(`${webUrl}/sign?id=${encodeURIComponent(open.id)}`)}>
                <Text style={styles.link}>Open the PDF on the web ↗</Text>
              </Pressable>
            )}
            {canSign && doc && (
              <>
                <View style={styles.consent}>
                  <Text style={styles.consentText}>{consent}</Text>
                  <Switch value={agreed} onValueChange={setAgreed} trackColor={{ true: tone.lime }} />
                </View>
                <Pressable disabled={!agreed} onPress={() => void sign(open)} style={({ pressed }) => [styles.primary, (!agreed || pressed) && styles.pressed]}>
                  <Text style={styles.primaryLabel}>Sign with my passkey</Text>
                </Pressable>
              </>
            )}
            {message !== "" && <Text style={styles.muted}>{message}</Text>}
          </>
        )}
      </BottomSheet>
    </ToneCard>
  );
}

const styles = StyleSheet.create({
  muted: { fontFamily: family.regular, fontSize: 12, lineHeight: 18, color: dark.muted },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch + space.sm, borderTopWidth: 1, borderTopColor: dark.surfaceLine },
  rowText: { flex: 1, gap: 2 },
  title: { fontFamily: family.semibold, fontSize: 15, color: dark.ink },
  pressed: { opacity: 0.6 },
  mono: { fontFamily: "Menlo", fontSize: 11, color: dark.muted },
  party: { flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: dark.line },
  partyName: { fontFamily: family.medium, fontSize: 14, color: dark.ink },
  doc: { fontFamily: "Menlo", fontSize: 11, lineHeight: 17, color: dark.ink, padding: space.md, borderRadius: 12, backgroundColor: dark.paper },
  link: { fontFamily: family.medium, fontSize: 14, color: tone.violet, paddingVertical: space.sm },
  consent: { flexDirection: "row", alignItems: "center", gap: space.md },
  consentText: { flex: 1, fontFamily: family.regular, fontSize: 13, lineHeight: 19, color: dark.ink },
  primary: { minHeight: touch + space.md, borderRadius: 999, backgroundColor: dark.accent, alignItems: "center", justifyContent: "center" },
  primaryLabel: { fontFamily: family.semibold, fontSize: 16, color: dark.onAccent },
});
