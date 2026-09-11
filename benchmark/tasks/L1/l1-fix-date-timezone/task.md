---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '5ca7ee10-7beb-40f7-aedb-4da1b7f74da4'
  PropagateID: '5ca7ee10-7beb-40f7-aedb-4da1b7f74da4'
  ReservedCode1: '58dada16-5682-4966-aeae-9dcf47be34ba'
  ReservedCode2: '58dada16-5682-4966-aeae-9dcf47be34ba'
---

# 修复日期格式化的时区错误

`utils/date.js` 中的 `formatDate(date)` 用于把日期显示给本地用户，但它混用了 UTC 取值方法，导致显示的时间与用户本地时间不符。

请修复这个 bug：`formatDate` 应按**本地时间**输出 `YYYY-MM-DD HH:mm` 格式。

要求：
- 不要改动函数签名与输出格式

> AI生成