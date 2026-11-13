import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { subscribeToast } from "../lib/toast";
import { family } from "../theme";

export function Toast() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => subscribeToast(setText), []);

  if (text === null) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 96 }]}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, alignItems: "center", zIndex: 200, elevation: 200 },
  text: { overflow: "hidden", paddingHorizontal: 20, paddingVertical: 14, borderRadius: 999, backgroundColor: "#c4f299", color: "#10210a", fontFamily: family.semibold, fontSize: 15 },
});
