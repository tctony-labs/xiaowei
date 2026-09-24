import { create, toBinary } from "@bufbuild/protobuf";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  ClipboardBiz,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardItemSchema,
  ClipboardItemsSchema,
  ClipboardKind,
  EmptySchema,
  ReadTextResponseSchema,
  SetFavoriteResponseSchema,
} from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { ClipboardPage } from "./ClipboardPage";

const selected = fn();

function preview() {
  const host = new GatewayHost();
  let rows = Array.from({ length: 30 }, (_, index) =>
    create(ClipboardItemSchema, {
      id: BigInt(index + 1),
      kind: ClipboardKind.TEXT,
      previewText: `历史记录 ${index + 1}`,
      lastUsedAtMs: BigInt(30 - index),
      useCount: 1,
    }),
  );
  let latest = 30n;
  const unused = () => {
    throw new Error("Unused preview route");
  };
  const changed = () =>
    owner.publish(ClipboardChangedSchema.typeName, toBinary(ClipboardChangedSchema, create(ClipboardChangedSchema)));
  const copy = (id: bigint) => {
    const item = rows.find((row) => row.id === id);
    if (!item) throw new Error("Missing preview item");
    item.lastUsedAtMs = ++latest;
    item.useCount++;
    rows = [item, ...rows.filter((row) => row.id !== id)];
    changed();
    return create(EmptySchema);
  };
  const owner = host.registerOwner(
    "clipboard",
    bindHandlers(ClipboardBiz, {
      list: ({ query, favoritesOnly, offset, limit }) =>
        create(ClipboardItemsSchema, {
          items: rows
            .filter((item) => (!query || item.previewText?.includes(query)) && (!favoritesOnly || item.favorite))
            .slice(offset ?? 0, (offset ?? 0) + (limit ?? 50)),
        }),
      categories: () => create(ClipboardCategoriesSchema),
      readText: ({ id }) => create(ReadTextResponseSchema, { text: rows.find((item) => item.id === id)?.previewText }),
      copy: ({ id }) => copy(id),
      select: ({ id }) => {
        const response = copy(id);
        selected(id);
        return response;
      },
      setFavorite: ({ id, favorite }) => {
        const item = rows.find((row) => row.id === id);
        if (!item) throw new Error("Missing preview item");
        item.favorite = favorite;
        changed();
        return create(SetFavoriteResponseSchema, { updated: true });
      },
      get: unused,
      readImage: unused,
      delete: unused,
      clearHistory: unused,
      purgeOrdinary: unused,
      purgeExpired: unused,
      storageUsage: unused,
      saveCategory: unused,
      deleteCategory: unused,
      setRemark: unused,
      editText: unused,
      setCategory: unused,
      openResource: unused,
      revealResource: unused,
      copyResourcePath: unused,
    }),
    [{ name: ClipboardChangedSchema.typeName, policy: "coalesce", validate() {}, matches: () => true }],
  );

  return {
    services: createServices(() => host.client({ caller: "storybook", trusted: true })),
    capture() {
      const id = ++latest;
      rows = [
        create(ClipboardItemSchema, {
          id,
          kind: ClipboardKind.TEXT,
          previewText: `新复制的内容 ${id}`,
          lastUsedAtMs: id,
          useCount: 1,
        }),
        ...rows,
      ];
      changed();
    },
  };
}

const meta = {
  title: "Clipboard/Page",
  component: ClipboardPage,
  args: { onBack: fn() },
  render: function Preview(args) {
    const [fixture] = useState(preview);
    return (
      <div>
        <button type="button" className="m-2 rounded border px-3 py-1" onClick={() => fixture.capture()}>
          模拟复制新内容
        </button>
        <div className="[&>div]:h-full" style={{ width: 800, height: 580 }}>
          <ClipboardPage {...args} services={fixture.services} />
        </div>
      </div>
    );
  },
} satisfies Meta<typeof ClipboardPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewItemSelection: Story = {
  play: async ({ canvasElement }) => {
    selected.mockClear();
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("listbox", { name: "剪贴板记录" });
    const input = canvas.getByRole("textbox", { name: "搜索" });
    const assertSelected = async (text: string, first = false) => {
      await waitFor(() => {
        const row = canvas.getByRole("option", { name: (_name, element) => element.textContent === text });
        expect(row).toHaveAttribute("aria-selected", "true");
        if (first) expect(within(list).getAllByRole("option")[0]).toBe(row);
        expect(canvas.getByRole("region", { name: "内容预览" })).toHaveTextContent(text);
        expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top + 7);
        expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom - 7);
      });
    };

    await canvas.findByRole("option", { name: "历史记录 30" });
    const panel = canvas.getByRole("main").getBoundingClientRect();
    await expect(panel.width).toBe(800);
    await expect(panel.height).toBe(580);
    await userEvent.click(canvas.getByRole("option", { name: "历史记录 30" }));
    await assertSelected("历史记录 30");
    await userEvent.click(canvas.getByRole("button", { name: "模拟复制新内容" }));
    await assertSelected("新复制的内容 31", true);

    // The third row remains selected after Enter copies it to the top.
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(selected).toHaveBeenCalledOnce());
    await expect(selected).toHaveBeenCalledWith(2n);
    await assertSelected("历史记录 2", true);

    // Metadata-only refreshes preserve the manually selected row.
    await userEvent.click(canvas.getByRole("option", { name: "历史记录 30" }));
    await userEvent.click(
      within(canvas.getByRole("region", { name: "内容预览" })).getByRole("button", { name: "收藏" }),
    );
    await canvas.findByText("已收藏");
    await assertSelected("历史记录 30");
    await userEvent.click(canvas.getByRole("button", { name: "模拟复制新内容" }));
    await assertSelected("新复制的内容 33", true);

    // A new item outside the current search must not disrupt selection.
    await userEvent.type(input, "历史记录");
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(30));
    await userEvent.click(
      await canvas.findByRole("option", { name: (_name, element) => element.textContent === "历史记录 3" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "模拟复制新内容" }));
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
    await assertSelected("历史记录 3");
  },
};
