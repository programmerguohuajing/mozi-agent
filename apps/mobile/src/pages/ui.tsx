/**
 * 页面级共享小组件（卡片 / 徽标 / 按钮 / 空态）——深色金色主题。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export function Card({ children, style }: { children: React.ReactNode; style?: object }): React.ReactElement {
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
  gold: { bg: '#3a2f14', fg: colors.primary },
  green: { bg: '#1e3320', fg: colors.success },
  red: { bg: '#3a1e1e', fg: colors.danger },
  blue: { bg: '#1e2a3a', fg: '#6fa8cf' },
  gray: { bg: '#26262e', fg: colors.textDim },
};

export function Badge({ label, tone = 'gray' }: { label: string; tone?: keyof typeof BADGE_COLORS }): React.ReactElement {
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
    kind === 'primary' ? uiStyles.btnPrimary : kind === 'success' ? uiStyles.btnSuccess : kind === 'danger' ? uiStyles.btnDanger : uiStyles.btnGhost;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[uiStyles.btn, small ? uiStyles.btnSmall : null, kindStyle, disabled ? uiStyles.btnDisabled : null]}
    >
      <Text style={[uiStyles.btnText, kind === 'ghost' ? uiStyles.btnTextGhost : null, small ? { fontSize: 12 } : null, disabled ? uiStyles.btnTextDisabled : null]}>
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
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.md,
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
  btnPrimary: { backgroundColor: colors.primary },
  btnSuccess: { backgroundColor: '#2a4a2a', borderWidth: 1, borderColor: colors.success },
  btnDanger: { backgroundColor: '#3a1e1e', borderWidth: 1, borderColor: colors.danger },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.cardBorder },
  btnText: { color: '#0a0a0a', fontSize: 14, fontWeight: '700' },
  btnTextGhost: { color: colors.text },
  btnTextDisabled: { color: colors.textFaint },
  empty: { alignItems: 'center', padding: spacing.xl * 2 },
  emptyText: { color: colors.textFaint, fontSize: 13, textAlign: 'center' },
  section: { color: colors.textFaint, fontSize: 12, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
});
