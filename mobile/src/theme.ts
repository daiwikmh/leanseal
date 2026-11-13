export const color = {
  paper: "#f7f6f2",
  ink: "#252527",
  line: "#d7d5d1",
  purple: "#7165ed",
  purpleLift: "#a79cff",
  purpleLabel: "#6a60d2",
  purpleFill: "rgba(98, 85, 213, 0.92)",
  dark: "#1b1c1f",
  nav: "rgba(29, 29, 30, 0.94)",
  glass: "rgba(23, 23, 27, 0.79)",
  glassLine: "rgba(255, 255, 255, 0.21)",
  node: "#b9b6c0",
  onDark: "#e3e1de",
  onDarkMuted: "#d0d0ce",
  onDarkFaint: "#d5d3dc",
} as const;

export const dark = {
  paper: "#0b0f0e",
  ink: "#e8ece9",
  muted: "#858589",
  line: "#2a3330",
  surface: "#131917",
  surfaceHover: "#1b2220",
  surfaceLine: "#222a27",
  green: "#3ddc84",
  red: "#ff6b6b",
  redSoft: "rgba(255, 107, 107, 0.12)",
  accent: "#7165ed",
  onAccent: "#ffffff",
  scrim: "rgba(0, 0, 0, 0.5)",
  lime: "#b4f58c",
  limeInk: "#2d6a1e",
  wallet: "#0c0c0c",
  onWallet: "#ffffff",
} as const;

export const touch = 44;

export const family = {
  light: "DMSans_300Light",
  regular: "DMSans_400Regular",
  medium: "DMSans_500Medium",
  semibold: "DMSans_600SemiBold",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  section: 48,
  block: 64,
} as const;

export const radius = 4;

export const track = (size: number, em: number) => size * em;
