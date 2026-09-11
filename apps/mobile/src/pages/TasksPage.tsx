/**
 * 定时任务页（M4.75 / M14 §14.8⑤）：任务列表 / 手动触发 / 启停开关。
 * 权限门禁：triggerTasks（§14.5，默认开）；节点侧仍按 cron 计划自动推进。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
import { fmtTime, useMoziClient } from '../hooks/useMoziClient';
import type { TaskPageItem } from '../client';
import { Badge, Btn, Card, Empty } from './ui';

export function TasksPage(): React.ReactElement {
  const store = useMoziClient();
  const { connected, tasks, error } = store.state;
  const [acting, setActing] = React.useState<string | null>(null);
  const canTrigger = store.state.permissions?.triggerTasks ?? true;

  if (!connected) return <Empty text="尚未连接节点\n请先在「配对」页完成配对" />;

  async function run(t: TaskPageItem): Promise<void> {
    setActing(t.taskId);
    try {
      await store.runTask(t.taskId);
    } catch {
      /* store.error 展示 */
    } finally {
      setActing(null);
    }
  }

  async function toggle(t: TaskPageItem): Promise<void> {
    setActing(t.taskId);
    try {
      await store.setTaskEnabled(t.taskId, !t.enabled);
    } catch {
      /* store.error 展示 */
    } finally {
      setActing(null);
    }
  }

  return (
    <View>
      {tasks.length === 0 ? <Empty text="节点上暂无定时任务" /> : null}
      {tasks.map((t) => (
        <Card key={t.taskId}>
          <View style={taskStyles.head}>
            <View style={taskStyles.titleWrap}>
              <Text style={taskStyles.name} numberOfLines={1}>
                {t.name}
              </Text>
              <Text style={taskStyles.sub} numberOfLines={1}>
                {t.taskId}
              </Text>
            </View>
            <Badge label={t.enabled ? '已启用' : '已停用'} tone={t.enabled ? 'green' : 'gray'} />
          </View>
          <View style={taskStyles.meta}>
            <Text style={taskStyles.metaText}>下次运行：{t.nextRunAt ? fmtTime(t.nextRunAt) : '—'}</Text>
            <Text style={taskStyles.metaText}>上次状态：{t.lastStatus ?? '—'}</Text>
          </View>
          <View style={taskStyles.btnRow}>
            <Btn label="▶ 立即运行" kind="primary" small disabled={acting === t.taskId || !canTrigger} onPress={() => void run(t)} />
            <Btn
              label={t.enabled ? '停用' : '启用'}
              small
              disabled={acting === t.taskId || !canTrigger}
              onPress={() => void toggle(t)}
            />
          </View>
        </Card>
      ))}
      {!canTrigger ? <Text style={taskStyles.denied}>本设备无 triggerTasks 权限（§14.5）</Text> : null}
      {error ? <Text style={taskStyles.error}>{error}</Text> : null}
    </View>
  );
}

const taskStyles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  titleWrap: { flex: 1 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm, marginBottom: spacing.md },
  metaText: { color: colors.textDim, fontSize: 12 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  denied: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
});
