import { StyleSheet, View } from "react-native";
import type { TabKey } from "./TabBar";

type TabIconProps = { tab: TabKey; color: string; cut: string };

export function TabIcon({ tab, color, cut }: TabIconProps) {
  if (tab === "home") {
    return (
      <View style={styles.box}>
        <View style={[styles.roof, { borderBottomColor: color }]} />
        <View style={[styles.house, { backgroundColor: color }]}>
          <View style={[styles.door, { backgroundColor: cut }]} />
        </View>
      </View>
    );
  }
  if (tab === "payouts") {
    return (
      <View style={styles.box}>
        <View style={[styles.arrowHead, { borderBottomColor: color }]} />
        <View style={[styles.arrowStem, { backgroundColor: color }]} />
        <View style={[styles.arrowBase, { backgroundColor: color }]} />
      </View>
    );
  }
  if (tab === "company") {
    return (
      <View style={[styles.box, styles.grid]}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.cell, { backgroundColor: color }]} />
        ))}
      </View>
    );
  }
  if (tab === "invoices") {
    return (
      <View style={[styles.box, styles.bars]}>
        {[9, 15, 21].map((height) => (
          <View key={height} style={[styles.bar, { height, backgroundColor: color }]} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <View style={[styles.person, { backgroundColor: color }]} />
      <View style={[styles.shoulders, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, alignItems: "center", justifyContent: "flex-end" },
  arrowHead: { width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderBottomWidth: 8, borderLeftColor: "transparent", borderRightColor: "transparent" },
  arrowStem: { width: 4, height: 7 },
  arrowBase: { width: 20, height: 4, borderRadius: 2, marginTop: 2 },
  roof: {
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderBottomWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  house: { width: 18, height: 12, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, alignItems: "center", justifyContent: "flex-end" },
  door: { width: 5, height: 7, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", alignContent: "center", justifyContent: "center", gap: 3 },
  cell: { width: 9, height: 9, borderRadius: 3 },
  bars: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 3 },
  bar: { width: 5, borderRadius: 2 },
  person: { position: "absolute", top: 1, width: 9, height: 9, borderRadius: 5 },
  shoulders: { width: 20, height: 10, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
});
