import { runInNewContext } from "node:vm";

import { expect, test } from "vite-plus/test";

import { smokeTextPayload } from "../src/eda/liveSmoke.ts";

const options = {
  projectName: "agent-drill-rc50",
  projectUuid: "project-uuid",
  documentUuid: "document-uuid",
  marker: "LCEDA_CONNECT_SMOKE_fixture",
};

interface TextResult {
  marker: string;
  createdId?: string;
  observed: boolean;
  deleted: boolean;
  failure: string | null;
  cleanupFailure: string | null;
  restored: boolean;
  beforeCount: number;
  afterCount: number | null;
}

function fixture(
  settings: {
    wrongProject?: boolean;
    wrongDocument?: boolean;
    readFailure?: boolean;
    deleteFailure?: boolean;
    switchAfterCreate?: boolean;
  } = {},
) {
  const texts = new Map([["existing", "existing text"]]);
  const deleted: string[] = [];
  let created = 0;
  let documentUuid = settings.wrongDocument ? "foreign" : options.documentUuid;
  const eda = {
    dmt_Project: {
      getCurrentProjectInfo: async () => ({
        friendlyName: options.projectName,
        uuid: settings.wrongProject ? "foreign" : options.projectUuid,
      }),
    },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: documentUuid }),
    },
    sch_PrimitiveText: {
      getAllPrimitiveId: async () => [...texts.keys()],
      create: async (_x: number, _y: number, marker: string) => {
        created++;
        texts.set("new", marker);
        if (settings.switchAfterCreate) documentUuid = "foreign";
        return { getState_PrimitiveId: () => "new" };
      },
      get: async (id: string) => {
        if (settings.readFailure && texts.has(id)) throw new Error("read failed");
        return texts.has(id) ? { getState_Content: () => texts.get(id) } : undefined;
      },
      delete: async (id: string) => {
        deleted.push(id);
        return settings.deleteFailure ? false : texts.delete(id);
      },
    },
  };
  const run = async (marker = options.marker): Promise<TextResult> =>
    await (runInNewContext(`(async()=>{${smokeTextPayload({ ...options, marker })}})()`, {
      eda,
    }) as Promise<TextResult>);
  return {
    run,
    texts,
    deleted,
    get created() {
      return created;
    },
  };
}

test("真机文本载荷能回传 marker 并精确清理新增图元", async () => {
  const editor = fixture();
  const result = await editor.run();
  expect(result).toMatchObject({
    marker: options.marker,
    createdId: "new",
    observed: true,
    deleted: true,
    failure: null,
    cleanupFailure: null,
    restored: true,
    beforeCount: 1,
    afterCount: 1,
  });
  expect(editor.deleted).toEqual(["new"]);
  expect([...editor.texts]).toEqual([["existing", "existing text"]]);
});

test("marker 中的引号和换行作为数据传递", async () => {
  const editor = fixture();
  const marker = 'text"; throw Error("injected");\n';
  expect((await editor.run(marker)).marker).toBe(marker);
  expect(editor.texts.size).toBe(1);
});

test("工程身份不符时不创建图元", async () => {
  const editor = fixture({ wrongProject: true });
  await expect(editor.run()).rejects.toThrow("DOCUMENT_GUARD");
  expect(editor.created).toBe(0);
});

test("文档身份不符时不创建图元", async () => {
  const editor = fixture({ wrongDocument: true });
  await expect(editor.run()).rejects.toThrow("DOCUMENT_GUARD");
  expect(editor.created).toBe(0);
});

test("回读失败仍清理本次图元并保留失败证据", async () => {
  const editor = fixture({ readFailure: true });
  const result = await editor.run();
  expect(result.failure).toContain("read failed");
  expect(result.createdId).toBe("new");
  expect(result.deleted).toBe(true);
  expect(result.restored).toBe(true);
  expect(editor.texts.size).toBe(1);
});

test("删除失败返回确切残留 id 而不谎报恢复", async () => {
  const editor = fixture({ deleteFailure: true });
  const result = await editor.run();
  expect(result.createdId).toBe("new");
  expect(result.cleanupFailure).toContain("CLEANUP_UNCONFIRMED");
  expect(result.restored).toBe(false);
  expect(editor.texts.has("new")).toBe(true);
});

test("用户切换文档后不在错误文档执行删除", async () => {
  const editor = fixture({ switchAfterCreate: true });
  const result = await editor.run();
  expect(result.createdId).toBe("new");
  expect(result.failure).toContain("DOCUMENT_GUARD");
  expect(result.cleanupFailure).toContain("DOCUMENT_GUARD");
  expect(result.restored).toBe(false);
  expect(editor.deleted).toEqual([]);
});
