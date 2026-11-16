# 立创 EDA API 索引（全量）

> 由 `scripts/lceda-doc-index.py` 从 `manifest.json` 生成，**不要手改**（重跑即覆盖）。
> 来源指纹 `f8e0909a6c29`，共 3553 页 / 3553 条目。

## 怎么用

1. 先在下面找到**要做的事**对应的模块（例如画线 → `pcb_primitiveline`）。
2. 需要方法签名/参数时，读 `docs/lceda-pro/v3.2.x/cn/api/reference/pro-api.<模块>.<方法>.md`。
3. **分发包内没有 `docs/`**（它被 `export-ignore`）：此时只有本索引可用，正文需在完整 clone 里查。

覆盖：420 个模块 / 2603 个方法页；verb 有文档映射 107/124（未覆盖 17 个，属**尚未建映射**，不是「不需要」）。

## PCB 模块（按方法数）

| 模块 | 方法数 | 代表方法 |
|---|---:|---|
| `pcb_drc` | 46 | addnettoequallengthnetgroup, addnettonetclass, addpadpairtopadpairgroup |
| `pcb_manufacturedata` | 30 | deletebomtemplate, get3dfile, get3dshellfile |
| `pcb_document` | 25 | autolayout, autorouting, clearrouting |
| `pcb_layer` | 25 | addcustomlayer, deletephysicalstackingconfiguration, getalllayers |
| `pcb_net` | 16 | getallnetname, getallnets, getallnetsname |
| `pcb_primitivecomponent` | 11 | create, delete, get |
| `pcb_raytracerengine` | 11 | addsceneelement, dispose, exportimage |
| `pcb_event` | 10 | addcrossprobeselecteventlistener, addimageeventlistener, addmouseeventlistener |
| `pcb_mathpolygon` | 10 | calculatebboxheight, calculateheight, calculatewidth |
| `pcb_primitivearc` | 7 | create, delete, get |
| `pcb_primitivedimension` | 7 | create, delete, get |
| `pcb_primitivefill` | 7 | create, delete, get |
| `pcb_primitiveimage` | 7 | create, delete, get |
| `pcb_primitiveline` | 7 | create, delete, get |
| `pcb_primitiveobject` | 7 | create, delete, get |
| `pcb_primitivepad` | 7 | create, delete, get |
| `pcb_primitivepolyline` | 7 | create, delete, get |
| `pcb_primitivepour` | 7 | create, delete, get |
| `pcb_primitiveregion` | 7 | create, delete, get |
| `pcb_primitivestring` | 7 | create, delete, get |
| `pcb_primitivevia` | 7 | create, delete, get |
| `pcb_selectcontrol` | 7 | clearselected, docrossprobeselect, doselectprimitives |
| `pcb_primitiveattribute` | 6 | delete, get, get_1 |
| `pcb_primitivepoured` | 5 | delete, get, get_1 |
| `pcb_imagetool` | 4 | processimage, runinsertimagecommand, startplacetruecolorpicture |
| `pcb_primitive` | 2 | getprimitiveboardline, getprimitivesbbox |
| `pcb_tool` | 0 | （仅总览页） |

### 其余 393 个模块（非 PCB 侧，明细读同名 JSON 的 `modules`）

按命名空间（括号内为模块数）：`ipcb`(47)、`ilib`(37)、`sys`(29)、`isys`(28)、`epcb`(27)、`esys`(21)、`isch`(21)、`sch`(21)、`tpcb`(19)、`esch`(15)、`idmt`(14)、`dmt`(11)、`lib`(10)、`edmt`(8)、`elib`(5)、`tsys`(5)

另有 75 个单模块命名空间（类型/属性定义，如 `*props`、`*config`），一模块一命名空间，未逐一列出。

## verb → 文档页

| verb | 文档页数 |
|---|---:|
| `add_custom_layer` | 3 |
| `add_keepout` | 4 |
| `aesthetic_lint` | 4 |
| `annotate_dimension` | 2 |
| `arrange_split_screen` | 4 |
| `auto_layout_pcb` | 1 |
| `boolean_polygon_op` | 4 |
| `clear_pcb_routing` | 2 |
| `close_document` | 2 |
| `compare_designs` | 6 |
| `configure_layer_appearance` | 3 |
| `convert_altium_lib_to_easyeda` | 1 |
| `create_lib_device` | 3 |
| `create_lib_simulation_model` | 1 |
| `create_panel_file` | 1 |
| `create_panel_lib` | 1 |
| `create_pcb_doc` | 3 |
| `create_pcb_pad` | 4 |
| `create_project` | 4 |
| `cross_probe_select` | 3 |
| `define_diffpair` | 1 |
| `delete_lib_device` | 3 |
| `delete_pcb_component` | 1 |
| `draw_pcb_polyline` | 4 |
| `draw_sch_wire` | 4 |
| `eda_builtin_place` | 1 |
| `edit_cbb_metadata` | 3 |
| `edit_pcb_component_props` | 14 |
| `export_altium` | 1 |
| `export_dsn` | 1 |
| `export_gerber` | 1 |
| `export_lib_item_file` | 3 |
| `export_project_file` | 4 |
| `export_sch_manufacture_file` | 3 |
| `filter_layer_visibility` | 3 |
| `goto_sch_coordinates` | 1 |
| `highlight_pcb_nets` | 4 |
| `import_pcb_changes_to_sch` | 2 |
| `import_project_file` | 1 |
| `import_sch_changes_to_pcb` | 2 |
| `init_raytracer_engine` | 1 |
| `list_pcbs` | 1 |
| `list_projects` | 4 |
| `lock_layer` | 3 |
| `manage_cbb` | 3 |
| `manage_lib_3d_model` | 5 |
| `manage_lib_footprint` | 4 |
| `manage_lib_symbol` | 8 |
| `manage_pcb_drc_group` | 10 |
| `manage_sch_pages` | 4 |
| `manufacture_export` | 12 |
| `measure_polygon_area` | 1 |
| `modify_lib_device` | 2 |
| `modify_pcb_attribute` | 2 |
| `modify_pcb_string` | 2 |
| `modify_sch_attribute` | 2 |
| `modify_sch_component` | 2 |
| `move_project_to_folder` | 5 |
| `navigate_pcb_view` | 2 |
| `open_project` | 6 |
| `order_components_bom` | 1 |
| `overwrite_pcb_net_rules` | 2 |
| `place_cbb_instance` | 1 |
| `place_component` | 2 |
| `place_net_label` | 4 |
| `place_pcb_fill` | 3 |
| `place_pcb_graphic` | 2 |
| `place_pcb_image` | 4 |
| `place_pcb_item_with_mouse` | 2 |
| `place_pcb_via` | 4 |
| `place_sch_arc` | 1 |
| `place_sch_graphic` | 5 |
| `place_sch_image` | 1 |
| `place_sch_net_flag` | 3 |
| `place_sch_pin` | 3 |
| `pour_create` | 5 |
| `pour_rebuild` | 4 |
| `query_pcb_primitives_in_region` | 6 |
| `read_document_content` | 2 |
| `read_layer_stackup` | 2 |
| `read_pcb_components` | 3 |
| `read_pcb_filter_config` | 1 |
| `read_pcb_net_stats` | 3 |
| `resolve_library_uuid` | 1 |
| `route_net` | 2 |
| `run_drc` | 2 |
| `run_sch_drc` | 1 |
| `save_file_to_disk` | 3 |
| `save_panel_document` | 5 |
| `search_lib_device` | 2 |
| `search_log` | 3 |
| `select_active_layer` | 1 |
| `select_pcb_primitives` | 4 |
| `select_sch_primitives` | 4 |
| `set_board_stackup` | 3 |
| `set_pcb_canvas_origin` | 2 |
| `set_pcb_embedded_object` | 6 |
| `set_pcb_netlist` | 2 |
| `set_sch_netflag_symbol` | 3 |
| `set_sch_page_title_block` | 3 |
| `silk_annotate` | 1 |
| `switch_unit` | 4 |
| `switch_workspace` | 3 |
| `toggle_lib_panel` | 2 |
| `toggle_side_panel` | 6 |
| `write_rule_table` | 1 |
| `zoom_canvas` | 5 |

> 每个 verb 具体映射到哪几页，读同名 JSON 的 `verb_docs`；运行时用 `python scripts/lookup.py <verb> --kind api` 查，别在这张表里找符号名。

另有 8 个 verb 只有证据页（edges/hints）而无 API 方法页：`apply_design_rules`、`canvas_image`、`place_component_sch`、`place_designators`、`read_board_state`、`render_review`、`route_diffpair`、`undo`（见同名 JSON 的 `verb_doc_pages`）。

未建映射的 verb（17）：`align_components`、`apply_design_rules`、`auto_place`、`canvas_image`、`cluster_components`、`menu_tree`、`place_component_sch`、`place_designators`、`plan_layout`、`read_board_state`、`relayout_route`、`render_review`、`rollback`、`route_diffpair`、`route_external`、`toggle_realtime_drc`、`undo`

> `basis`/`verified` 明细读同名 JSON：`code` = 函数体真实调用，`routes.entry` = 路由描述；`verified` 恒为 `false`。
> 表中只证明「我们调过这个 API、且文档页存在」，
> 不证明「这页就是该行为的权威说明」。判定一律以运行时结果为准。
