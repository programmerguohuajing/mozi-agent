---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'ee400389-4078-4fb8-b791-4511738be3e5'
  PropagateID: 'ee400389-4078-4fb8-b791-4511738be3e5'
  ReservedCode1: '4e68137e-8f3d-4561-9ea8-99870ede3713'
  ReservedCode2: '4e68137e-8f3d-4561-9ea8-99870ede3713'
---

# @mozi/mobile — 移动端客户端

Expo / React Native 客户端（M4.75 / M14 §14.8）。

## 当前状态

传输无关核心已全部落地于 `@mozi/protocol`（远程协议/设备信任/E2E 加密/节点服务）与
`@mozi/relay-server`（零内容中继）。本目录当前为**类型规范骨架**：
`src/client.ts` 定义客户端抽象与六页视图模型（配对/会话列表/会话视图/审批收件箱/
定时任务/设备管理），`pnpm typecheck` 可 `tsc --noEmit` 通过。

## 接入真实 UI 的步骤

1. `pnpm i` 安装 Expo / react-native / @react-native-async-storage 等依赖；
2. 用 `@mozi/protocol` 的 RemoteFrame/RemotePush 与 `RemoteClient` 实现 WSS 传输
   （Node 全局 WebSocket / RN 的 WebSocket）；
3. 将 `src/client.ts` 的视图模型映射为 RN 组件（页面 ①-⑥）。

## 协议零分叉

移动端协议 = 桌面 IPC 协议（`@mozi/protocol` 单一通道语义），三传输适配器
（Electron IPC / 进程内 / WSS）行为一致，见 M14 §14.2-14.3。

> AI生成