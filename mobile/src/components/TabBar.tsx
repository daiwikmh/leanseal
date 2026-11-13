import { Fragment } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "./TabIcon";
import { dark, space } from "../theme";

export type TabKey = "home" | "invoices" | "payouts" | "company" | "account";

const tabs: { key: TabKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "invoices", label: "Invoices" },
  { key: "payouts", label: "Payouts" },
  { key: "company", label: "Company" },
  { key: "account", label: "Account" },
];

const chip = "#d9d4ff";
const chipInk = "#14181a";

type TabBarProps = {
  active: TabKey;
  onSelect: (key: TabKey) => void;
};

export function TabBar({ active, onSelect }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const activeIndex = tabs.findIndex((tab) => tab.key === active);

  return (
    <View style={[styles.bar, { bottom: insets.bottom + space.sm }]}>
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        const showDivider = index > 0 && index !== activeIndex && index - 1 !== activeIndex;
        return (
          <Fragment key={tab.key}>
            {index > 0 && <View style={[styles.divider, !showDivider && styles.dividerHidden]} />}
            <Pressable
              onPress={() => onSelect(tab.key)}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected }}
              style={styles.tab}
            >
              {({ pressed }) => (
                <View style={[styles.chip, selected && styles.chipActive, pressed && styles.pressed]}>
                  <TabIcon tab={tab.key} color={selected ? chipInk : dark.muted} cut={selected ? chip : dark.surface} />
                </View>
              )}
            </Pressable>
          </Fragment>
        );
      })}
    </View>
  );
}

export const tabBarHeight = 72;

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.sm,
    borderRadius: 32,
    backgroundColor: dark.surface,
    borderWidth: 1,
    borderColor: dark.surfaceLine,
  },
  tab: { flex: 1, height: 64, alignItems: "center", justifyContent: "center" },
  chip: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  chipActive: { backgroundColor: chip },
  pressed: { opacity: 0.6 },
  divider: { width: 1, height: 20, backgroundColor: dark.line },
  dividerHidden: { backgroundColor: "transparent" },
});
