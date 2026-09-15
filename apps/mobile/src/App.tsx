import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
/**
 * Mozi 移动端 App 主入口（M4.75 / M14 §14.8）。
 *
 * 六页导航：配对 → 会话列表 → 会话视图（事件流） → 审批收件箱 → 定时任务 → 设备管理。
 * 底部 Tab 栏 + 顶部连接状态条；深色金色主题与桌面端一致。
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMoziClient } from './hooks/useMoziClient';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { DevicePage } from './pages/DevicePage';
import { PairPage } from './pages/PairPage';
import { SessionsPage } from './pages/SessionsPage';
import { TasksPage } from './pages/TasksPage';
import { colors } from './theme';

type TabKey = 'pair' | 'sessions' | 'approvals' | 'tasks' | 'device';

const TABS: Array<{ key: TabKey; icon: string; label: string }> = [
  { key: 'pair', icon: '🔗', label: '配对' },
  { key: 'sessions', icon: '💬', label: '会话' },
  { key: 'approvals', icon: '⚠', label: '审批' },
  { key: 'tasks', icon: '⏰', label: '任务' },
  { key: 'device', icon: '📱', label: '设备' },
];

export default function App(): React.ReactElement {
  const client = useMoziClient();
  const [tab, setTab] = React.useState<TabKey>('pair');

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {/* 顶栏 */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>M</Text>
          </View>
          <Text style={styles.title}>
            {
              {
                pair: '配对',
                sessions: '会话',
                approvals: '审批收件箱',
                tasks: '定时任务',
                device: '设备管理',
              }[tab]
            }
          </Text>
        </View>
        {client.state.connected ? (
          <View style={styles.connBadge}>
            <View style={[styles.connDot, client.state.busy && styles.connDotPulse]} />
            <Text style={styles.connText}>
              已连接{client.deviceId ? ` · ${client.deviceId.slice(0, 12)}` : ''}
            </Text>
          </View>
        ) : null}
      </View>

      {/* 内容区 */}
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {tab === 'pair' ? <PairPage /> : null}
        {tab === 'sessions' ? <SessionsPage /> : null}
        {tab === 'approvals' ? <ApprovalsPage /> : null}
        {tab === 'tasks' ? <TasksPage /> : null}
        {tab === 'device' ? <DevicePage /> : null}
      </ScrollView>

      {/* 底部 Tab */}
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Text
            key={t.key}
            style={[styles.tab, tab === t.key ? styles.tabActive : null]}
            onPress={() => setTab(t.key)}
          >
            <Text style={styles.tabIcon}>{t.icon}</Text>
            {'\n'}
            {t.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: 'rgba(10,16,24,0.70)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,229,199,0.12)',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  logoText: { color: colors.primary, fontWeight: '900', fontSize: 15 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  connBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(52,211,153,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.25)',
  },
  connDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.emerald,
    shadowColor: colors.emerald,
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  connDotPulse: { backgroundColor: colors.primary },
  connText: { color: colors.emerald, fontSize: 12, fontWeight: '600' },
  content: { flex: 1 },
  contentInner: { padding: 16, paddingBottom: 40 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(10,16,24,0.82)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,229,199,0.12)',
    paddingTop: 8,
    paddingBottom: 24,
  },
  tab: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    color: colors.textFaint,
    textAlignVertical: 'center',
  },
  tabActive: {
    color: colors.primary,
    fontWeight: '700',
    textShadowColor: 'rgba(0,229,199,0.5)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 0 },
  },
  tabIcon: { fontSize: 20, textAlignVertical: 'center' },
});

// Expo web 入口：注册根组件 → 内部经 createRoot 挂载到 #root。
registerRootComponent(App);
