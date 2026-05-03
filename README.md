# Multi Chat Lore Proxy

这个扩展的目标不是让 SillyTavern 原生支持“多个 chat lorebook 绑定”，而是做一层兼容代理：

- 聊天实际上只绑定 1 本锚点 lorebook。
- 其他脚本创建或绑定的 chat lorebook 会被登记成“源书”。
- 扩展把所有源书条目镜像进锚点书里，所以最终同一聊天里可以同时生效。

## 兼容思路

- `getChatWorldbookName('current')`
  - 返回“脚本视角”的当前源书名，而不是内部锚点书名。
  - 这样脚本做 `if (!getChatWorldbookName('current')) fallback/give up` 时，不会因为只看到代理锚点而误判。
- `getOrCreateChatWorldbook('current')`
  - 若已有脚本视角源书，返回该源书。
  - 若当前没有源书，则自动创建一个普通源书并接入代理，再返回这个源书名。
- `getOrCreateChatWorldbook('current', 'BookA')`
  - 把 `BookA` 登记为源书，并返回 `BookA`。
- `rebindChatWorldbook('current', 'BookB')`
  - 不再替换旧 chat lorebook，而是把 `BookB` 追加成源书，并把脚本视角当前源书切换到 `BookB`。
- 旧接口 `getChatLorebook` / `setChatLorebook` / `getOrCreateChatLorebook`
  - 也会一起代理。

## 防覆盖机制

- 扩展会持续检查 `TavernHelper` 的聊天世界书接口是否被后加载脚本覆盖。
- 如果检测到覆盖，会自动重新挂接代理函数。
- 扩展也会轮询 `chat_metadata.world_info`：
  - 如果脚本绕过 TavernHelper 直接把聊天世界书改成 `BookX`，扩展会把 `BookX` 自动接入源书列表。
  - 然后重新把实际聊天绑定恢复为代理锚点书。

## 当前限制

- SillyTavern UI 里看到的 chat lorebook 仍然会是锚点书，而不是多个名字。
- 如果有脚本直接写入 `chat_metadata.world_info` 后立刻在同一个同步 tick 内读取，可能会短暂读到它刚写入的值；绑定守卫通常会在约 1.2 秒内接管并修正。
- 从 ST 原生 UI 直接删除源书时，不一定能立刻收到删除事件；下一次聊天切换、世界书同步或删除接口调用时会自动清理失效源书。
