import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

const box = { width: 622, height: 618 };
const stroke = 46;

type Segment = { from: [number, number]; to: [number, number]; row: number };

const segments: Segment[] = [
  { from: [219, 23], to: [403, 23], row: 0 },
  { from: [111, 103], to: [511, 103], row: 1 },
  { from: [48, 183], to: [272, 183], row: 2 },
  { from: [350, 183], to: [574, 183], row: 2 },
  { from: [369, 183], to: [451, 263], row: 3 },
  { from: [23, 263], to: [191, 263], row: 3 },
  { from: [431, 263], to: [599, 263], row: 3 },
  { from: [23, 355], to: [191, 355], row: 4 },
  { from: [431, 355], to: [599, 355], row: 4 },
  { from: [451, 355], to: [369, 435], row: 5 },
  { from: [48, 435], to: [272, 435], row: 5 },
  { from: [350, 435], to: [574, 435], row: 5 },
  { from: [111, 515], to: [511, 515], row: 6 },
  { from: [219, 595], to: [403, 595], row: 7 },
];

const drawMs = 320;
const staggerMs = 70;
const glowMs = 4200;

type AnimatedMarkProps = {
  size?: number;
  color: string;
  glow?: boolean;
  startDelayMs?: number;
};

export function AnimatedMark({ size = 120, color, glow = true, startDelayMs = 0 }: AnimatedMarkProps) {
  const draws = useRef(segments.map(() => new Animated.Value(0))).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const unit = size / box.width;

  useEffect(() => {
    let cancelled = false;
    let loop: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced) {
        draws.forEach((value) => value.setValue(1));
        return;
      }
      Animated.parallel(
        draws.map((value, index) =>
          Animated.timing(value, {
            toValue: 1,
            duration: drawMs,
            delay: startDelayMs + segments[index].row * staggerMs,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ),
      ).start(({ finished }) => {
        if (!finished || cancelled || !glow) return;
        loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: glowMs, easing: Easing.linear, useNativeDriver: true }));
        loop.start();
      });
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, []);

  return (
    <View style={{ width: size, height: box.height * unit }}>
      {segments.map((segment, index) => {
        const dx = segment.to[0] - segment.from[0];
        const dy = segment.to[1] - segment.from[1];
        const cap = (stroke / 2) * unit;
        const phase = (segment.row / 8) * 0.7;
        return (
          <Animated.View
            key={index}
            style={[
              styles.bar,
              {
                backgroundColor: color,
                left: segment.from[0] * unit - cap,
                top: segment.from[1] * unit - cap,
                width: Math.hypot(dx, dy) * unit + cap * 2,
                height: cap * 2,
                borderRadius: cap,
                opacity: pulse.interpolate({
                  inputRange: [0, phase, phase + 0.12, phase + 0.3, 1],
                  outputRange: [1, 1, 0.35, 1, 1],
                }),
                transformOrigin: [cap, cap, 0],
                transform: [
                  { rotate: `${Math.atan2(dy, dx)}rad` },
                  { scaleX: draws[index].interpolate({ inputRange: [0, 1], outputRange: [0.001, 1] }) },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute" },
});
