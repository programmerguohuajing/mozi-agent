---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '088a7f91-af9a-495d-80d0-a6749605cfff'
  PropagateID: '088a7f91-af9a-495d-80d0-a6749605cfff'
  ReservedCode1: 'bfd3e2c6-b676-4f0b-9c66-9adcf2f24168'
  ReservedCode2: 'bfd3e2c6-b676-4f0b-9c66-9adcf2f24168'
---

# 搭建 i18n 基础

`messages.js` 硬编码中文文案，无法支持多语言。请搭建最小 i18n：

- `locales/zh.js`：`export default { greeting: '你好, {name}', farewell: '再见' }`
- `locales/en.js`：`export default { greeting: 'Hello, {name}', farewell: 'Goodbye' }`
- `i18n.js`：`t(key, lang = 'zh', params = {})` —— 取对应语言文案；`{placeholder}` 用 params 插值；key 缺失时回退中文；中文也缺则返回 key 本身
- `messages.js` 改为基于 `t()` 的 `greeting(name, lang)` / `farewell(lang)`（保持导出名）

> AI生成