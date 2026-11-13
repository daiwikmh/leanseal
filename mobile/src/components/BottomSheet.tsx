import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dark, family, space, touch } from "../theme";

type BottomSheetProps = {
  title: string | null;
  onClose: () => void;
  children: ReactNode;
};

export function BottomSheet({ title, onClose, children }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={title !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.fill, styles.backdrop]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.fill} onPress={onClose} />
        <View style={[styles.panel, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={styles.grip} />
          <View style={styles.head}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={space.sm} style={styles.close}>
              <Text style={styles.closeLabel}>×</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { backgroundColor: dark.scrim },
  panel: {
    maxHeight: "86%",
    paddingHorizontal: space.lg,
    borderTopLeftRadius: space.xl,
    borderTopRightRadius: space.xl,
    borderWidth: 1,
    borderColor: dark.surfaceLine,
    backgroundColor: dark.surface,
  },
  grip: {
    alignSelf: "center",
    width: space.xxl,
    height: space.xs,
    marginTop: space.sm,
    borderRadius: space.xs,
    backgroundColor: dark.line,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontFamily: family.semibold, fontSize: 17, color: dark.ink },
  close: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  closeLabel: { fontSize: 24, color: dark.muted },
  body: { gap: space.md, paddingBottom: space.sm },
});
