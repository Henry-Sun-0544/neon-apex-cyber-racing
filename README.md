# Neon Apex: Cyber Racing

**霓虹之巅：赛博竞速** · 简称 **NA:CR**

一个完全在浏览器中运行的 3D 赛车游戏，**双风格**（赛博朋克 / 真实风格）+ **双地图模式**（闭环赛道 / 开放世界）。
赛道、城市、地形、道路网、赛车、粒子、音乐与音效**全部由代码程序化生成**，不依赖任何外部模型、贴图或音频素材。

技术栈：**Vite + TypeScript + Three.js**（无 React/Vue 等框架，UI 为原生 HTML/CSS；Three.js 来自 npm，未使用 CDN）。

---

## 快速开始

```bash
cd neon-apex-cyber-racing
npm install
npm run dev
```

打开终端输出的地址（默认 <http://127.0.0.1:5173/>），在开始菜单选择 **风格 / 画质 / 地图模式**，然后点击 **START ENGINE**。

```bash
npm run build      # 类型检查 (tsc --noEmit) + 生产构建，产物在 dist/
npm run preview    # 预览生产构建
npm run typecheck  # 只做类型检查
```

---

## 第二轮新增内容一览

| 需求 | 实现 | 位置 |
| --- | --- | --- |
| 第二种风格「真实风格」 | `RealisticStyle`：官方 `Sky` 大气散射 + 内置体积云 + 昼夜循环 + PMREM 环境光 + PBR 材质 + 天气 | `src/game/styles/RealisticStyle.ts` |
| 风格运行时可切换 | 开始菜单 / 暂停菜单 / 设置面板 / `T` 快捷键，切换时**只重建表现层**，比赛状态零丢失 | `src/game/styles/StyleManager.ts`、`Game.setStyle` |
| 质量预设 低/中/高/极致 | `QualityManager` 四档 + 自动降级阶梯（SSR→SSAO→体积光→阴影→LOD） | `src/game/QualityManager.ts` |
| 后处理 | SSAO、Bloom、GodRays（径向散射）、SSR（屏幕空间反射）、景深、运动模糊、调色/暗角/胶片颗粒/色差、SMAA | `src/game/PostProcessingStack.ts` |
| 程序化 PBR 材质库 | 沥青（含裂缝/水坑/轮胎压痕）、混凝土、金属、车漆清漆、玻璃、轮胎胎纹、水法线、云、雨丝 + Sobel 法线图 | `src/game/MaterialLibrary.ts` |
| 复杂地形 | 逻辑 1024×1024 高度场（按需采样、不落地存储）+ 分块流式加载 + 道路挖填方 + 生物群系顶点着色 | `src/game/world/TerrainSystem.ts` |
| 生物群系 | 海洋 / 海岸 / 草原 / 森林 / 沙漠 / 岩地 / 高山 / 湿地 / 城区 | `src/game/world/BiomeSystem.ts` |
| 复杂道路网 | 图结构（节点/边/道路等级/车道/限速）+ 样条：高速、城市街、山路发卡、隧道、大桥、立交匝道、环岛、越野小径 | `src/game/world/RoadNetwork.ts`、`RoadGenerator.ts` |
| 写实城市 | 分区（市中心/商业/住宅/工业/港口/公园）+ 程序化楼宇 + 实例化道具（空调外机、天线、遮阳篷、垃圾桶、长椅、棕榈、消防栓、红绿灯） | `src/game/world/RealisticCity.ts` |
| 动态交通 | 沿车道图行驶的 AI 车流（跟车、隧道减速）+ 与玩家的圆形碰撞反馈 | `src/game/world/TrafficSystem.ts` |
| 最高精度车辆 | 合并几何高精度车：车漆清漆、玻璃、轮毂辐条、刹车盘/卡钳、胎纹、后视镜、扰流板、车牌、排气、内饰、螺栓 | `src/game/VehicleFactory.ts` |
| 雨雪 | 跟随相机的循环降水层（雨丝 / 雪花），密度跟随天气 | `src/game/ParticleSystem.ts` |
| 风格化音频 | 赛博朋克 synthwave 音序器 / 真实风格程序化城市环境音 + 雨声 | `src/game/AudioManager.ts` |
| UI | 开始菜单 + 暂停菜单（`P`/`Esc`）+ 加载遮罩 + HUD 风格徽章 + UI 主题随风格换色 | `index.html`、`src/styles.css`、`src/game/UIManager.ts` |

---

## 操作说明

| 按键 | 作用 |
| --- | --- |
| `W` / `↑` | 加速 |
| `S` / `↓` | 刹车；低速时倒车 |
| `A` / `D` / `←` / `→` | 转向（转向力度随车速下降） |
| `空格` | 氮气（按住消耗，松开回充） |
| **`T`** | **切换风格：赛博朋克 ⇄ 真实风格** |
| **`Y`** | **循环切换画质预设：低 → 中 → 高 → 极致** |
| `C` | 切换第三人称 / 引擎盖视角 |
| `P` / `Esc` | 暂停菜单（内含风格 / 画质 / 地图 / 天气切换） |
| `M` | 静音 / 取消静音 |
| `R` | 重新开始本局 |
| `B` | 碰撞线框调试 |

---

## 风格系统

### 赛博朋克 CYBERPUNK（默认）

Round 1 的完整延续：程序化 synthwave 夜空穹顶（霓虹渐变 + 700 颗星 + 品红月亮）、紫色环境光、品红轮廓光、发光霓虹赛道边线、护栏、脚手柱、霓虹门架、体积雾感与 `UnrealBloomPass` 辉光。**未被第二轮改动破坏，仍可完整游玩。**

### 真实风格 REALISTIC

- **天空**：Three.js 官方 `Sky`（Preetham 大气散射）+ r186 内置程序化体积云，太阳随时间移动。
- **昼夜循环**：默认 11:00 开局，一场比赛内可见光色变化；`__NACR__.sceneInfo()` 会返回当前 `clock`。
- **光照**：方向光太阳（VSM 软阴影，阴影贴图 1024 / 2048 / 3072）、月光、半球光、环境光、补光；阴影视锥跟随玩家。
- **环境光探针**：从天空生成 PMREM 立方图，让所有 PBR 材质获得真实环境反射（生成探针时会把天空调暗到 IBL 合理曝光，见下）。
- **天气系统**：晴 / 薄雾 / 多云 / 降雨 / 暴雨 / 降雪，自动循环或由玩家固定；天气影响雾密度、云量、曝光、路面湿度与降水粒子。
- **湿滑路面**：沥青粗糙度贴图内置水坑，配合环境反射与 SSR 呈现反光效果。
- **后处理**：ACES 色调映射 + 曝光自适应 + SSAO + Bloom + GodRays + 景深 + 运动模糊 + 调色（对比/饱和/色温/暗角/胶片颗粒/色差）。

### 运行时切换（硬性要求）

切换入口：

1. **开始菜单** → GAME MODE / 模式设置 → 风格。
2. **暂停菜单**（`P` 或 `Esc`）→ 风格按钮，可随时来回切换。
3. **设置面板**：与开始菜单共用同一组选项容器（`[data-group="style"]`），任何一处的改动都会同步到全部入口。
4. **快捷键 `T`**：比赛中直接切换。

切换表现：

- 显示短暂加载遮罩「正在切换到真实风格…」/「SWITCHING TO REALISTIC · 保留比赛状态」。
- 切换成功后 HUD 徽章、暂停菜单摘要、小地图配色与整个 UI 主题（CSS 变量）同步更新。
- 切换失败会**自动回滚**到上一个可用风格，并弹出提示与错误信息。
- 选择持久化在 `localStorage['nacr-style']`，下次启动自动恢复。

### 切换时保留 / 重建的内容

| 类别 | 项目 | 切换风格时 |
| --- | --- | --- |
| **保留** | 比赛进行状态（`phase`） | ✅ 不变 |
| | 当前圈数 / 总圈数 | ✅ 不变 |
| | 总时间 / 当前圈时间 / 最佳圈速 | ✅ 不变（时钟继续走） |
| | 玩家位置、朝向、速度、加速度 | ✅ 不变（模型重建不触碰物理状态） |
| | 氮气能量、加速带状态 | ✅ 不变 |
| | AI 车辆位置、速度、圈数、排名 | ✅ 不变 |
| | 检查点进度 | ✅ 不变 |
| | 当前地图模式 / 画质预设 / 音量与静音 | ✅ 不变 |
| **重建** | 天空、太阳、月亮、云、雾、大气 | ♻️ 重建 |
| | 全局光照（环境/半球/方向/点/聚光） | ♻️ 重建 |
| | 后处理栈（Bloom/SSAO/SSR/SMAA/DoF/运动模糊/调色） | ♻️ 重建 |
| | 材质与外观（车漆、路面、建筑、玻璃、金属、霓虹） | ♻️ 重着色（几何复用） |
| | 城市外观、广告牌、路灯、霓虹条、护栏、反光钉 | ♻️ 隐藏 / 换材质 |
| | 粒子风格（霓虹火星 / 雨雪尘埃） | ♻️ 切换 |
| | 音频风格（Synthwave / 城市环境音 + 雨声） | ♻️ 切换 |
| | UI 配色 | ♻️ 切换 |

> 地图模式切换（赛道 ⇄ 开放世界）会**换整条赛线**，因此会重开本局；风格与画质保持不变。地图选择同样持久化在 `localStorage['nacr-mapmode']`。

### 两风格差异速览

| | 赛博朋克 | 真实风格 |
| --- | --- | --- |
| 时间 | 恒定深夜 | 昼夜循环 + 天气 |
| 天空 | 手绘 synthwave 穹顶 | 大气散射 + 体积云 |
| 光照 | 环境光 + 半球光 + 月光 + 霓虹点光 | 太阳/月亮方向光 + 阴影 + PMREM 环境光 |
| 阴影 | 关闭（夜城用不上） | VSM 软阴影，1024~3072 |
| 路面 | 霓虹边线 + 自发光条 | 沥青 PBR + 车道线 + 水坑 + 反光钉 |
| 城市 | 霓虹楼群 + 招牌 + 全息广告 | 混凝土/玻璃幕墙 + 暖光窗 + 街具 + 港口 |
| 车辆 | 霓虹描边 + underglow + 发光轮毂 | 清漆车漆 + 真实玻璃 + 胎纹 + 刹车盘 |
| 后处理 | Bloom + 高饱和调色 | SSAO + SSR + Bloom + GodRays + DoF + 胶片调色 |
| 音频 | Synthwave 音序器 | 程序化城市环境音 + 雨声 |
| UI | 霓虹紫/青/粉 | 写实灰/白/蓝/橙，低饱和 |

---

## 地图模式

| 模式 | 说明 |
| --- | --- |
| **赛道模式 CIRCUIT** | Round 1 的闭环高架霓虹赛道（约 1 691 m），全套霓虹细节。 |
| **开放世界 OPEN WORLD** | 约 **2.4 km × 2.4 km 程序化岛屿**，赛线约 **8.7 km**，包含：城市街区、环路高速、山路发卡、隧道、跨湖大桥（含桥塔与拉索）、立交匝道、环岛、海岸公路、越野小径；另有约 20 条支路供车流与自由探索。 |

开放世界生成顺序（体现各系统依赖）：

1. `TerrainSystem` 先生成原始岛屿高度场（此时还没有道路）；
2. `RoadNetwork` 在岛屿上"铺"出赛线与支路（高程经过平滑 + 纵坡钳制 ≤9%，桥段平滑抬升）；
3. `terrain.setCorridor(roads)` —— 地形此时才**挖填方**贴合道路，形成路堑、路肩与交汇口；隧道与桥面段**不切削地形**；
4. `RealisticCity` 只在干燥、平缓、且离车道足够远的格点建房；
5. `TrafficSystem` 在车道图上布置车流；
6. `StreamingManager` 按画质预算分块流式加载。

---

## 质量预设与自动降级

| 预设 | 阴影 | SSAO | SSR | 体积光 | 景深 | 纹理 | 交通 | 细节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 低 LOW | 关 | 关 | 关 | 关 | 关 | 256 | 12 | 0.35 |
| 中 MEDIUM | 1024 | 关 | 关 | 关 | 关 | 512 | 22 | 0.6 |
| 高 HIGH | 2048 | ✅ | 关 | ✅ | 关 | 512 | 34 | 0.85 |
| 极致 ULTRA | 3072 | ✅ | ✅ | ✅ | ✅ | 1024 | 46 | 1.0 |

自动降级阶梯（连续两个 2.5 s 采样窗口低于 34 FPS 才降一级，避免单帧卡顿误判）：

1. 关闭 SSR / 体积光
2. 关闭 SSAO / 景深 / 运动模糊
3. 阴影分辨率减半、像素比降至 1、关闭环境光探针
4. LOD 降级、城市细节与交通减半、地形视距 -1
5. 关闭 Bloom 与 SMAA

降级只在当前风格内进行，**绝不会自动切回赛博朋克风格**（需用户确认）。HUD 会显示 `AUTO ↓ <原因>` 徽章。

---

## 项目结构

```
neon-apex-cyber-racing/
├── index.html                     # canvas / HUD / 开始菜单 / 暂停菜单 / 结算 / 加载遮罩
├── src/
│   ├── main.ts                    # 入口：URL 参数、错误收集、启动 Game
│   ├── styles.css                 # 原生 CSS，双主题（CSS 变量驱动的 UI 换肤）
│   └── game/
│       ├── Config.ts              # 唯一调参中心（车辆/AI/相机/音频/粒子/风格/世界）
│       ├── Types.ts  Utils.ts  Input.ts
│       ├── Game.ts                # 编排器：主循环、模式切换、热键、HUD 刷新
│       ├── GameState.ts           # 圈数、计时、过线检测、排名、结算
│       ├── SceneManager.ts        # 渲染器、相机、风格装配、质量应用
│       ├── QualityManager.ts      # 四档预设 + 自动降级阶梯
│       ├── PostProcessingStack.ts # SSAO/Bloom/GodRays/SSR/DoF/调色/SMAA 链
│       ├── MaterialLibrary.ts     # 程序化 PBR 贴图与材质 + 主题换装（applyTheme）
│       ├── VehicleFactory.ts      # 高精度合并几何车辆
│       ├── CarModel.ts            # Round 1 低多边形车辆（低画质档仍在用）
│       ├── VehicleBase.ts         # 共享街机物理 + 细节档位切换
│       ├── PlayerVehicle.ts  AIVehicle.ts  AIController.ts
│       ├── CollisionSystem.ts     # 空间哈希：护墙/建筑/车车碰撞 + 自救
│       ├── ParticleSystem.ts      # 4 个 GPU 粒子池 + 雨雪降水层
│       ├── AudioManager.ts        # Synthwave 音序器 + 城市环境音 + 雨声
│       ├── UIManager.ts           # 菜单/HUD/暂停/结算/加载遮罩 + Canvas 小地图
│       ├── DebugOverlay.ts
│       ├── Track.ts               # Round 1 闭环赛道（仍完整保留）
│       ├── City.ts                # Round 1 赛博城市（仍完整保留）
│       ├── styles/
│       │   ├── GameStyle.ts       # 风格基类 + 调色板 + 元数据
│       │   ├── CyberpunkStyle.ts  ├── RealisticStyle.ts
│       │   └── StyleManager.ts    # 持久化 + 失败回滚
│       └── world/
│           ├── MapMode.ts  RaceWorld.ts  SplinePath.ts  Noise.ts
│           ├── TerrainSystem.ts  BiomeSystem.ts  StreamingManager.ts
│           ├── RoadNetwork.ts  RoadGenerator.ts
│           ├── RealisticCity.ts  TrafficSystem.ts  OpenWorld.ts
│           └── WeatherState.ts
├── tools/
│   ├── smoke-test.mjs             # Round 1 端到端冒烟测试
│   ├── verify-round2.mjs          # Round 2 端到端验证（53 项断言）
│   ├── visual-probe.mjs           # 画面客观统计（天空/地平线/地面亮度 + 后处理二分）
│   └── validate-track.mjs
└── package.json  vite.config.ts  tsconfig.json
```

---

## 调试参数（URL query）

| 参数 | 作用 |
| --- | --- |
| `?autostart=1` | 跳过开始菜单直接开赛 |
| `?nocount=1` | 跳过 3-2-1 倒计时（隐含 autostart） |
| `?autopilot=1` | 观战模式：由 AI 驾驶玩家车辆（隐含 autostart） |
| `?laps=N` | 覆盖比赛圈数 |
| `?car=hellcat\|gtr\|modely\|concept` | 指定车库选车 |
| `?style=cyberpunk\|realistic` | 指定初始风格（默认读取 localStorage） |
| `?quality=low\|medium\|high\|ultra` | 指定初始画质 |
| `?map=circuit\|openworld` | 指定初始地图模式 |
| `?lowfx=1` | 低画质预设 + 粒子池减为 1/4（软件渲染 / 自动化测试用） |

### 运行时调试句柄

浏览器控制台中的 `window.__NACR__`：

```
只读：phase speedKmh lap yaw rank raceTime aiCount particles bloom postFx fps nitro
      boosting resultsVisible hudVisible hudSpeed hudLap aiProgress debug car
      style styleName quality qualityDegraded mapMode paused worldLength worldId
      throttle parked slope hudStyle hudQuality hudMode
方法：snapshot()   — 风格切换回归测试用的完整状态快照
      sceneInfo()  — 雾/背景/环境光探针/相机/曝光/时钟
      health()     — WebGL 上下文 + 控制 + 场景健康度
      padMisalignmentDeg()
      start() restart() pause(on)
      setStyle(id) toggleStyle() setQuality(id) setMapMode(id) setWeather(id)
      fxOverride({...})   debugRender({shadows, environment})
```

### 自动化测试

```bash
npm run dev                  # 另开一个终端保持运行
node tools/smoke-test.mjs    # Round 1 冒烟测试（赛道 + 合成按键驾驶）
node tools/verify-round2.mjs # Round 2 验证：53 项断言（当前全部通过）
node tools/visual-probe.mjs  # 画面亮度客观统计（二分定位后处理问题）
```

`verify-round2.mjs` 覆盖：

1. **赛道 + 赛博朋克基线**：开赛、行驶、HUD 徽章、渲染健康度。
2. **运行时风格切换（比赛进行中）**：切换后风格已换，阶段/圈数/总时间/最佳圈速/名次/氮气/位置全部保留，AI 状态保留，画面确实变化，渲染健康，HUD 徽章与 UI 主题更新，`localStorage` 已写入；切换后仍能正常加速行驶。
3. **切回赛博朋克 + 4 档画质**：状态继续保留，每档都能安全应用。
4. **开放世界**：地图模式切换成功、生成了更长的新赛线（1 691 m → 8 746 m）、比赛在新赛线上重新开始、车辆可行驶、HUD 更新、偏好已持久化、在开放世界中同样可以切换风格。
5. **菜单与暂停**：开始菜单与暂停菜单**各自**都有风格/画质/地图/天气选择器（共 8 个选项容器，由同一份逻辑填充并双向同步）；`P` 暂停后比赛时钟冻结；可从暂停菜单切换风格（遮罩正常隐藏、暂停界面保留、切换后仍能继续驾驶）；可从暂停菜单固定天气；`T` 切换风格、`Y` 切换画质。

---

## 已知限制

- **软件渲染（SwiftShader / 无头）**：`dt` 上限 1/20 s，帧率低时游戏内时钟会慢于真实时间；HUD 的 FPS 按仿真时间统计，会高于真实帧率。真实 GPU 环境（Apple Silicon + Chrome）实测流畅。
- **`PCFSoftShadowMap` 已被 three r186 移除**：真实风格改用 `VSMShadowMap` 提供软阴影（软阴影档位），非软档使用 `PCFShadowMap`。
- **曝光自适应不是 GPU 直方图测光**：真实风格按太阳高度角与云量推算目标曝光（读回直方图会造成管线停顿），响应曲线与真实测光表类似。
- **SSR 为自研屏幕空间反射**：沿颜色缓冲做屏幕空间步进，能给出湿滑路面的反射感；未使用 three 官方 `SSRPass`（需要 G-buffer / selects 约定，开销过大）。可在极致档开启，也会被自动降级关闭。
- **开放世界切换会重开本局**（赛线变了）；风格切换不会。
- **两风格共享几何**：风格切换通过换材质 / 隐藏霓虹件实现，而不是生成两套场景，因此赛道模式的楼群轮廓在两种风格下相同（外墙材质、窗户、颜色、光照全变）。
- **碰撞体为盒体/圆柱近似**，极端角度下可能有轻微穿插；开放世界支路没有碰撞体（只有赛线护墙有隐式碰撞）。
- **音频在无用户手势时保持静音**：`AudioContext` 需要手势才能启动；代码已改为**不阻塞比赛开始**（早期实现会在第二次开赛时卡在 `resume()` 上）。
- 车辆是程序化风格化模型（虽然做了合并几何高精度化），非工业级 CAD 精度。

---

## 性能说明

- 后处理链、阴影、纹理分辨率、交通量、细节密度、地形视距全部由 `QualityManager` 统一预算，并在连续低帧时自动降级。
- 地形按块流式加载（分块 96~128 m，视距 2~5 环），只有相机周围的块被网格化。
- 道路几何按材质桶合并（全路网约 10 个 draw call），楼宇按外墙材质桶合并，道具、路灯、反光钉、车流全部使用 `InstancedMesh`。
- 车辆几何按材质合并，一辆高精度车约 13 个 draw call 而非数百个。
- 粒子池、降水层、车流都使用固定容量 + 游标复用，运行期不分配新对象。
