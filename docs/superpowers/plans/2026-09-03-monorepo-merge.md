# 双仓整合 git monorepo（subtree 全保留） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `pi/`（插件包仓，`hilariouhiss/pi-pinel.git`）与 `vscode/`（扩展仓，`hilariouhiss/pinel.git`）两个独立 git 仓整合为一个 monorepo：根下 `vscode/` + `pi/` 双子目录，双方**全部历史原 SHA 保留**（`git subtree add`，不重写、不 force push），monorepo 快进推送到现有 `pinel.git`，`pi-pinel.git` 存档。

**Architecture:** `git subtree add --prefix=<dir> <repo> main` 把源仓历史作为合并提交的祖先挂进新仓——`log --follow`/`blame` 完好、源仓所有 SHA 可达、对 `pinel.git` 而言新 main 是其旧 main 的后代（**快进推送，零 force**）。双子目录布局下，vscode 工具链所有 `../pi` 相对引用（check-plugin、AGENTS.md、发布流程）**零改动**——命令仍从 `vscode/` 目录内执行。构建在临时目录完成并全量验证后再换位到 `c:/source_code/Other/pinel` 根，旧仓目录保留为备份直到验收通过。

**Tech Stack:** 纯 git 内置能力（`subtree` 已验证本机可用）；GitHub Actions 迁根（working-directory + paths 过滤）；零代码改动、零新依赖。

**Spec:** 本会话用户需求，经澄清确认四项决策：① 历史 = **subtree 全保留**（不重写 SHA）；② 布局 = **双子目录** `vscode/` + `pi/`；③ 远端 = **复用 `hilariouhiss/pinel.git`**（`pi-pinel.git` 存档）；④ CI = **迁根 + working-directory + paths 过滤**。

## 现状基线（2026-09-03 实测）

| | pi 仓 | vscode 仓 |
|---|---|---|
| 路径 | `c:/source_code/Other/pinel/pi` | `c:/source_code/Other/pinel/vscode` |
| 远端 | `git@github.com:hilariouhiss/pi-pinel.git` | `git@github.com:hilariouhiss/pinel.git` |
| main | 37 commits，与 origin 同步 | 249 commits，**领先 origin/main 33 个未推送** |
| tags | v0.1.0、v0.1.1（**v0.1.0 与 vscode 撞名**） | v0.1.0、v0.1.2、v0.1.4 |
| CI | 无 | `.github/workflows/ci.yml`（windows+ubuntu matrix：npm ci → compile → xvfb npm test） |
| 工作区 | 干净 | 干净 |

其他：根目录另有杂散 `node_modules/`（无仓管辖，删）；`vscode/.worktrees/`、`.vscode-test/`（gitignored，换位后失效需重建/重拷）；pi/package.json 无 `repository` 字段（无需改）；`git subtree` 本机可用。

## Global Constraints

- **禁止 force push、禁止改写既有 SHA**：monorepo main 必须包含 `pinel.git` 现有 `origin/main` 为祖先（推送前显式校验）。
- 旧仓目录（含 `.git`）作为备份**保留至验收通过后**才删除；所有破坏性步骤（换位、删除）前必须有前置验证步骤。
- tags 撞名处理：vscode tags 原样保留（SHA 未变仍有效）；pi tags 显式前缀化为 `pi/v0.1.x`，**不得** `git fetch --tags` 从 pi 拉取（会与 vscode v0.1.0 冲突）。
- 零代码改动：不改任何 `src/`/`webview-ui/`/`pinel.ts` 内容；唯一文本改动 = 根脚手架（README/.gitignore/CI）+ `vscode/AGENTS.md` 结构描述措辞 + 删除 `vscode/.github/workflows/ci.yml`（已迁根）。
- 提交信息中文；每个任务独立可验证。
- 本计划文档先提交进 vscode 仓（随 subtree 历史进入 monorepo）。

## File Structure（monorepo 目标形态）

```
pinel/                        # monorepo 根（= pinel.git 新 main）
├─ .github/workflows/ci.yml   # 新增：CI 迁根（working-directory: vscode + paths 过滤）
├─ .gitignore                 # 新增：根级最小（node_modules/）
├─ README.md                  # 新增：布局图与两子项目说明
├─ vscode/                    # 原 vscode 仓完整历史与树（.github/workflows/ci.yml 已删）
└─ pi/                        # 原 pi 仓完整历史与树
```

临时构建目录：`c:/source_code/Other/pinel/.mono-build/`（构建期工作区，换位后删除）。

---

### Task 1: 前置校验与远端备份推送

**Files:** 无文件改动（纯 git 操作）

**Interfaces:**
- Produces: 两仓工作区干净且与各自 origin 同步（后续 subtree 源状态确定）；33 个未推送提交落远端（安全网）

- [ ] **Step 1: 校验两仓干净 + subtree 可用**

```bash
git -C pi status --short && git -C vscode status --short   # 两者均应无输出
git subtree -h                                              # 应打印用法（已预检通过，复核）
```

Expected: 无未提交改动；subtree 可用。若有改动 → 停止，先处理。

- [ ] **Step 2: 推送 vscode 领先的 33 个提交**

```bash
cd vscode && git push origin main
```

Expected: 成功；`git status -sb` 首行变为 `## main...origin/main`（无 ahead/behind）。

- [ ] **Step 3: 复核 pi 与 origin 同步**

```bash
git -C pi fetch origin && git -C pi status -sb   # 应为 ## main...origin/main
```

---

### Task 2: 临时目录构建 monorepo（init + 根脚手架 + 双 subtree add）

**Files:**
- Create: `.mono-build/`（临时 git 仓）、其中 `.gitignore`、`README.md`

**Interfaces:**
- Consumes: `../vscode`（249 commits）、`../pi`（37 commits）两仓 main
- Produces: monorepo main = 根脚手架提交 → merge(vscode/main) → merge(pi/main)；两子目录树与源仓逐字节一致（Step 5 tree-id 校验）

- [ ] **Step 1: 初始化临时仓 + 根脚手架提交**

```bash
cd /c/source_code/Other/pinel
mkdir .mono-build && cd .mono-build
git init -b main
```

创建 `.gitignore`：

```gitignore
# 根级最小：子项目各自的 .gitignore 管辖其余产物
node_modules/
```

创建 `README.md`：

```markdown
# Pinel monorepo

Pinel —— 为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供 VS Code 图形聊天面板。

## 布局

- `vscode/` —— VS Code 扩展（发布 ID `hilariouhiss.pinel`）。开发：`cd vscode && npm install && npm run compile && npm test`（详见 `vscode/AGENTS.md`）。
- `pi/` —— Pinel Pi 插件包（npm 包 `@hilariouhiss/pinel`，`pi install` 安装；独立发布：`cd pi && npm publish`）。

两子项目工具链互引（`vscode/` 内命令以 `../pi` 相对路径引用插件源），构建/测试/发布均在各自目录内进行。
本仓由两个独立仓库经 `git subtree` 整合而成，双方完整历史保留（`git log --follow` 可溯源）。
```

提交：

```bash
git add .gitignore README.md && git commit -m "chore: monorepo 根脚手架（布局说明 + 根级 gitignore）"
```

- [ ] **Step 2: subtree 并入 vscode 仓**

```bash
git remote add vscode ../vscode
git fetch vscode --no-tags
git subtree add --prefix=vscode vscode main
```

Expected: 生成合并提交，`vscode/` 子目录树就位，工作区干净。

- [ ] **Step 3: subtree 并入 pi 仓**

```bash
git remote add pi ../pi
git fetch pi --no-tags
git subtree add --prefix=pi pi main
```

- [ ] **Step 4: 历史规模校验**

```bash
git log --oneline | wc -l        # 期望 249 + 37 + 3 = 289（vscode 249、pi 37、根脚手架+2 个 subtree 合并提交）
git log --oneline --follow -- vscode/src/chat/session-history.ts | wc -l   # >0：vscode 深历史可达
git log --oneline --follow -- pi/pinel.ts | wc -l                            # >0：pi 深历史可达
```

- [ ] **Step 5: 子树与源仓逐字节一致性校验（tree-id 强校验）**

```bash
# subtree split 重建的 tree 必须与源仓 main 的 tree 同一 SHA
git subtree split --prefix=vscode | tail -1   # 记输出 A；校验 git rev-parse A^{tree} == git rev-parse vscode/main^{tree}
git rev-parse "vscode/main^{tree}"
git subtree split --prefix=pi | tail -1       # 同法与 pi/main^{tree} 比对
git rev-parse "pi/main^{tree}"
```

Expected: 两组 tree-id 各自相等（不相等 → 停止排查，不得继续）。

---

### Task 3: tags 前缀化 + CI 迁根 + 文档收尾

**Files:**
- Create: `.mono-build/.github/workflows/ci.yml`
- Delete: `.mono-build/vscode/.github/workflows/ci.yml`（迁根；空目录 `.github/workflows` 一并移除）
- Modify: `.mono-build/vscode/AGENTS.md`（`../pi/` 结构行措辞：sibling 独立仓 → monorepo 兄弟目录）

**Interfaces:**
- Consumes: Task 2 的 monorepo main
- Produces: tags `v0.1.0/v0.1.2/v0.1.4`（vscode，原 SHA）+ `pi/v0.1.0`、`pi/v0.1.1`；根 CI workflow

- [ ] **Step 1: vscode tags 原样拉取 + pi tags 前缀化**

```bash
git fetch vscode "+refs/tags/*:refs/tags/*"          # v0.1.0 v0.1.2 v0.1.4（SHA 未变仍指 vscode 历史）
git fetch pi "refs/tags/v0.1.0:refs/tags/pi/v0.1.0"  # 显式前缀，避免与 vscode v0.1.0 撞名
git fetch pi "refs/tags/v0.1.1:refs/tags/pi/v0.1.1"
git tag -l    # 复核：v0.1.0 v0.1.2 v0.1.4 pi/v0.1.0 pi/v0.1.1，无覆盖
```

- [ ] **Step 2: 根 CI workflow**

创建 `.github/workflows/ci.yml`（原 `vscode/.github/workflows/ci.yml` 迁根：加 `defaults.run.working-directory`、npm cache 依赖路径、paths 过滤；xvfb action 不认 defaults，单独传 `working-directory`）：

```yaml
name: CI

on:
  push:
    branches: [main]
    paths: [vscode/**, .github/workflows/ci.yml]
  pull_request:
    branches: [main]
    paths: [vscode/**, .github/workflows/ci.yml]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: vscode
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: vscode/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Compile (type-check + lint + bundle)
        run: npm run compile

      - name: Run tests (unit + integration)
        uses: coactions/setup-xvfb@v1
        with:
          run: npm test
          working-directory: vscode
```

- [ ] **Step 3: 删除 vscode 子目录旧 workflow + AGENTS.md 措辞**

```bash
git rm vscode/.github/workflows/ci.yml
rmdir vscode/.github/workflows 2>/dev/null; rmdir vscode/.github 2>/dev/null   # 目录空则移除（git 不跟踪空目录）
```

`vscode/AGENTS.md` 结构树中 `├─ ../pi/  # Pinel Pi 插件包（sibling 目录，npm 包 …）` 一行改为：

```
├─ ../pi/                 # Pinel Pi 插件包（monorepo 兄弟目录，npm 包 @hilariouhiss/pinel，pi install 安装；独立 tsc 检查不随主 bundle；发布：cd ../pi && npm publish）
```

提交：

```bash
git add -A && git commit -m "chore: CI 迁根（working-directory + paths 过滤）+ pi tags 前缀化 + AGENTS.md monorepo 措辞"
```

---

### Task 4: 快进推送 pinel.git + 存档 pi-pinel.git

**Files:** 无本地文件改动

**Interfaces:**
- Consumes: Task 3 完成的 monorepo main + tags
- Produces: `pinel.git` main = monorepo main（快进）；`pi-pinel.git` 归档

- [ ] **Step 1: 祖先校验（强制门：不等则停）**

```bash
git remote add origin git@github.com:hilariouhiss/pinel.git
git fetch origin --no-tags
git merge-base --is-ancestor origin/main main && echo "FF-OK"   # 必须输出 FF-OK
```

Expected: `FF-OK`。否则**停止**（说明远端有新提交，需人工评估，严禁 force）。

- [ ] **Step 2: 推送 main 与 tags**

```bash
git push -u origin main
git push origin --tags
```

- [ ] **Step 3: 存档 pi-pinel.git**

若本机有 gh CLI：`gh repo archive hilariouhiss/pi-pinel --yes`；否则人工步骤：GitHub → hilariouhiss/pi-pinel → Settings → Archive this repository（只读存档，历史与 npm 发布溯源不受影响）。

---

### Task 5: 本地工作区换位与全量验收

**Files:**
- 重排：`c:/source_code/Other/pinel/` 根（临时仓内容上位；`pi`→`pi-old`、`vscode`→`vscode-old` 备份；删根杂散 `node_modules/`；删 `.mono-build`）

**Interfaces:**
- Consumes: Task 4 已推送的 monorepo；`vscode-old/` 内 `node_modules/`、`.vscode-test/`、`dist/`、`out/`、`.worktrees/`（gitignored 资产，拷贝复用免重下）
- Produces: 根 = monorepo 工作区，双项目构建/测试全绿

- [ ] **Step 1: 换位（root: pi→pi-old, vscode→vscode-old, .mono-build 内容上位）**

```bash
cd /c/source_code/Other/pinel
rm -rf node_modules                 # 根杂散（无仓管辖）
mv pi pi-old && mv vscode vscode-old
mv .mono-build/.git .git            # 临时仓上位为根仓
mv .mono-build/vscode .mono-build/pi .mono-build/README.md .mono-build/.gitignore .mono-build/.github .
rmdir .mono-build
```

- [ ] **Step 2: 依赖与缓存资产拷贝（免重下 100MB VS Code 测试宿主）**

```bash
# Windows（robocopy //E 只增不删——防旧目录 tracked 旧版覆盖新树；/NFL /NDL 静默；robocopy 成功退出码非零，故 ; true 壳底）
for d in node_modules .vscode-test dist out media; do [ -d "vscode-old/$d" ] && robocopy "vscode-old/$d" "vscode/$d" //E //NFL //NDL //R:1 //W:1; done; true
[ -d pi-old/node_modules ] && robocopy pi-old/node_modules pi/node_modules //E //NFL //NDL //R:1 //W:1; true
git status --short    # 应干净（以上均为 gitignored 路径）
```

注：`.worktrees/` 不拷（引用旧仓路径，全部失效；后续如需 worktree 重新创建）。

- [ ] **Step 3: vscode 全量验收**

```bash
cd vscode && npm run compile && npm test
```

Expected: compile 全绿；测试主套件 + 空窗口套件全过（数量 ≥ 366）。

- [ ] **Step 4: pi 验收**

```bash
cd ../pi && npm install && npx vitest run
```

Expected: vitest 全过（与旧仓相同用例集）。

- [ ] **Step 5: 收尾确认与备份清理（需用户点头）**

验收全绿后向用户报告并确认，然后：

```bash
cd /c/source_code/Other/pinel
rm -rf pi-old vscode-old
```

（保守替代：改名保留 `*-old` 一周再删。）

---

## 已知边界（挂账）

- monorepo 根暂不引入 npm/pnpm workspaces：pi 包独立发布（peerDeps + `pi install` 安装语义），workspace 化会改发布产物结构，收益不配成本。
- pi 子目录无独立 CI（现状即无）；若未来需要，在根 workflows 加 `pi.yml` + `paths: [pi/**]`。
- `pi-pinel.git` 的 npm provenance/溯源链不变（npm 包元数据与 git 仓解耦）；pi/package.json 无 repository 字段，未补（补了会改 npm 页面源链接，留给用户决定）。
- GitHub 上 pinel.git 的旧 Releases 关联旧 tag SHA——tag 已随历史保留，链接不断。
