/** 看板搜索（用户故事 7）：标题、标签、任务描述（摘要）、绑定线程标题；多词 AND、大小写不敏感。 */

import type { ClientTask, ClientThread } from "./board-model.js";

export const matchesSearch = (task: ClientTask, threads: ClientThread[], rawQuery: string): boolean => {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return true;
  // 绑定线程取“本任务的线程”，避免其他任务的会话标题把卡片误捞进结果
  const boundThreadTitles = threads
    .filter((candidate) => candidate.primaryTaskId === task.id)
    .map((candidate) => candidate.title ?? "");
  const haystack = [task.title, task.labels.join(" "), task.prompt, ...boundThreadTitles]
    .join("\n")
    .toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
};
