---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '67599192-cd6f-457a-abcb-8b734f70f548'
  PropagateID: '67599192-cd6f-457a-abcb-8b734f70f548'
  ReservedCode1: 'f62fcc84-514e-4533-a2a0-cad2e674cb22'
  ReservedCode2: 'f62fcc84-514e-4533-a2a0-cad2e674cb22'
---

# 抽象 User 模型与 Repository

`db.js` 里用户数据操作与校验逻辑散落混编。请重构为模型 + 仓储两层：

- `models/user.js`：`createUser(input)` 工厂（name 必填、email 必填、role 默认 `member`；构造时校验，非法抛错）；`toSafe(user)` 返回去掉 `password` 字段的副本
- `repo/user-repo.js`：`UserRepository`（`create / findById / list / clear`），内部持有数组，`create` 存入 `toSafe` 后的完整用户（含自增 id）
- 保持 `db.js` 对外导出 `registerUser(input)`（用以上两层实现，返回新用户的安全视图）

> AI生成