import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ClipboardBiz,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardImageOcrSchema,
  ClipboardItemSchema,
  ClipboardItemsSchema,
  ClipboardKind,
  ReadImageResponseSchema,
  ReadTextResponseSchema,
} from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { ClipboardPage } from "./ClipboardPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(withImage = false) {
  const imageId = 3n;
  let imageText: string | undefined;
  let rows = [
    create(ClipboardItemSchema, {
      id: 2n,
      kind: ClipboardKind.TEXT,
      previewText: "最新文本",
      lastUsedAtMs: 2n,
    }),
    create(ClipboardItemSchema, {
      id: 1n,
      kind: ClipboardKind.TEXT,
      previewText: "收藏文本",
      favorite: true,
      categoryId: 7n,
      lastUsedAtMs: 1n,
      updatedAtMs: 1n,
    }),
  ];
  if (withImage) {
    rows.unshift(
      create(ClipboardItemSchema, {
        id: imageId,
        kind: ClipboardKind.IMAGE,
        lastUsedAtMs: 3n,
      }),
    );
  }
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
                  (!query ||
                    item.previewText?.includes(query) ||
                    (item.id === imageId && imageText?.includes(query))) &&
                  (!favoritesOnly || item.favorite) &&
                  (!kind || item.kind === kind) &&
                  (categoryId === undefined || item.categoryId === categoryId),
              )
              .slice(offset ?? 0, (offset ?? 0) + (limit ?? 50)),
          }),
        categories: () =>
          create(ClipboardCategoriesSchema, { items: [{ id: 7n, name: "工作", color: "blue" }] }),
        readText: ({ id }) =>
          create(ReadTextResponseSchema, {
            text: rows.find((item) => item.id === id)?.previewText,
          }),
        readImage: () => create(ReadImageResponseSchema, { png: new Uint8Array([1]) }),
        readImageOcr: ({ id }) =>
          create(ClipboardImageOcrSchema, { text: id === imageId ? imageText : undefined }),
        editText: ({ id, text }) => {
          const item = rows.find((row) => row.id === id);
          if (!item) throw new Error("Missing clipboard item");
          if (item.previewText !== text) {
            item.previewText = text;
            item.updatedAtMs = 1726502400000n;
          }
          return item;
        },
      },
      { partial: true },
    ),
    [
      {
        name: ClipboardChangedSchema.typeName,
        policy: "coalesce",
        validate() {},
        matches: () => true,
      },
    ],
  );
  const page = render(
    <ClipboardPage
      onBack={vi.fn()}
      services={createServices(() => host.client({ caller: "test", trusted: true }))}
    />,
  );
  const publish = async () => {
    await act(async () => {
      owner.publish(
        ClipboardChangedSchema.typeName,
        toBinary(ClipboardChangedSchema, create(ClipboardChangedSchema)),
      );
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
      rows[1].updatedAtMs = 1726502400000n;
      await publish();
    },
    async recognizeImage(text: string) {
      imageText = text;
      await publish();
    },
  };
}

test.each(["收藏", "图片", "文件", "工作"])(
  "capture switches %s to all and selects latest",
  async (tab) => {
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
      expect(page.getByRole("option", { name: "新捕获文本" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(page.getByRole("button", { name: "剪贴板" })).toHaveAttribute("aria-pressed", "true");
  },
);

test("capture clears search and repeated content selects the reused record", async () => {
  const page = setup();
  await page.findByRole("option", { name: "最新文本" });
  await userEvent.type(page.getByRole("textbox", { name: "搜索" }), "最新");
  await waitFor(() => expect(page.getAllByRole("option")).toHaveLength(1));
  await page.capture(true);
  await waitFor(() =>
    expect(page.getByRole("option", { name: "收藏文本" })).toHaveAttribute("aria-selected", "true"),
  );
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
    expect(page.getByRole("option", { name: "新捕获文本" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
});

test("image preview switches to OCR and search selects the original image", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:test-image");
      static revokeObjectURL = vi.fn();
    },
  );
  const page = setup(true);
  const preview = within(page.getByRole("region", { name: "内容预览" }));
  const image = await preview.findByRole("img", { name: "剪贴板图片" });
  expect(preview.queryByRole("button", { name: "查看文字" })).toBeNull();

  await page.recognizeImage("Cobalt orchard\n剪贴板识别");
  const toggle = await preview.findByRole("button", { name: "查看文字" });
  expect(preview.getByRole("img", { name: "剪贴板图片" })).toBe(image);
  await userEvent.click(toggle);
  expect(toggle).toHaveAccessibleName("查看原图");
  expect(preview.getByText(/Cobalt orchard/)).toHaveTextContent("剪贴板识别");
  expect(preview.queryByRole("img", { name: "剪贴板图片" })).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(toggle).toHaveAccessibleName("查看文字");
  expect(preview.getByRole("img", { name: "剪贴板图片" })).toBeVisible();

  const search = page.getByRole("textbox", { name: "搜索" });
  await userEvent.type(search, "orchard");
  await waitFor(() => expect(page.getAllByRole("option")).toHaveLength(1));
  expect(page.getByRole("option", { name: "图片" })).toHaveAttribute("aria-selected", "true");

  await userEvent.click(toggle);
  await userEvent.clear(search);
  await userEvent.click(await page.findByRole("option", { name: "最新文本" }));
  expect(preview.queryByRole("button", { name: "查看原图" })).toBeNull();
  await userEvent.click(page.getByRole("option", { name: "图片" }));
  expect(await preview.findByRole("button", { name: "查看文字" })).toBeVisible();
});

test("editing preserves selection and order and displays the modification time", async () => {
  const page = setup();
  await page.findByRole("option", { name: "收藏文本" });
  const navigation = within(page.getByRole("navigation"));
  await userEvent.click(navigation.getByRole("button", { name: "收藏" }));
  await page.findByRole("option", { name: "收藏文本" });
  await userEvent.click(page.getByRole("button", { name: "编辑" }));
  const dialog = within(await page.findByRole("dialog", { name: "编辑文本" }));
  const text = dialog.getByRole("textbox", { name: "编辑文本" });
  await waitFor(() => expect(text).toHaveValue("收藏文本"));
  await userEvent.clear(text);
  await userEvent.type(text, "修改后的文本");
  await userEvent.click(dialog.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
  expect(page.getByRole("option", { name: "修改后的文本" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(navigation.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(page.getByRole("button", { name: "展开" }));
  const modified = page.getByText("修改时间").parentElement;
  const lastUsed = page.getByText("上次使用").parentElement;
  expect(modified).toHaveTextContent(new Date(1726502400000).toLocaleString("sv-SE"));
  expect(lastUsed).toHaveTextContent(new Date(1).toLocaleString("sv-SE"));

  await userEvent.click(page.getByRole("button", { name: "剪贴板" }));
  await page.findByRole("option", { name: "最新文本" });
  expect(page.getAllByRole("option").map((row) => row.textContent)).toEqual([
    "最新文本",
    "修改后的文本",
  ]);
});
