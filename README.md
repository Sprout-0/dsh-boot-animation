# dsh-boot-animation

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一段**开机动画**：打开一个还没说过话的新对话、或打开你钉住的会话时，视频铺满整个窗口播放，放完淡出进入工作区。

- **一个会话只播一次**（新对话的默认行为）
- **钉住的会话每次打开都播** —— 侧边栏页脚点一下图钉
- **铺满窗口**、可跳过、放完自动关闭
- **可以换成你自己的片子**

> **关于本仓库**：这是 [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) 的精简分支。内嵌片源只保留「DeepSeek 赛博朋克片头」一段（`lib/clips.data.js` 从 11.5 MB 降到 2.4 MB），并移除了部分开发脚本与文档。功能、路由、配置机制与上游一致。原作者署名见 `package.json` 与文末许可。

## 安装

本包**已提交构建产物 `lib/`**，所以从仓库安装时**不需要编译**，也不会触发 pnpm 的构建授权（`allowBuilds`）。

```sh
dsh plugin --profile desktop add github:Sprout-0/dsh-boot-animation --ignore-scripts
```

- **桌面客户端**读的是 `desktop` profile，而 `dsh --profile desktop` 被设计性拒绝；插件操作要用**客户端自带的 CLI**（Windows 上在 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`）。命令行 `dsh web` 则用 `--profile web`。
- **`--ignore-scripts` 别省掉。** pnpm 从 git 安装时，为了跑 `prepare` 生命周期会先装一遍包的 `devDependencies`（tsdown / rolldown / typescript，含 20 MB 的原生绑定）。实测：不带这个参数装出来是 **48.4 MB**，带上只有 **2.4 MB**。本包不需要构建，跳过没有任何副作用。
- 从 GitHub 安装需要能访问 `codeload.github.com`（国内直连通常不通，需代理）。**运行不需要网络。**

装完**必须重启一次 DSH**（bundle 层在启动时装配）。

### 装完看不到效果？

DSH 的客户端 bundle 响应带 `cache-control: max-age=31536000, immutable`，而 URL 上的 `rev` 是进程 nonce、不随内容变化 —— 浏览器会一直用第一次抓到的副本。请按 **Ctrl+Shift+R（硬刷新）**，普通 F5 不够。

## 用法

### 新对话自动播

打开一个还没说过话的新对话时会自动播一次。

### 让某个会话每次打开都播

1. 打开那个会话
2. 点侧边栏最下面的 **🎞** 图标（「设置」旁边）
3. 图标变绿 **🎬** = 已钉住

之后每次进入这个会话都会播一遍 —— 切走再切回来、刷新页面都算。再点一下取消。

> 如果启动时活动主面板不是「对话」（比如停在某个插件的面板上），当前会话还不存在，图钉是禁用状态。先打开一个对话即可。

## 换自己的片子

### 最省事的方式

1. 把 mp4 丢进 `~/.dsh/boot-animation/videos/`（Windows 上是 `C:\Users\<你>\.dsh\boot-animation\videos\`）
2. 点侧边栏页脚的 **🎛**（图钉旁边）打开片库
3. 点你想播的那一条，带 ✓ 即生效

片库面板底部会显示实际扫描路径。同一个视频存在多份副本时，片库按内容只列一条并标注「合并 N 份重复」，你的文件留在原处。

想立刻确认换对了没有，用面板里的 **▶ 预览当前**，不用等下一次触发。

### 支持格式

`.mp4` `.m4v` `.webm` `.mov` `.mkv` —— 但**能不能播取决于浏览器解码**。H.264 + AAC 的 mp4 最稳；HEVC(H.265)、ProRes、部分 mkv 大概率只有声或黑屏。

### 片源解析顺序

每次请求都重新解析，换片子不用重启：

| 顺序 | 位置 |
|---|---|
| 1 | `~/.dsh/boot-animation/selection.json` 里选中的 id（片库面板写的） |
| 2 | 环境变量 `DSH_BOOT_ANIMATION` 指向的文件 |
| 3 | `~/.dsh/boot-animation/intro.mp4`（历史落点） |
| 4 | `~/.dsh/boot-animation/videos/` 里最新修改的那个 |
| 5 | **内嵌的那段**（`lib/clips.data.js`）—— 永远兜得住，因为它在代码里 |

内嵌片段以 base64 存在 `lib/clips.data.js` 里，host 在第一次被请求时才 import；`media/*.mp4` 只是 `npm run embed-clips` 的输入，**不随包发布**。

### 替换内嵌片源（改成你自己的默认片）

把 mp4 放进 `media/`，改 `scripts/embed-clips.mjs` 里的清单，然后：

```sh
npm run embed-clips
```

脚本会拒绝任何 `moov` 不在文件头（未 faststart）的输入。

## 排错

**先看容器有没有 faststart。** 如果 mp4 的索引表 `moov` 在文件末尾，浏览器必须整段下完才能解码，中间一直黑屏；客户端有 **25 秒看门狗**，超时就自己关掉覆盖层 —— 症状就是「点开什么都没有」。

```sh
ffmpeg -i 原片.mp4 -c copy -movflags +faststart 修好的.mp4   # 无损重排容器
```

| 现象 | 原因 / 处理 |
|---|---|
| 完全没出现 | 十有八九是缓存：**Ctrl+Shift+R**；或重启一次 DSH |
| 新对话不播 | 这个会话已经播过了（每会话一次）。钉住它可变成每次都播 |
| 钉住了也不播 | 确认图钉是绿色；确认打开的就是被钉的那个会话 |
| 黑屏无画面 | 查 `moov` 是否前置；访问 `/dsh-boot-animation/status.json` 看当前片源；看浏览器控制台的解码错误 |
| 换了片没生效 | 片库里点完要有 ✓；确认文件在 `videos/` 里并点了「刷新」 |
| 播到一半自己没了 | 25 秒看门狗超时 —— 通常还是 faststart 或解码太慢 |
| 想看到插件在干什么 | 把 `src/client/index.ts` 顶部的 `DEBUG` 改成 `true` 重新构建，控制台会打印每次决策 |

## 浏览器的两条硬性策略

自动播放**带声音**、以及 Fullscreen API，**都要求用户手势**，任何网页都绕不过。所以：

1. 动画以**静音**在铺满窗口的覆盖层里自动开始（视觉上已经是全屏）
2. **点一下画面**：同时开启声音并进入**真全屏**
3. 万一连静音自动播放也被拒，会显示「点击播放」而不是黑屏

播放贴合方式（片库面板里切换，下次播放生效）：**铺满屏幕**（`object-fit: cover`，无黑边、超出裁掉，默认）或**完整显示**（`contain`，整帧都在、长宽比不匹配时留黑边）。

## 开发

```sh
npm run build          # 完整构建
npm run build:client   # 只构建客户端（先跑 CSS 模板反引号检查）
npm run check          # CSS 检查 + verify.mjs
npm run verify:browser # 用 CDP 驱动本机 Edge 做浏览器端验证
npm run embed-clips    # 重新内嵌 media/ 下的片源
```

构建产物是 `lib/`（`index.js` 宿主半区、`client.js` 浏览器半区、`clips.data.js` 内嵌片源），**已提交进仓库** —— 所以改完代码要重新构建并提交 `lib/`，安装方才能拿到新版本。

两个实现上的坑，改代码前值得知道：

- **绝对不能用静态 `inject`。** 客户端加载器把任何非 `active` 的条目当致命错误，静态 `inject` 一旦等不到服务，本插件 fiber 永远 pending，**整个 GUI 打不开**（实测事故：`web boot: 1 entry did not activate dsh-boot-animation: pending`）。两个服务都用 cordis 的动态注入 `ctx.inject([...], cb)`，等待发生在子 fiber。
- **整个 CSS 是一段模板字符串**：注释里写一个反引号就会提前结束它，而报错是 TypeScript 的 parse error 指向某行 CSS、同时 `lib/client.js` 保持不变 —— 看起来像改成功了其实没生效。`scripts/check-css-template.mjs` 专门拦这个。

## 许可

BSD-3-Clause，见 [LICENSE](LICENSE)。

上游项目：[NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation)（原作者 NativeDog1）。
