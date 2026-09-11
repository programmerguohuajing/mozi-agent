/**
 * 会话页（M4.75 / M14 §14.8②③）：会话列表 → 会话视图（实时事件流）。
 * 列表项点击 attach 订阅（断线重连按 lastEventId 续传）；底部输入框 run:start 下发任务。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AgentEvent } from '@mozi/shared';
import type { SessionState, SessionSummary } from '@mozi/protocol';
import { colors, spacing } from '../theme';
import { fmtTime, useMoziClient } from '../hooks/useMoziClient';
import { Badge, Btn, Card, Empty } from './ui';

const STATE_LABEL: Record<SessionState, { label: string; tone: 'gold' | 'green' | 'red' | 'gray' | 'blue' }> = {
  idle: { label: '空闲', tone: 'gray' },
  running: { label: '运行中', tone: 'gold' },
  pending_approval: { label: '待审批', tone: 'blue' },
  completed: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
};

export function SessionsPage(): React.ReactElement {
  const store = useMoziClient();
  const { connected, sessions, activeSessionId, events, busy } = store.state;
  const [draft, setDraft] = React.useState('');

  if (!connected) return <Empty text="尚未连接节点\n请先在「配对」页完成配对" />;

  if (activeSessionId) {
    const session = sessions.find((s) => s.id === activeSessionId);
    return (
      <View style={sessStyles.detailWrap}>
        <View style={sessStyles.detailHead}>
          <Pressable onPress={() => store.closeSessionView()}>
            <Text style={sessStyles.backBtn}>‹ 返回</Text>
          </Pressable>
          <Text style={sessStyles.detailTitle} numberOfLines={1}>
            {session?.project ?? activeSessionId.slice(0, 14)}
          </Text>
          {busy ? <Badge label="运行中" tone="gold" /> : <Badge label="空闲" tone="gray" />}
        </View>

        <ScrollView style={sessStyles.stream}>
          {events.length === 0 ? <Empty text="等待节点事件…（已订阅该会话）" /> : null}
          {events.map((item) => (
            <EventBubble key={item.seq} event={item.event} />
          ))}
        </ScrollView>

        <View style={sessStyles.inputBar}>
          <TextInput
            style={sessStyles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={busy ? '任务运行中…' : '给 Mozi 下发任务'}
            placeholderTextColor={colors.textFaint}
            multiline
          />
          {busy ? (
            <Btn label="停止" kind="danger" small onPress={() => void store.abortRun()} />
          ) : (
            <Btn
              label="发送"
              kind="primary"
              small
              disabled={!draft.trim()}
              onPress={() => {
                const text = draft.trim();
                if (!text) return;
                setDraft('');
                void store.sendMessage(text);
              }}
            />
          )}
        </View>
      </View>
    );
  }

  return (
    <View>
      {sessions.length === 0 ? <Empty text="节点上暂无会话" /> : null}
      {sessions.map((s) => (
        <SessionRow key={s.id} summary={s} onOpen={() => void store.attachSession(s.id)} />
      ))}
    </View>
  );
}

function SessionRow({ summary, onOpen }: { summary: SessionSummary; onOpen: () => void }): React.ReactElement {
  const st = STATE_LABEL[summary.state] ?? STATE_LABEL.idle!;
  const tokens = summary.usage ? `${summary.usage.totalTokens.toLocaleString()} tok` : '';
  return (
    <Pressable onPress={onOpen}>
      <Card>
        <View style={sessStyles.rowHead}>
          <Text style={sessStyles.rowTitle} numberOfLines={1}>
            {summary.project ?? summary.id.slice(0, 18)}
          </Text>
          <Badge label={st.label} tone={st.tone} />
        </View>
        <Text style={sessStyles.rowSub} numberOfLines={1}>
          {[summary.model ?? '', summary.id].filter(Boolean).join(' · ')}
        </Text>
        <View style={sessStyles.rowFoot}>
          {tokens ? <Text style={sessStyles.rowMeta}>{tokens}</Text> : <Text style={sessStyles.rowMeta}>—</Text>}
          <Text style={sessStyles.rowMeta}>{fmtTime(summary.updatedAt)}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

/** 事件 → 气泡（穷举主要事件；未渲染类型降级为灰色类型行）。 */
function EventBubble({ event }: { event: AgentEvent }): React.ReactElement | null {
  switch (event.type) {
    case 'turn.started':
      return (
        <View style={[sessStyles.bubble, sessStyles.userBubble]}>
          <Text style={sessStyles.userText}>▶ {event.input}</Text>
        </View>
      );
    case 'message.delta':
      return (
        <View style={[sessStyles.bubble, sessStyles.aiBubble]}>
          <Text style={sessStyles.aiTextDim} numberOfLines={4}>
            {event.text}
          </Text>
        </View>
      );
    case 'message.completed':
      return (
        <View style={[sessStyles.bubble, sessStyles.aiBubble]}>
          <Text style={sessStyles.aiText}>{event.message.content ?? '（空回复）'}</Text>
        </View>
      );
    case 'tool.requested':
      return (
        <View style={sessStyles.chipRow}>
          <Badge label={`🔧 ${event.call.name}`} tone="gray" />
        </View>
      );
    case 'tool.approval.required':
      return (
        <View style={[sessStyles.bubble, sessStyles.warnBubble]}>
          <Text style={sessStyles.warnText}>⚠ {event.call.name} 需要审批（见「审批」页）</Text>
        </View>
      );
    case 'tool.started':
      return <Text style={sessStyles.sysText}>· {event.callId.slice(0, 12)} 执行中</Text>;
    case 'tool.completed':
      return (
        <Text style={event.result.isError ? sessStyles.errText : sessStyles.sysText}>
          {event.result.isError ? '✗ 工具执行失败' : '✓ 工具执行完成'}
        </Text>
      );
    case 'token.usage':
      return <Text style={sessStyles.sysText}>tokens: {event.usage.totalTokens.toLocaleString()}</Text>;
    case 'turn.completed':
      return <Text style={sessStyles.sysText}>轮次完成 · {event.usage.totalTokens.toLocaleString()} tok</Text>;
    case 'task.completed':
      return (
        <View style={[sessStyles.bubble, sessStyles.doneBubble]}>
          <Text style={sessStyles.doneText}>✓ 任务结束（{event.reason}）</Text>
        </View>
      );
    case 'session.started':
      return <Text style={sessStyles.sysText}>会话已启动</Text>;
    case 'session.resumed':
      return <Text style={sessStyles.sysText}>会话已恢复（重放 {event.replayedEvents} 事件）</Text>;
    case 'session.terminated':
      return <Text style={sessStyles.sysText}>会话已终止（{event.reason}）</Text>;
    case 'context.compacted':
      return <Text style={sessStyles.sysText}>上下文压缩：-{event.savedTokens.toLocaleString()} tok</Text>;
    case 'cost.warning':
      return (
        <View style={[sessStyles.bubble, sessStyles.warnBubble]}>
          <Text style={sessStyles.warnText}>💰 成本预警：{event.message}</Text>
        </View>
      );
    case 'error':
      return (
        <View style={[sessStyles.bubble, sessStyles.errBubble]}>
          <Text style={sessStyles.errText}>✗ {event.error.message}</Text>
        </View>
      );
    case 'subagent.started':
      return <Text style={sessStyles.sysText}>🤖 子智能体启动（{event.agentType}）</Text>;
    case 'subagent.progress':
      return <Text style={sessStyles.sysText}>🤖 子智能体 {event.step}/{event.maxSteps} {event.currentTool ? `· ${event.currentTool}` : ''}</Text>;
    case 'subagent.completed':
      return <Text style={sessStyles.sysText}>🤖 子智能体完成：{event.summary}</Text>;
    case 'subagent.failed':
      return <Text style={sessStyles.errText}>🤖 子智能体失败：{event.error.message}</Text>;
    default:
      return <Text style={sessStyles.sysText}>· {event.type}</Text>;
  }
}

const sessStyles = StyleSheet.create({
  detailWrap: { flex: 1, marginHorizontal: -spacing.lg },
  detailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  backBtn: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  detailTitle: { color: colors.text, fontSize: 14, fontWeight: '700', flex: 1 },
  stream: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  inputBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: '#0d0d18',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: 13,
    maxHeight: 96,
  },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  rowSub: { color: colors.textDim, fontSize: 12, marginTop: 4 },
  rowFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  rowMeta: { color: colors.textFaint, fontSize: 11 },
  bubble: { borderRadius: 10, padding: spacing.md, marginBottom: spacing.sm, maxWidth: '100%' },
  userBubble: { backgroundColor: '#1a2440', alignSelf: 'flex-end' },
  aiBubble: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  warnBubble: { backgroundColor: '#3a2f14', borderWidth: 1, borderColor: colors.primary },
  errBubble: { backgroundColor: '#3a1e1e', borderWidth: 1, borderColor: colors.danger },
  doneBubble: { backgroundColor: '#1e3320', borderWidth: 1, borderColor: colors.success },
  userText: { color: '#cfe0ff', fontSize: 13 },
  aiText: { color: colors.text, fontSize: 13, lineHeight: 20 },
  aiTextDim: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  warnText: { color: colors.primary, fontSize: 12 },
  errText: { color: colors.danger, fontSize: 12 },
  doneText: { color: colors.success, fontSize: 12 },
  sysText: { color: colors.textFaint, fontSize: 11, marginBottom: 6 },
  chipRow: { flexDirection: 'row', marginBottom: 6 },
});
