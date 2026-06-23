# 聊天世界书管理

这个 SillyTavern 扩展用于给每个聊天单独管理额外的世界书来源。

你可以在扩展菜单打开“聊天世界书管理”，为当前聊天添加已有世界书。之后生成回复时，扩展会临时把这些来源书加入本次世界书扫描，等扫描完成、生成停止、生成结束或切换聊天时恢复原本的全局世界书选择。

## 功能

- 按聊天保存额外来源世界书列表。
- 在生成期间临时加入来源书，让 SillyTavern 原生世界书扫描规则正常生效。
- 显示当前聊天原生绑定的 chat lorebook，并避免重复加入同一本书。
- 搜索并添加已有世界书。
- 通过“新建空书”显式创建一本空世界书，并加入当前聊天来源列表。
- 在扩展菜单按钮上显示当前聊天会参与扫描的世界书入口数量。

## 使用

1. 打开 SillyTavern 扩展菜单。
2. 点击“聊天世界书管理”。
3. 在搜索栏输入或选择世界书名称。
4. 点击“添加已有”加入当前聊天来源列表。
5. 如需创建新空书，输入名称后点击“新建空书”。

“添加已有”只会添加已经存在的世界书；如果名称不存在，会提示找不到世界书。

## 数据

扩展把当前聊天的来源书列表保存到聊天 metadata：

```js
chat_metadata.multi_chat_lore_sources = {
  version: 1,
  sources: ['Book A', 'Book B'],
  updatedAt: 1782150000000,
};
```

原生 chat lorebook 仍由 SillyTavern 的 `chat_metadata.world_info` 管理。

## 控制台接口

```js
await ChatLoreSources.add('Book A');
await ChatLoreSources.create('New Empty Book');

ChatLoreSources.list();

await ChatLoreSources.remove('Book A');
await ChatLoreSources.clear();
```
