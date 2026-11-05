import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type PressableProps, type TextInputProps, type ViewStyle, type StyleProp,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, useTheme } from './theme';

export function Screen({ children, scroll, style, edges }: { children: React.ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle>; edges?: ('top' | 'bottom')[] }) {
  const t = useTheme();
  const inner = scroll ? <ScrollView contentContainerStyle={[{ padding: space.lg, gap: space.md }, style]} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={[{ flex: 1 }, style]}>{children}</View>;
  return <SafeAreaView edges={edges ?? ['top', 'bottom']} style={{ flex: 1, backgroundColor: t.bg }}>{inner}</SafeAreaView>;
}

export function Title({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, marginBottom: space.sm }}>
      <Text style={{ fontSize: 24, fontWeight: '700', color: t.text, textAlign: 'auto' }}>{children}</Text>
      {sub ? <Text style={{ fontSize: 15, color: t.textMuted, lineHeight: 21 }}>{sub}</Text> : null}
    </View>
  );
}

export function Muted({ children, style }: { children: React.ReactNode; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: t.textMuted, fontSize: 13, lineHeight: 18 }, style]}>{children}</Text>;
}

export function Button({ title, onPress, variant = 'primary', loading, disabled, style }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean; disabled?: boolean; style?: ViewStyle }) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.brand : variant === 'danger' ? t.danger : variant === 'secondary' ? t.surfaceAlt : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? t.brandText : variant === 'ghost' ? t.accent : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [{ backgroundColor: bg, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: space.lg, alignItems: 'center', opacity: disabled ? 0.45 : pressed ? 0.85 : 1, minHeight: 48, justifyContent: 'center' }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label?: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={{ color: t.text, fontWeight: '600', fontSize: 14 }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={t.textMuted}
        {...props}
        style={[{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12, fontSize: 16, color: t.text, textAlign: 'auto' }, props.style]}
      />
      {hint ? <Muted>{hint}</Muted> : null}
    </View>
  );
}

export function Chip({ label, active, onPress, count }: { label: string; active?: boolean; onPress?: () => void; count?: number }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityState={{ selected: !!active }} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: active ? t.brand : t.surface, borderWidth: 1, borderColor: active ? t.brand : t.border, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
      <Text style={{ color: active ? t.brandText : t.text, fontSize: 14, fontWeight: '500' }}>{label}</Text>
      {count ? <Badge n={count} inverted={active} /> : null}
    </Pressable>
  );
}

export function Badge({ n, inverted }: { n: number; inverted?: boolean }) {
  const t = useTheme();
  if (!n) return null;
  return (
    <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: inverted ? t.brandText : t.badge, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: inverted ? t.brand : '#fff', fontSize: 12, fontWeight: '700' }}>{n > 99 ? '99+' : n}</Text>
    </View>
  );
}

export function initials(name: string): string {
  const parts = name.replace(/["'״׳.]/g, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

const AVATAR_COLORS = ['#1F8A70', '#3E6FB0', '#9C5AB8', '#C2603A', '#2F8C9C', '#7A7F2B', '#B0466E'];

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: AVATAR_COLORS[h % AVATAR_COLORS.length], alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Row({ title, subtitle, right, onPress, left, danger }: { title: string; subtitle?: string; right?: React.ReactNode; onPress?: PressableProps['onPress']; left?: React.ReactNode; danger?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 12, paddingHorizontal: space.lg, backgroundColor: pressed ? t.surfaceAlt : t.surface })}>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 16, color: danger ? t.danger : t.text }} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={{ fontSize: 13, color: t.textMuted }} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right}
    </Pressable>
  );
}

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {title ? <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: '600', paddingHorizontal: space.lg, textTransform: 'uppercase' }}>{title}</Text> : null}
      <View style={{ backgroundColor: t.surface, borderRadius: radius.md, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>{children}</View>
    </View>
  );
}

export function ToggleRow({ title, value, onChange, disabled }: { title: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const t = useTheme();
  return <Row title={title} right={<Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: t.accent, false: t.border }} />} />;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginStart: space.lg }} />;
}

export function Center({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md }}>{children}</View>;
}

export function Logo({ size = 64 }: { size?: number }) {
  // The mark: an open, C-shaped speech bubble with a dot at its centre (§6.4).
  const t = useTheme();
  const ring = size * 0.14;
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.24, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.6, height: size * 0.6, borderRadius: size * 0.3, borderWidth: ring, borderColor: '#fff', borderEndColor: 'transparent', borderBottomEndRadius: size * 0.06, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-35deg' }] }}>
        <View style={{ width: size * 0.13, height: size * 0.13, borderRadius: size, backgroundColor: '#5FD3A8' }} />
      </View>
    </View>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  if (!children) return null;
  return <Text style={{ color: t.danger, fontSize: 14 }}>{children}</Text>;
}
