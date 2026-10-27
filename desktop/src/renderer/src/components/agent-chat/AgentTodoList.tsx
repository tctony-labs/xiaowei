import type { TodoItem, TodoStatus } from "./todo-presentation";

const statuses: Record<TodoStatus, { label: string; glyph: string }> = {
  pending: { label: "待办", glyph: "○" },
  in_progress: { label: "进行中", glyph: "◐" },
  completed: { label: "完成", glyph: "●" },
  cancelled: { label: "取消", glyph: "✕" },
};

export function AgentTodoList({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return <p className="text-xs text-muted">（空列表）</p>;

  return (
    <ul className="agent-todos" aria-label="待办清单">
      {todos.map((todo) => (
        <li className="agent-todo" data-status={todo.status} key={todo.id}>
          <span className="agent-todo-status" role="img" aria-label={statuses[todo.status].label}>
            {statuses[todo.status].glyph}
          </span>
          <span className="agent-todo-content">{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
