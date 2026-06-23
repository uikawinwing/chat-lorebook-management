# Chat Lore Sources

这个扩展让**当前聊天**可以记录多本来源世界书，并在生成期间临时把它们加入 SillyTavern 的全局世界书选择。

它不再做 proxy lorebook，也不再接管 TavernHelper。

## 工作方式

当前聊天保存：

```js
chat_metadata.multi_chat_lore_sources = {
  version: 1,
  sources: ['Book A', 'Book B', 'Book C'],
  updatedAt: 1782150000000,
};
```

生成时：

```text
GENERATION_AFTER_COMMANDS
  临时 selected_world_info += Book A / Book B / Book C

SillyTavern 原生 getWorldInfoPrompt()
  正常扫描这些世界书

GENERATE_AFTER_COMBINE_PROMPTS / GENERATION_STOPPED / GENERATION_ENDED / CHAT_CHANGED
  恢复 selected_world_info 原值
```

因此 ST 原生世界书规则仍然生效，包括关键词、插入顺序、位置、概率、递归、sticky、cooldown、delay、group 和角色过滤等。

如果当前聊天已经绑定原生 chat lorebook，它仍由 `chat_metadata.world_info` 管理。面板会显示这本书，并从可添加来源里排除；生成时也不会把它重复注入到 `selected_world_info`。

## 不做什么

- 不创建 `__mclp__` 代理世界书
- 不创建每个聊天自己的锚点书
- 不创建共享 scratch 世界书
- 不修改 `chat_metadata.world_info`
- 不在搜索或添加时自动创建缺失的世界书；只有用户点击“新建空书”才会创建
- 不 patch TavernHelper
- 不持久化临时 `selected_world_info`

## 使用方式

在扩展菜单打开“多聊天世界书来源”，用搜索栏为当前聊天添加已有世界书。

如果确实需要一本新的空世界书，可以输入名称后点击“新建空书”。这会调用 SillyTavern 原生 `createNewWorldInfo()` 创建空书，并自动加入当前聊天来源列表。

也可以从控制台或其他脚本调用：

```js
await ChatLoreSources.add('Book A');
await ChatLoreSources.add('Book B');
await ChatLoreSources.create('New Empty Book');

ChatLoreSources.list();

await ChatLoreSources.remove('Book A');
await ChatLoreSources.clear();
```

## 给 TavernHelper 脚本的用法

TavernHelper 可以作为薄入口调用这个扩展，但不要把核心逻辑写在 TavernHelper 里：

```js
await window.ChatLoreSources.add('Book A');
```

扩展本身负责保存聊天 metadata、生成期间临时注入、以及恢复 ST 状态。

## 限制

- “添加已有”要求来源书已经存在；输入不存在的名字会被拒绝。
- “新建空书”是显式操作，会创建全局世界书文件，然后加入当前聊天来源列表。
- 扩展只在生成窗口里临时修改 `selected_world_info`，不会改变用户原本勾选的全局世界书设置。
- 如果 SillyTavern 未来调整生成事件顺序，需要重新验证 `GENERATION_AFTER_COMMANDS` 仍然早于 `getWorldInfoPrompt()`。
