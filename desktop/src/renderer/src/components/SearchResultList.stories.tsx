import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { launcherHeight } from "../../../shared/launcher-model";
import { LauncherSearchBar } from "./LauncherSearchBar";
import { QuickChatTransition } from "./quick-chat/QuickChatTransition";
import { SearchResultList } from "./SearchResultList";

const hits = [
  { id: "calc", title: "1+2 = 3", provider: "calculator", label: "计算器", score: 0, ranges: [] },
  { id: "app", title: "微信", provider: "app", label: "应用", score: 100, ranges: [{ start: 0, end: 2 }] },
  { id: "settings", title: "显示器", provider: "app", label: "系统设置", score: 90, ranges: [] },
  { id: "bookmark", title: "周报", provider: "bookmark", label: "网页", score: 80, ranges: [] },
];
const meta = {
  title: "Launcher/SearchResults",
  component: SearchResultList,
  args: { hits, selected: 0, onSelect: fn(), onConfirm: fn() },
  render: function Preview(args) {
    const [, updateArgs] = useArgs();
    return (
      <div style={{ width: 800, height: launcherHeight(args.hits.length) }}>
        <LauncherSearchBar query="搜索预览" onQueryChange={fn()} onDismiss={fn()}>
          <SearchResultList
            {...args}
            onSelect={(index) => {
              args.onSelect(index);
              updateArgs({ selected: index });
            }}
          />
        </LauncherSearchBar>
      </div>
    );
  },
} satisfies Meta<typeof SearchResultList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Mixed: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Scroll: Story = {
  args: {
    hits: Array.from({ length: 15 }, (_, i) => ({ ...hits[3], id: `bookmark-${i}`, title: `收藏网页 ${i + 1}` })),
  },
};
export const ScrollInLauncher: Story = {
  args: Scroll.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox", { name: "搜索" }));
    const rows = canvas.getAllByRole("option");
    for (let index = 1; index < rows.length; index += 1) {
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(rows[index]).toHaveAttribute("aria-selected", "true"));
    }
    const last = rows.at(-1);
    await waitFor(() => {
      expect(last).toHaveAttribute("aria-selected", "true");
      const bounds = canvas.getByTestId("quick-chat-viewport").getBoundingClientRect();
      const row = last?.getBoundingClientRect();
      expect(row?.top).toBeGreaterThan(bounds.top);
      expect(row?.bottom).toBeLessThan(bounds.bottom);
    });
  },
  render: function Preview(args) {
    const [, updateArgs] = useArgs();
    return (
      <div style={{ width: 800 }}>
        <QuickChatTransition
          expanded={false}
          searchHeight={launcherHeight(args.hits.length)}
          composer={null}
          search={
            <LauncherSearchBar
              embedded
              query="搜索预览"
              onQueryChange={fn()}
              onDismiss={fn()}
              onNavigate={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                updateArgs({ selected: Math.max(0, Math.min(args.hits.length - 1, args.selected + delta)) });
              }}
            >
              <SearchResultList {...args} onSelect={(selected) => updateArgs({ selected })} />
            </LauncherSearchBar>
          }
        >
          {() => null}
        </QuickChatTransition>
      </div>
    );
  },
};
export const SelectAndConfirm: Story = {
  play: async ({ canvasElement, args }) => {
    const row = within(canvasElement).getByRole("option", { name: "微信 应用" });
    await userEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
    await userEvent.dblClick(row);
    await expect(args.onConfirm).toHaveBeenCalledWith(1);
  },
};
