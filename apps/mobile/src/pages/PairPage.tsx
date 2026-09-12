/**
 * 配对页（M4.75 / M14 §14.8①）：输入节点地址 + 6 位配对码 + 设备名 → 配对连接。
 * 已有保存凭证时支持免配对码快速重连（auth 流程）；连接后展示本机权限摘要。
 */
import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '../theme';
import { useMoziClient } from '../hooks/useMoziClient';
import { Badge, Btn, Card, CardTitle, Row, SectionLabel } from './ui';

const DEFAULT_URL = 'ws://localhost:8787';

export function PairPage(): React.ReactElement {
  const store = useMoziClient();
  const { connected, deviceId, deviceName, permissions, connState } = store.state;
  const [url, setUrl] = React.useState(DEFAULT_URL);
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState(deviceName);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const hasSaved = store.hasSavedCredentials();

  async function doPair(): Promise<void> {
    if (!/^\d{6}$/.test(code)) {
      setErr('请输入 6 位数字配对码');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await store.connect({ url: url.trim() || DEFAULT_URL, pairingCode: code, deviceName: name.trim() || 'Mozi 移动端' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doReconnect(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await store.reconnect();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (connected && deviceId) {
    return (
      <View>
        <Card>
          <View style={pairStyles.okHead}>
            <Text style={pairStyles.okMark}>✓</Text>
            <View>
              <CardTitle>{deviceName}</CardTitle>
              <Text style={pairStyles.okSub}>已连接到 Mozi 节点</Text>
            </View>
          </View>
          <Row label="设备 ID" value={deviceId} />
          <Row label="连接状态" value="已认证（auth-ok）" />
        </Card>

        <SectionLabel>本机权限（§14.5 设备权限模型）</SectionLabel>
        <Card>
          <Row label="查看会话" value={permissions?.viewSessions ? '允许' : '拒绝'} />
          <Row label="浏览工作区文件" value={permissions?.viewWorkspaceFiles ? '允许' : '拒绝'} dim={!permissions?.viewWorkspaceFiles} />
          <Row label="下发任务" value={permissions?.sendMessage ? '允许' : '拒绝'} />
          <Row
            label="审批权"
            value={
              permissions?.approveRequests === 'all'
                ? '全部（high 仍需节点侧冷静期）'
                : permissions?.approveRequests === 'standard'
                  ? '标准（high 转交桌面）'
                  : '无（一律拒绝）'
            }
          />
          <Row label="触发定时任务" value={permissions?.triggerTasks ? '允许' : '拒绝'} />
          <Row label="管理其他设备" value={permissions?.manageDevices ? '允许' : '拒绝'} dim={!permissions?.manageDevices} />
          <Row label="切换策略/沙箱" value={permissions?.changePolicy ? '允许' : '拒绝'} dim={!permissions?.changePolicy} />
        </Card>

        <Btn label="断开连接并遗忘本设备" kind="danger" onPress={() => store.logout()} />
      </View>
    );
  }

  return (
    <View>
      {connState === 'revoked' ? (
        <Card>
          <Badge label="设备已被吊销" tone="red" />
          <Text style={pairStyles.hint}>该设备凭证已失效，请重新配对。</Text>
        </Card>
      ) : null}

      <Card>
        <CardTitle>连接到 Mozi 节点</CardTitle>
        <Text style={pairStyles.label}>节点地址</Text>
        <TextInput
          style={pairStyles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="ws://localhost:8787"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={pairStyles.label}>配对码（桌面端「远程访问」生成，5 分钟内有效）</Text>
        <TextInput
          style={[pairStyles.input, pairStyles.codeInput]}
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          placeholderTextColor={colors.textFaint}
          keyboardType="number-pad"
          maxLength={6}
        />
        <Text style={pairStyles.label}>设备名称</Text>
        <TextInput
          style={pairStyles.input}
          value={name}
          onChangeText={setName}
          placeholder="我的手机"
          placeholderTextColor={colors.textFaint}
        />
        <View style={pairStyles.btnRow}>
          <Btn label={busy ? '连接中…' : '配对连接'} kind="primary" onPress={() => void doPair()} disabled={busy || code.length !== 6} />
        </View>
        {hasSaved ? (
          <View style={pairStyles.btnRow}>
            <Btn label="免配对码快速重连" onPress={() => void doReconnect()} disabled={busy} />
          </View>
        ) : null}
        {err ? <Text style={pairStyles.error}>{err}</Text> : null}
      </Card>

      <Text style={pairStyles.hint}>
        配对流程（§14.4）：桌面端生成 6 位码 → 手机提交 → 节点返回 deviceId/token → auth 认证 → 订阅事件流。全程 token 只存本机，吊销即时生效。
      </Text>
    </View>
  );
}

const pairStyles = StyleSheet.create({
  okHead: { flexDirection: 'row', gap: spacing.md, alignItems: 'center', marginBottom: spacing.md },
  okMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(52,211,153,0.18)',
    color: colors.success,
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 22,
    fontWeight: '900',
  },
  okSub: { color: colors.textDim, fontSize: 12 },
  label: { color: colors.textDim, fontSize: 12, marginTop: spacing.sm, marginBottom: 4 },
  input: {
    backgroundColor: colors.bgBase,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: 14,
  },
  codeInput: { fontSize: 22, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
  btnRow: { marginTop: spacing.md },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  hint: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: spacing.lg },
});
