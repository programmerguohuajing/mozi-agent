/**
 * 页面级共享小组件（卡片 / 徽标 / 按钮 / 空态）——深色金色主题。
 */
import type React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export function Card({
  children,
  style,
}: { children: React.ReactNode; style?: object }): React.ReactElement {
  return <View style={[uiStyles.card, style]}>{children}</View>;
}

export function CardTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <Text style={uiStyles.cardTitle}>{children}</Text>;
}

export function Row({
  label,
  value,
  dim,
}: {
  label: string;
  value: React.ReactNode;
  dim?: boolean;
}): React.ReactElement {
  return (
    <View style={uiStyles.row}>
      <Text style={uiStyles.rowLabel}>{label}</Text>
      <Text style={[uiStyles.rowValue, dim ? uiStyles.rowValueDim : null]}>{value}</Text>
    </View>
  );
}

const BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  gold: { bg: 'rgba(245,166,35,0.14)', fg: colors.amber },
  green: { bg: 'rgba(52,211,153,0.14)', fg: colors.emerald },
  red: { bg: 'rgba(251,113,133,0.14)', fg: colors.rose },
  blue: { bg: 'rgba(0,229,199,0.12)', fg: colors.primary },
  gray: { bg: 'rgba(123,143,168,0.12)', fg: colors.textDim },
};

export function Badge({
  label,
  tone = 'gray',
}: { label: string; tone?: keyof typeof BADGE_COLORS }): React.ReactElement {
  const c = BADGE_COLORS[tone] ?? BADGE_COLORS.gray!;
  return (
    <View style={[uiStyles.badge, { backgroundColor: c.bg }]}>
      <Text style={[uiStyles.badgeText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

type BtnKind = 'primary' | 'ghost' | 'success' | 'danger';

export function Btn({
  label,
  onPress,
  kind = 'ghost',
  disabled,
  small,
}: {
  label: string;
  onPress: () => void;
  kind?: BtnKind;
  disabled?: boolean;
  small?: boolean;
}): React.ReactElement {
  const kindStyle =
    kind === 'primary'
      ? uiStyles.btnPrimary
      : kind === 'success'
        ? uiStyles.btnSuccess
        : kind === 'danger'
          ? uiStyles.btnDanger
          : uiStyles.btnGhost;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        uiStyles.btn,
        small ? uiStyles.btnSmall : null,
        kindStyle,
        disabled ? uiStyles.btnDisabled : null,
      ]}
    >
      <Text
        style={[
          uiStyles.btnText,
          kind === 'ghost' ? uiStyles.btnTextGhost : null,
          small ? { fontSize: 12 } : null,
          disabled ? uiStyles.btnTextDisabled : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Empty({ text }: { text: string }): React.ReactElement {
  return (
    <View style={uiStyles.empty}>
      <Text style={uiStyles.emptyText}>{text}</Text>
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <Text style={uiStyles.section}>{children}</Text>;
}

export const uiStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.glass,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,229,199,0.10)',
    padding: spacing.lg,
    marginBottom: spacing.md,
    shadowColor: colors.primary,
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  rowLabel: { color: colors.textDim, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  rowValueDim: { color: colors.textFaint },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  btn: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 10 },
  btnDisabled: { opacity: 0.4 },
  btnPrimary: {
    backgroundColor: colors.primary,
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  btnSuccess: {
    backgroundColor: 'rgba(52,211,153,0.16)',
    borderWidth: 1,
    borderColor: colors.emerald,
  },
  btnDanger: {
    backgroundColor: 'rgba(251,113,133,0.16)',
    borderWidth: 1,
    borderColor: colors.rose,
  },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.cardBorder },
  btnText: { color: '#04121a', fontSize: 14, fontWeight: '700' },
  btnTextGhost: { color: colors.text },
  btnTextDisabled: { color: colors.textFaint },
  empty: { alignItems: 'center', padding: spacing.xl * 2 },
  emptyText: { color: colors.textFaint, fontSize: 13, textAlign: 'center' },
  section: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
});
