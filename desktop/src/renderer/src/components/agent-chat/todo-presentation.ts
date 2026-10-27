import { isToolObject, parseToolJson } from "./tool-presentation";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export function readTodos(metadataJson: string | undefined): TodoItem[] | undefined {
  const metadata = parseToolJson(metadataJson);
  if (!isToolObject(metadata) || !isToolObject(metadata.todoWrite)) return undefined;
  const todos = metadata.todoWrite.todos;
  if (!Array.isArray(todos)) return undefined;

  const result: TodoItem[] = [];
  for (const item of todos) {
    if (
      !isToolObject(item) ||
      typeof item.id !== "string" ||
      typeof item.content !== "string" ||
      (item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed" &&
        item.status !== "cancelled")
    ) {
      return undefined;
    }
    result.push({ id: item.id, content: item.content, status: item.status });
  }
  return result;
}
