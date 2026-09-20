import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { launcherHeight } from "../../../shared/launcher-model";
import { LauncherSearchBar } from "./LauncherSearchBar";
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
export const SelectAndConfirm: Story = {
  play: async ({ canvasElement, args }) => {
    const row = within(canvasElement).getByRole("option", { name: "微信 应用" });
    await userEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
    await userEvent.dblClick(row);
    await expect(args.onConfirm).toHaveBeenCalledWith(1);
  },
};
