# 来源与处置表（ngspice 仿真）

## 来源

- 源仓库：`https://github.com/LeonhardtHUST/leonskill-easyeda-ngspice-sim`
- 版本：v2.6.1
- 检出 commit：`8c5c1cacf0e3335009465e6599a417d51258bf59`（`git -C <源仓库> rev-parse HEAD`，2026-11-02）
- 归属：自有内容在本项目中统一采用 GPL-3.0-only，不作为外部致谢，不另设源仓库旧许可约束。外部依赖与设计参考另见根目录 CREDITS.md。
- 合并方：lceda-connect（本仓库）

本目录（`assets/skills/ngspice-sim/`）放的是源仓库根目录的 SKILL.md 与知识类文档，原样复制，只做了这些删减：

- 未收录版本过程文档：`ARCHITECTURE_v2.2`~`v2.5`、`CHANGELOG_v2.2`~`v2.6.1`、`examples/`、`skill-dependencies.json`、`pytest.ini`、`requirements-*.txt`（后两者在 sidecar 目录）。
- `validation_registry.json` 一并收进来，`VALIDATION_STATUS.md` 与它配套。
- 命令示例里的 `~/.workbuddy/skills/...` 路径没有改，那是源技能的安装布局；在本仓库里等价入口是 `lceda-connect sim ...`。

sidecar 脚本在 `assets/sidecar/ngspice-sim/`：

- `scripts/*.py`：源仓库 `scripts/` 下全部 52 个 Python 文件，逐字节复制。
- `scripts/models/*.json`：`behavioral.json`、`discrete.json`、`generic.json`、`model_map.json`；`simlib_pack.json`（122 KB 的管脚映射大表，本轮不用）未复制。
- `requirements-core.txt`、`requirements-rf.txt`、`requirements-em.txt`。
- 未复制：`.sh` 入口（`_opts.sh`、`sim_file.sh` 等 8 个）、`scripts/js/`（3 个 bridge 提取脚本）。

## 硬编码路径

源仓库里 `C:\Users\Leon\...` 与 `~/.workbuddy/binaries/ngspice/ngspice-47/Spice64/bin/ngspice_con.exe`
的写法，在 TS 侧统一改为 配置 → 环境变量 → 探测：

1. `sim_config.json` 的 `ngspice_bin`（工具参数 `ngspiceBin` 也可直接给）
2. 环境变量 `NGSPICE_BIN`
3. `PATH` 里的 `ngspice_con` / `ngspice`
4. `%USERPROFILE%\.workbuddy\binaries\ngspice\<版本>\Spice64\bin\ngspice_con.exe`
5. 常见安装路径 `%ProgramFiles%\ngspice\Spice64\bin\ngspice_con.exe`、`C:\Spice64\bin\ngspice_con.exe`

Python 解释器按 `LCEDA_PYTHON` → `python` → `py -3` 探测。

## 逐脚本处置

### 已移植为 TS（运行行为对齐源脚本）

| 源脚本 | 落点 | 说明 |
| --- | --- | --- |
| `sim_config.py` | `src/sim/config.ts` | DEFAULTS、深合并、路径解析、`spice_ident`/`spice_node`/`display_node`、`Namer`、`quote_path` |
| `ir_common.py` | `src/sim/ir.ts` | `clean_value`/`normalize`/`validate`、IR 版本与字段；bridge 三段式提取前端未移植（在线入口由 `src/bridge` 提供） |
| `ir_from_analysis.py` | `src/sim/ir.ts` | `fromSchematicIr`、`fromEpro2File`（上游改为本仓库 `src/epro2`） |
| `ground.py` | `src/sim/ground.ts` | 地映射策略、默认只映射 GND/GROUND/0、显式合并与冲突检测 |
| `build_deck.py` | `src/sim/deck.ts` | 网表清洗、`.control` 注入、`.end` 整行锚定、默认 tran/ac 参数 |
| `parse_raw.py` | `src/sim/raw.ts` | ASCII 与二进制 raw、多 plot、complex 值对、CSV 导出 |
| `metrics.py` | `src/sim/metrics.ts` | tran_stats/threshold_crossings/time_delta/impedance/fft_harmonics、节点名兼容、复数轴拆解 |
| `sim_manifest.py` | `src/sim/manifest.ts` | manifest 字段、fidelity 段落、文件哈希与 ngspice 版本 |
| `model_resolver.py` | `src/sim/models.ts` | 匹配优先级、subckt 引脚校验、`nc_pins`、`.include`/`.lib` 去重与引号路径 |
| `netlist_gen.py` | `src/sim/netlist.ts` | 器件分类优先级、`parse_voltage`、电压源、R/C/L/D/Q/M、X 开头子电路实例、strict 下 `UNMAPPED_IC`、auto/explicit 电源、泛化模型卡 |
| `stackup.py` | `src/sim/stackup.ts` | `Stackup`（from_file/from_pcb/fill_from/validate）、Hammerstad-Jensen 微带、IPC-2141 带状线 |
| `trace_extract.py` | `src/sim/stackup.ts` | `estimateNetTrace`/`estimateGeometryTrace`，标记 `ANALYTIC_ESTIMATE` |
| `via_extract.py` | `src/sim/stackup.ts` | `viaParasitics`/`estimateVias`，标记 `ENGINEERING_ESTIMATE` |
| `parasitics.py` | `src/sim/parasitics.ts` | `parse_eng`、`td_from_length`、RLC/传输线/bead/连接器构造器、波形文本 |
| `touchstone.py` | `src/sim/touchstone.ts` | 频率单位、RI/MA/DB、`#` 选项行、`!` 注释、折行、非 S 参数明确报错 |
| `sparam_metrics.py` | `src/sim/touchstone.ts`（部分） | 只移植插损/回损/-3 dB 带宽/1 端口 \|Z\|；完整 RF 指标继续走 sidecar |
| `sweep_runner.py`（`run_ngspice`） | `src/sim/ngspice.ts` | batch 执行与超时；扫描编排本身在 sidecar |
| `sim_exec.py`（单次分析） | `src/sim/run.ts` | deck → ngspice → raw → 指标 → manifest；sweep/pdn/sparam/mc/corner 走 sidecar |

### 原样保留为 sidecar（`assets/sidecar/ngspice-sim/scripts/`）

依赖 numpy / scipy / scikit-rf，或规则密集、本轮不逐行移植：

| 类别 | 脚本 |
| --- | --- |
| RF / 网络代数 / 拟合 | `rf_network.py`、`network_validate.py`、`vector_fit.py`、`deembed.py`、`diff_port.py`、`coupled_line.py`、`sparam_element.py`、`sparam_metrics.py`、`rlgc.py` |
| 实测相关 / 参数拟合 | `parameter_fit.py`、`correlate.py`、`measurement_import.py`、`compare_runs.py` |
| EM 桥 | `em_bridge.py`、`pcb_em.py`、`solver_backend.py` |
| override / 行为级 / IBIS | `override_apply.py`、`behavioral_models.py`、`ibis_parser.py`、`ibis_model.py`、`ibis_to_spice.py` |
| PCB 几何 / 提参 | `pcb_geometry.py`、`pcb_to_override.py`、`trace_extract.py`（sidecar 版仍可独立跑） |
| PDN / 扫描 / 蒙特卡洛 / 执行器 | `pdn_multiport.py`、`sweep_runner.py`、`monte_carlo.py`、`sim_exec.py`、`sim_cache.py`、`sim_workspace.py`、`sim_file.sh` 系列（未收 .sh） |
| 报告 / 图形 / 校验 | `report.py`、`svg_schematic.py`、`fft_analysis.py`、`spectral_metrics.py`、`validation.py`、`router.py` |
| 依赖定位 / 连通性 | `analysis_dep.py`、`connectivity.py`：上游职责已由 `src/epro2` 取代，仅作参考保留 |

调用方式：`lceda-connect sim` 与 MCP `sim_sidecar` 工具（需 `confirm: true`），
实现在 `src/sim/sidecar.ts`，只接受 sidecar 目录下的裸 `.py` 文件名。

## 与源仓库的行为差异

1. 源仓库的 override / behavioral / IBIS 三个注入层在 TS 侧未实现。IC 没有 `model_map` 映射时直接排除，`strict` 下报 `UNMAPPED_IC`（源仓库会先试 IBIS，再试行为级占位）。
2. 离线入口的 `.epro2` 解析改由本仓库 `src/epro2` 提供，不再有 `DEPENDENCY_MISSING` 分支。
3. `SKILL_VERSION` 常量保持源脚本里的 `2.6.0`（deck 头与 manifest 都写它），仓库标签是 v2.6.1。
4. 源仓库的 `.sh` 入口与 sweep/pdn/mc/corner 的 `sim_file.sh` 编排没有对应 CLI 子命令；这些走 `sim_sidecar` 或后续迭代。
