/**
 * 设备管理页（M4.75 / M14 §14.8⑥）：本机信息 + 已配对设备列表（重命名 / 吊销）。
 * 权限门禁：manageDevices（§14.5，默认关）；吊销后目标设备 token 即时失效。
 */
import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '../theme';
import { fmtTime, useMoziClient } from '../hooks/useMoziClient';
import type { DevicePageItem } from '../client';
import { Badge, Btn, Card, CardTitle, Empty, Row, SectionLabel } from './ui';

export function DevicePage(): React.ReactElement {
  const store = useMoziClient();
  const { connected, devices, deviceId, deviceName } = store.state;
  const canManage = store.state.permissions?.manageDevices ?? false;
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [acting, setActing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (!connected || !deviceId) return <Empty text="尚未连接节点\n请先在「配对」页完成配对" />;

  const self = devices.find((d) => d.deviceId === deviceId);
  const others = devices.filter((d) => d.deviceId !== deviceId);

  async function doRename(d: DevicePageItem): Promise<void> {
    const name = renameDraft.trim();
    setActing(d.deviceId);
    setError(null);
    try {
      if (name) await store.renameDevice(d.deviceId, name);
      setRenaming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function doRevoke(d: DevicePageItem): Promise<void> {
    setActing(d.deviceId);
    setError(null);
    try {
      await store.revokeDevice(d.deviceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  return (
    <View>
      <SectionLabel>本机</SectionLabel>
      <Card>
        <CardTitle>{deviceName}</CardTitle>
        <Row label="设备 ID" value={deviceId} />
        <Row label="平台" value={self?.platform ?? 'web'} />
        <Row label="配对时间" value={fmtTime(self?.lastSeenAt)} dim />
      </Card>

      <SectionLabel>已配对设备（{others.length}）</SectionLabel>
      {others.length === 0 ? <Empty text="暂无其他已配对设备" /> : null}
      {others.map((d) => (
        <Card key={d.deviceId}>
          <View style={devStyles.head}>
            <View style={devStyles.titleWrap}>
              <Text style={[devStyles.name, d.revokedAt ? devStyles.revokedName : null]} numberOfLines={1}>
                {d.name}
              </Text>
              <Text style={devStyles.sub} numberOfLines={1}>
                {[d.platform, d.deviceId].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {d.revokedAt ? (
              <Badge label="已吊销" tone="red" />
            ) : (
              <Badge label="活跃" tone="green" />
            )}
          </View>
          <Text style={devStyles.seen}>最近活跃：{d.lastSeenAt ? fmtTime(d.lastSeenAt) : '—'}</Text>

          {renaming === d.deviceId ? (
            <View style={devStyles.renameRow}>
              <TextInput
                style={devStyles.renameInput}
                value={renameDraft}
                onChangeText={setRenameDraft}
                placeholder="新名称"
                placeholderTextColor={colors.textFaint}
                autoFocus
              />
              <Btn label="保存" kind="primary" small disabled={acting === d.deviceId} onPress={() => void doRename(d)} />
              <Btn label="取消" small onPress={() => setRenaming(null)} />
            </View>
          ) : (
            <View style={devStyles.btnRow}>
              {canManage ? (
                <>
                  <Btn
                    label="重命名"
                    small
                    disabled={acting === d.deviceId || !!d.revokedAt}
                    onPress={() => {
                      setRenaming(d.deviceId);
                      setRenameDraft(d.name);
                    }}
                  />
                  <Btn label="吊销" kind="danger" small disabled={acting === d.deviceId || !!d.revokedAt} onPress={() => void doRevoke(d)} />
                </>
              ) : null}
            </View>
          )}
        </Card>
      ))}

      {!canManage ? (
        <Text style={devStyles.denied}>
          本设备无 manageDevices 权限（§14.5 默认关），如需管理其他设备请在桌面端为本机授权。
        </Text>
      ) : null}
      {error ? <Text style={devStyles.error}>{error}</Text> : null}
    </View>
  );
}

const devStyles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  titleWrap: { flex: 1 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  revokedName: { color: colors.textFaint, textDecorationLine: 'line-through' },
  sub: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
  seen: { color: colors.textDim, fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.md },
  btnRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  renameRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  renameInput: {
    flex: 1,
    backgroundColor: '#0d0d18',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    fontSize: 13,
  },
  denied: { color: colors.textFaint, fontSize: 11, marginTop: spacing.md, lineHeight: 16 },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
});
