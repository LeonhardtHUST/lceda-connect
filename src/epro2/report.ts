/** 六段式 report.md 模板。逐段对齐 Python 版 analyze.render_report()。 */
import type {
  Artifacts,
  ConsistencyStats,
  FloatingNet,
  Mismatch,
  SchematicIr,
} from "./contract.ts";

interface Finding {
  level: string;
  what: string;
  why: string;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

/** 未解析的页按 uuid 求差集：页名会重名，label 又会加 #2 后缀，都不可靠。 */
function pendingPages(artifacts: Artifacts): Artifacts["meta"]["pages"] {
  const analyzed = new Set(artifacts.meta.pages_analyzed_uuids);
  return artifacts.meta.pages.filter((page) => !analyzed.has(page.uuid));
}

function pageLabel(ir: SchematicIr): string {
  return ir.page.label || ir.page.name;
}

export function renderReport(
  artifacts: Artifacts,
  mismatches: readonly Mismatch[],
  stats: ConsistencyStats,
  floating: readonly FloatingNet[],
  floatingTruncated = false,
): string {
  const { meta, geometry: geo, pages_ir: pagesIr } = artifacts;
  const docCounts = new Map<string, number>();
  for (const doc of meta.documents) {
    const key = doc.docType ?? "null";
    docCounts.set(key, (docCounts.get(key) ?? 0) + 1);
  }
  const pending = pendingPages(artifacts);

  const lines: string[] = [];
  const add = (line = ""): void => {
    lines.push(line);
  };
  add(`# ${meta.project} 解析报告`);
  add();
  add("## 一、工程概况");
  add();
  add(
    `- 源文件：\`${meta.source}\`（记录流 \`${meta.epru}\`，${meta.record_lines} 行，解析失败 ${meta.record_unparsed} 行）`,
  );
  add(
    `- 文档：${[...docCounts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, count]) => `${key}×${count}`)
      .join("，")}`,
  );
  add(
    `- 库表：符号 ${meta.library.symbols} / 器件 ${meta.library.devices} / 封装 ${meta.library.footprints}`,
  );
  if (pagesIr.length > 0) {
    for (const ir of pagesIr) {
      const parts = ir.components.filter((comp) => comp.componentType === "part");
      add(
        `- 原理图页 \`${pageLabel(ir)}\`：元件 ${ir.components.length}（实体件 ${parts.length}），` +
          `导线 ${ir.wires.length}，网络 ${ir.nets.length}`,
      );
    }
    if (pending.length > 0) {
      add(`- **未解析的页**：${pending.map((page) => `${page.name}（${page.uuid}）`).join("、")}`);
    }
  } else {
    add("- 原理图页：无（工程内没有原理图页文档）");
  }
  add(
    `- PCB：网表 ${artifacts.pcb_rows.length} 行，走线网络 ${(geo.traces ?? []).length} 个，` +
      `过孔 ${(geo.vias ?? []).length} 个`,
  );
  add();

  add("## 二、网表一致性");
  add();
  add(`- 可比对引脚 ${stats.compared} 个，不一致 ${stats.mismatch} 个`);
  if (stats.skipped_unnamed) {
    add(`- 另有 ${stats.skipped_unnamed} 个引脚所在网络在原理图侧未命名，无法按名比对`);
  }
  if (stats.ambiguous) {
    add(`- 另有 ${stats.ambiguous} 个引脚在不同页上落在不同网络（位号重复），已排除比对`);
  }
  if (stats.duplicate_designators) {
    add(`- 另有 ${stats.duplicate_designators} 个位号在 PCB 上对应多个元件，已排除比对`);
  }
  if (stats.duplicate_pin_keys) {
    add(
      `- 另有 ${stats.duplicate_pin_keys} 个（位号, 引脚号）在 PCB 网表里重复出现，其中 ` +
        `${stats.duplicate_pin_conflicts} 个网络互相矛盾已排除比对`,
    );
  }
  if (stats.multi_page) {
    add(`- 另有 ${stats.multi_page} 个位号出现在多个原理图页，已排除比对`);
  }
  if (mismatches.length > 0) {
    add();
    add("| 位号 | 引脚 | 原理图网络 | PCB 网络 |");
    add("|---|---|---|---|");
    for (const mismatch of mismatches.slice(0, 50)) {
      add(`| ${mismatch.designator} | ${mismatch.pin} | ${mismatch.schematic} | ${mismatch.pcb} |`);
    }
    if (mismatches.length > 50) {
      add();
      add("（仅列前 50 条）");
    }
  } else if (stats.compared) {
    add("- 逐脚一致。");
  } else {
    add("- **未完成比对**：两侧引脚号没有交集，见数据缺失清单。");
  }
  add();

  add("## 三、PCB 几何");
  add();
  const outline = geo.outline;
  if (outline) {
    if ((outline.boards || 1) > 1) {
      add(
        `- 板框：${outline.boards} 块板，并集 ${fixed(outline.width_mm, 2)} × ${fixed(outline.height_mm, 2)} mm`,
      );
      (geo.outlines ?? []).forEach((board, index) => {
        add(
          `  - 板 ${index + 1}（\`${board.doc}\`）：${fixed(board.width_mm, 2)} × ${fixed(board.height_mm, 2)} mm`,
        );
      });
    } else {
      add(`- 板框：${fixed(outline.width_mm, 2)} × ${fixed(outline.height_mm, 2)} mm`);
    }
  } else {
    add("- 板框：**数据缺失**（未找到 BOARD_OUTLINE 记录）");
  }
  add(
    `- 铜层：声明 ${geo.copper_layers_declared ?? 0} 条，被实际引用 ${geo.copper_layers_used ?? 0} 条`,
  );
  if ((geo.stackup ?? []).length > 0) {
    add(`- 叠层：${geo.stackup.length} 条 LAYER_PHYS 记录（原始字段见 \`pcb_geometry.json\`）`);
  } else {
    add("- 叠层：**数据缺失**");
  }
  const traces = geo.traces ?? [];
  if (traces.length > 0) {
    const total = traces.reduce((sum, trace) => sum + trace.length_mm, 0);
    add(`- 走线：${traces.length} 个网络，总长 ${fixed(total, 1)} mm`);
    for (const trace of traces.slice(0, 8)) {
      add(
        `  - \`${trace.net || "(未命名)"}\`：${trace.segments} 段，${fixed(trace.length_mm, 1)} mm，` +
          `线宽 ${trace.width_mil_mode || "?"} mil`,
      );
    }
  } else {
    add("- 走线：**数据缺失**");
  }
  const histogram = geo.via_hole_histogram ?? {};
  if (Object.keys(histogram).length > 0) {
    add(
      `- 过孔孔径分布：${Object.entries(histogram)
        .map(([hole, count]) => `${hole} mil×${count}`)
        .join("，")}`,
    );
  }
  add();

  add("## 四、自动检查项");
  add();
  const findings: Finding[] = [];
  for (const ir of pagesIr) {
    for (const net of ir.nets) {
      if (net.conflicts.length > 0) {
        findings.push({
          level: "🔴",
          what: `网络 \`${net.name}\` 同时出现名字 ${net.conflicts.join("、")}（页 \`${pageLabel(ir)}\`）`,
          why: "可能是真短路，也可能是历史残留线段；需人工确认",
        });
      }
    }
  }
  for (const item of floating) {
    findings.push({
      level: "🟡",
      what: `命名网络 \`${item.net}\` 只连了 1 个实体引脚（页 \`${item.page}\`）`,
      why: "悬空或绘图残留，需确认是否有意为之",
    });
  }
  if (stats.ambiguous) {
    findings.push({
      level: "🟠",
      what: `${stats.ambiguous} 个引脚在不同原理图页上落在不同网络`,
      why: "多个页存在同一位号，未编号或重复；先确认后再做网表比对",
    });
  }
  if (stats.duplicate_designators) {
    findings.push({
      level: "🟠",
      what: `${stats.duplicate_designators} 个位号在 PCB 上对应多个元件`,
      why: "位号重复会让焊盘无法唯一归属，需先重新编号",
    });
  }
  if (stats.multi_page) {
    findings.push({
      level: "🟠",
      what: `${stats.multi_page} 个位号出现在多个原理图页`,
      why: "多页共用位号通常是未重新编号的副本页，需确认哪一页有效",
    });
  }
  if (stats.duplicate_pin_conflicts) {
    findings.push({
      level: "🟠",
      what: `${stats.duplicate_pin_conflicts} 个引脚在 PCB 网表里对应多个网络`,
      why: "同一（位号, 引脚号）有多条网络矛盾的 PAD_NET，需确认焊盘归属后再比对",
    });
  }
  for (const warning of new Set([...artifacts.pcb_warnings, ...(geo.warnings ?? [])])) {
    findings.push({ level: "🟡", what: warning, why: "解析限制，不是设计缺陷" });
  }
  if (mismatches.length > 0) {
    findings.push({
      level: "🟠",
      what: `${mismatches.length} 个引脚的两侧网络不一致`,
      why: "原理图与 PCB 不同步，或一侧存在历史残留",
    });
  }

  if (findings.length > 0) {
    add("| 级别 | 发现 | 说明 |");
    add("|---|---|---|");
    for (const finding of findings.slice(0, 60)) {
      add(`| ${finding.level} | ${finding.what} | ${finding.why} |`);
    }
  } else {
    add("- 自动检查未发现问题。这只代表解析层面一致，不等于设计正确。");
  }
  add();
  if (floatingTruncated) {
    add(
      `> 悬空网络清单已截断：**仅列前 ${floating.length} 条**，完整结果见 \`nets.json\`，` +
        "未列出的部分同样需要人工核对。",
    );
    add();
  }
  add(
    "> 自动检查只覆盖可机械判定的项（网络冲突、悬空、两侧不一致、解析缺项）。" +
      "引脚功能、封装选型、电流余量、器件极性等需要对照数据手册逐项核对，" +
      "见 `references/review-playbook.md`。",
  );
  add();

  add("## 五、数据缺失清单");
  add();
  const missing: string[] = [];
  if (pagesIr.length === 0) missing.push("工程内没有原理图页，无法做原理图侧分析");
  if (artifacts.pcb_rows.length === 0) {
    missing.push("PCB 网表为空：可能没有 PCB 文档，或 PAD_NET 记录缺失");
  }
  if (!geo.outline) missing.push("缺少板框记录，无法判断外形尺寸");
  if ((geo.stackup ?? []).length === 0) missing.push("缺少 LAYER_PHYS，叠层与阻抗无法确认");
  if (stats.compared === 0) missing.push("两侧引脚号没有交集，网表一致性未验证");
  if (pending.length > 0) {
    missing.push(
      `有 ${pending.length} 个原理图页未被解析（${pending.map((page) => page.name).join("、")}），` +
        "跨页网络可能不完整",
    );
  }
  if (missing.length > 0) {
    for (const item of missing) add(`- ${item}`);
  } else {
    add("- 无");
  }
  add();

  add("## 六、结论");
  add();
  if (mismatches.length > 0 || findings.some((finding) => finding.level === "🔴")) {
    add("**需修改**：存在网络冲突或两侧不一致，先解决再讨论打样。");
  } else if (missing.length > 0) {
    add("**无法完整判定**：解析已完成，但上述数据缺失项会限制结论范围。");
  } else {
    add("**解析通过**：自动检查项无异常。设计正确性仍需按检查清单人工核对。");
  }
  add();
  add("---");
  add();
  add("本报告由工程文件机械解析生成。所有数字可在同目录产物中复查：");
  add("`meta.json` / `schematic_*.json` / `nets.json` / `pcb_netlist.csv` / `pcb_geometry.json`。");
  return lines.join("\n");
}
