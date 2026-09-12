/**
 * 审批收件箱页（M4.75 / M14 §14.8④ / §14.5）。
 * 分级：standard 权限下 safe/side-effect/network 可直接批准；high 级只能「转交桌面」
 * （服务端 approval:resolve 对 high 返回 ERR_DEFER，UI 不提供远程批准入口）。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
import { useMoziClient } from '../hooks/useMoziClient';
import type { ApprovalTicket } from '../hooks/useMoziClient';
import { Badge, Btn, Card, CardTitle, Empty, SectionLabel } from './ui';

const RISK_BADGE: Record<ApprovalTicket['risk'], { label: string; tone: 'green' | 'gold' | 'blue' | 'red' }> = {
  safe: { label: 'safe', tone: 'green' },
  'side-effect': { label: 'side-effect', tone: 'gold' },
  network: { label: 'network', tone: 'blue' },
  high: { label: 'high', tone: 'red' },
};

export function ApprovalsPage(): React.ReactElement {
  const store = useMoziClient();
  const { connected, approvals, error } = store.state;
  const [deferred, setDeferred] = React.useState<string[]>([]);
  const [acting, setActing] = React.useState<string | null>(null);

  if (!connected) return <Empty text="尚未连接节点\n请先在「配对」页完成配对" />;

  const pending = approvals.filter((t) => t.decision === null && !deferred.includes(t.callId));
  const resolved = approvals.filter((t) => t.decision !== null);

  async function act(ticket: ApprovalTicket, decision: 'allow' | 'deny'): Promise<void> {
    setActing(ticket.callId);
    try {
      await store.resolveApproval(ticket, decision);
    } catch {
      /* 错误已写入 store.error，页面底部展示 */
    } finally {
      setActing(null);
    }
  }

  return (
    <View>
      <SectionLabel>待处理（{pending.length}）</SectionLabel>
      {pending.length === 0 ? <Empty text="审批收件箱为空\n高危操作仍会实时推送" /> : null}
      {pending.map((t) => {
        const rb = RISK_BADGE[t.risk] ?? RISK_BADGE.safe!;
        const high = t.risk === 'high';
        return (
          <Card key={t.callId}>
            <View style={apprStyles.head}>
              <CardTitle>{t.callName}</CardTitle>
              {t.agentType ? <Badge label={`子智能体 ${t.agentType}`} tone="blue" /> : null}
            </View>
            <View style={apprStyles.badgeRow}>
              <Badge label={`风险 ${rb.label}`} tone={rb.tone} />
              <Text style={apprStyles.sess}>{t.sessionId.slice(0, 18)}</Text>
            </View>
            {t.summary ? <Text style={apprStyles.summary} numberOfLines={3}>{t.summary}</Text> : null}
            {high ? (
              <View style={apprStyles.highNote}>
                <Text style={apprStyles.highNoteText}>
                  ⚠ 高危操作：移动端无权批准（§14.5），将在桌面端冷静期后处理。
                </Text>
              </View>
            ) : null}
            <View style={apprStyles.btnRow}>
              {high ? (
                <Btn label="转交桌面" kind="ghost" small disabled={acting === t.callId} onPress={() => setDeferred([...deferred, t.callId])} />
              ) : (
                <>
                  <Btn label="批准" kind="success" small disabled={acting === t.callId} onPress={() => void act(t, 'allow')} />
                  <Btn label="拒绝" kind="danger" small disabled={acting === t.callId} onPress={() => void act(t, 'deny')} />
                </>
              )}
            </View>
          </Card>
        );
      })}

      {resolved.length > 0 ? (
        <View>
          <SectionLabel>已处理（{resolved.length}）</SectionLabel>
          {resolved.map((t) => (
            <Card key={t.callId}>
              <View style={apprStyles.head}>
                <Text style={[apprStyles.resolvedName, t.decision === 'deny' ? apprStyles.denied : null]}>{t.callName}</Text>
                <Badge label={t.decision === 'allow' ? '已批准' : '已拒绝'} tone={t.decision === 'allow' ? 'green' : 'red'} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {error ? <Text style={apprStyles.error}>{error}</Text> : null}
    </View>
  );
}

const apprStyles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4, marginBottom: spacing.sm },
  sess: { color: colors.textFaint, fontSize: 11 },
  summary: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: undefined,
    backgroundColor: colors.bgBase,
    borderRadius: 6,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    lineHeight: 17,
  },
  highNote: {
    backgroundColor: 'rgba(251,113,133,0.12)',
    borderRadius: 6,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  highNoteText: { color: colors.danger, fontSize: 11, lineHeight: 16 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  resolvedName: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  denied: { textDecorationLine: 'line-through' },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
});
