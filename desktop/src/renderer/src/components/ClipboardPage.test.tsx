import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  ClipboardBiz,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardItemSchema,
  ClipboardItemsSchema,
  ClipboardKind,
  ReadTextResponseSchema,
} from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { ClipboardPage } from "./ClipboardPage";

afterEach(cleanup);

function setup() {
  let rows = [
    create(ClipboardItemSchema, { id: 2n, kind: ClipboardKind.TEXT, previewText: "最新文本", lastUsedAtMs: 2n }),
    create(ClipboardItemSchema, {
      id: 1n,
      kind: ClipboardKind.TEXT,
      previewText: "收藏文本",
      favorite: true,
      categoryId: 7n,
      lastUsedAtMs: 1n,
    }),
  ];
  const host = new GatewayHost();
  const owner = host.registerOwner(
    "clipboard",
    bindHandlers(
      ClipboardBiz,
      {
        list: ({ query, favoritesOnly, kind, categoryId, limit, offset }) =>
          create(ClipboardItemsSchema, {
            items: rows
              .filter(
                (item) =>
                  (!query || item.previewText?.includes(query)) &&
                  (!favoritesOnly || item.favorite) &&
                  (!kind || item.kind === kind) &&
                  (categoryId === undefined || item.categoryId === categoryId),
              )
              .slice(offset ?? 0, (offset ?? 0) + (limit ?? 50)),
          }),
        categories: () => create(ClipboardCategoriesSchema, { items: [{ id: 7n, name: "工作", color: "blue" }] }),
        readText: ({ id }) =>
          create(ReadTextResponseSchema, { text: rows.find((item) => item.id === id)?.previewText }),
      },
      { partial: true },
    ),
    [{ name: ClipboardChangedSchema.typeName, policy: "coalesce", validate() {}, matches: () => true }],
  );
  const page = render(
    <ClipboardPage onBack={vi.fn()} services={createServices(() => host.client({ caller: "test", trusted: true }))} />,
  );
  const publish = async () => {
    await act(async () => {
      owner.publish(ClipboardChangedSchema.typeName, toBinary(ClipboardChangedSchema, create(ClipboardChangedSchema)));
    });
    await waitFor(() => expect(page.getByRole("listbox")).toHaveAttribute("aria-busy", "false"));
  };
  return {
    ...page,
    async capture(reuse = false) {
      const item = reuse
        ? { ...rows[1], lastUsedAtMs: 3n, useCount: 2 }
        : create(ClipboardItemSchema, {
            id: 3n,
            kind: ClipboardKind.TEXT,
            previewText: "新捕获文本",
            lastUsedAtMs: 3n,
          });
      rows = [item, ...rows.filter((row) => row.id !== item.id)];
      await publish();
    },
    async metadata() {
      rows[1].remark = "备注";
      await publish();
    },
  };
}

test.each(["收藏", "图片", "文件", "工作"])("capture switches %s to all and selects latest", async (tab) => {
  const page = setup();
  await page.findByRole("option", { name: "最新文本" });
  await userEvent.click(within(page.getByRole("navigation")).getByRole("button", { name: tab }));
  await waitFor(() => expect(page.getByRole("listbox")).toHaveAttribute("aria-busy", "false"));
  await page.metadata();
  expect(within(page.getByRole("navigation")).getByRole("button", { name: tab })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.capture();
  await waitFor(() =>
    expect(page.getByRole("option", { name: "新捕获文本" })).toHaveAttribute("aria-selected", "true"),
  );
  expect(page.getByRole("button", { name: "剪贴板" })).toHaveAttribute("aria-pressed", "true");
});

test("capture clears search and repeated content selects the reused record", async () => {
  const page = setup();
  await page.findByRole("option", { name: "最新文本" });
  await userEvent.type(page.getByRole("textbox", { name: "搜索" }), "最新");
  await waitFor(() => expect(page.getAllByRole("option")).toHaveLength(1));
  await page.capture(true);
  await waitFor(() => expect(page.getByRole("option", { name: "收藏文本" })).toHaveAttribute("aria-selected", "true"));
  expect(page.getByRole("textbox", { name: "搜索" })).toHaveValue("");
});

test("metadata refresh preserves manual selection in all", async () => {
  const page = setup();
  await page.findByRole("option", { name: "收藏文本" });
  await userEvent.click(page.getByRole("option", { name: "收藏文本" }));
  await page.metadata();
  expect(page.getByRole("option", { name: /收藏文本/ })).toHaveAttribute("aria-selected", "true");
  await page.capture();
  await waitFor(() =>
    expect(page.getByRole("option", { name: "新捕获文本" })).toHaveAttribute("aria-selected", "true"),
  );
});
