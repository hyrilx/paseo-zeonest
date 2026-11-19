---
name: zeonest-git
description: 在 Zeonest 仓库进行任何源码、测试、文档、技能或维护修改时使用。开发前创建 feature/bugfix/doc/chore 任务分支，用独立 worktree 隔离并发开发；每轮有改动的对话独立提交，合并 main 时 squash 为一个提交。
---

# Zeonest Git 协作

本 skill 适用于所有仓库修改，包括其他 skill 的维护。先读仓库根目录的 `AGENTS.md`、`README.md`、`docs/architecture.md` 和 `docs/development.md`；子功能与壳的实现另按对应 skill 执行。本 skill 所在目录向上三级为仓库根目录。

## 分支与对话轮次

- 开发前按任务建立分支：新功能用 `feature/<主题>`，修复用 `bugfix/<主题>`，文档与技能用 `doc/<主题>`，工具、依赖及其他维护用 `chore/<主题>`。主题使用简短的 kebab-case；重名时加任务标识，不复用他人分支。不直接在 `main` 开发或提交。
- 同一任务的后续对话继续使用原任务分支和 worktree；新任务另建分支。已 squash 合并的任务若需后续修改，从最新 `main` 新建分支，避免重复带入旧历史。
- 一轮指一次用户请求及完成该请求所需的工具调用、进度说明和澄清。每轮有仓库改动时，在结束回复前创建恰好一个独立提交；一轮包含多个实现步骤也合为一个提交。纯讨论、只读检查或没有文件变化时不创建空提交。
- 不把多轮改动拖到最后一次提交，不用 `commit --amend` 覆盖前一轮提交，也不在任务分支提前压缩多轮历史。若本轮开始时发现未提交改动，先确认归属和所属轮次；不得混入当前提交。
- 提交标题使用 `<type>(<scope>): <说明>`，scope 可省略；分支前缀 `feature`、`bugfix`、`doc`、`chore` 分别对应提交 type `feat`、`fix`、`docs`、`chore`。正文记录必要的验证结果与阻塞。
- 本轮提交属于默认交付流程；用户明确要求暂不提交时遵从。合并、推送和删除分支/worktree 需要用户明确要求，或已有覆盖这些操作的授权；不要把“开发完成”当成这些操作的授权。

## 开始前检查与隔离

先检查现场，不改动任何文件或索引：

```bash
git status --short --branch
git diff --stat
git diff --cached --stat
git worktree list --porcelain
git branch -vv
```

记录当前分支、HEAD、已有的已暂存/未暂存/未跟踪文件，以及各 worktree 的任务归属。主工作区即使暂时干净，也可能正在被其他会话使用；默认每个任务使用仓库外的独立 worktree。

有远端时先 `git fetch origin`，检查 `main` 与 `origin/main` 的差异，选定最新且包含所需已接受提交的 main 基线，并记录其 SHA。两者分叉、离线或无法确认基线时说明情况，不用 `pull`、reset 或强推自动消除差异。不要为了更新基线去切换或移动他人占用的 `main`。

以下为新任务示例，分支名、绝对路径和基线 SHA 必须替换为实际值：

```bash
git worktree add -b doc/git-workflow /absolute/path/to/worktrees/doc-git-workflow <main基线SHA>
git -C /absolute/path/to/worktrees/doc-git-workflow status --short --branch
```

- 创建前确认分支与路径均未被占用；Git 拒绝时先查明原因，不用 `--force` 或 `--ignore-other-worktrees` 绕过同一分支的 checkout 保护。继续已有任务前也须确认该 worktree 无其他写入者。
- 后续读写文件、安装依赖、测试、构建和提交全部针对自己的 worktree；使用明确的绝对路径、`git -C` 或显式切换命令目录，不依赖工具默认 cwd。各 worktree 独立安装依赖并生成产物，不共用可写的 node_modules、bundle 或临时配置。
- linked worktree 各自拥有工作文件、索引和 HEAD，但共享对象、分支引用、远端引用、stash 和仓库级配置。不要在一个 worktree 中移动他人使用的分支、清理共享 stash，或擅自修改 hooksPath 等公共配置。
- 不在共享主工作区运行 `git switch`、`checkout`、`pull`、`stash` 或全量暂存来“腾出位置”。已有未提交内容留在原处，不拷贝进新 worktree；确需依赖另一任务时先协调提交和接入方式。

## 每轮开发与提交

1. 在自己的 worktree 核对分支、HEAD 和工作区状态，确定本轮改动范围。读取相关文件后实施修改，保持其他任务的内容不动。
2. 在同一 worktree 运行 `npm run check` 和 `npm pack --dry-run --ignore-scripts`，并按改动执行主动 LSP、UI 等专项验证。新 worktree 缺依赖时按仓库规范独立安装，不借用主工作区的安装或构建结果。记录验证对应的基线与改动状态。
3. 提交前检查 `git diff --check`、完整 diff 和未跟踪文件。只用显式文件路径 `git add -- <本轮文件...>`，不使用 `git add .`、`git add -A` 或 `git commit -a`。发现不属于本轮的已暂存内容时先停下确认，不擅自取消暂存；同文件有他人改动时协调所有权或精确选择本轮 hunks，不整文件夹带提交。
4. 检查 `git diff --cached --check`、`git diff --cached --stat` 和完整 staged diff，再创建本轮唯一提交。留意 pre-commit hook 可能按暂存元数据更新 README 功能目录；不得绕过 hook 掩盖失败，也不夹带 README 手写区的其他修改。
5. 提交后用 `git show --stat --oneline HEAD`、`git show --format= --name-only HEAD` 和 `git status --short --branch` 核实实际文件与剩余改动。发现意外改动时停止后续合并/推送并报告，不用 reset 或 amend 掩盖。
6. 本轮引入的检查失败先修复，再提交。受外部条件或既有问题阻塞、确需结束本轮时，仍可在任务分支保留一个提交，但须在提交正文及回复中写明 WIP、失败原因和未完成项；不得标成验证通过或合入 `main`。

交付回复包含任务分支、worktree 路径、当前轮提交 SHA、验证结果，以及是否已合并/推送。没有提交时说明具体原因。

## 合并 main：一个任务保留一个节点

任务分支保留逐轮提交；用户授权合并且必要验证通过后，把该任务全部改动以一个 squash 提交纳入最新 `main`。不使用普通 merge、`--no-ff` 或逐个 cherry-pick 将每轮提交带入 main。

主工作区可能正在并发开发。优先在独立集成 worktree 中准备 squash，避免直接在共享主工作区生成暂存改动：

1. 获取最新远端引用并检查 main 基线，固定本次任务的 tip SHA；核对基线到任务 tip 的提交和 diff，确认只包含此任务。多个任务串行集成，每个任务对应一个 squash 提交。
2. 从该 main 基线创建唯一的临时集成分支及 worktree。不要强制在第二个 worktree checkout 已被占用的 `main`。
3. 在集成 worktree 执行 `git merge --squash <任务tipSHA>`。冲突只在该 worktree 中按实际语义解决，保留双方需要的行为；不机械使用 `ours`/`theirs` 覆盖另一任务。squash 冲突不产生普通 merge 的 MERGE_HEAD，不依赖 `git merge --abort` 恢复；遇阻保留现场并报告。
4. 审查 squash 暂存内容，执行完整验证，提交一次，正文概括任务及验证结果。确认 `git rev-list --count <main基线SHA>..HEAD` 为 `1`，且该提交的唯一父节点是选定的 main 基线。`merge --squash` 本身不会生成提交，仍须显式 `git commit`。
5. 与 main 工作区所有者协调独占的合并窗口，确认该工作区当前在 `main`，且已暂存、未暂存和未跟踪状态均干净。读取一次干净状态不能代替协调。在该窗口内以 `git merge --ff-only <集成提交SHA>` 推进 main；这是快进到已验证的单个 squash 提交，不增加 merge 节点。
6. main 在准备期间前进导致无法快进时，停止并基于新 main 重建集成候选、重新解决冲突和验证。不 reset main、不强推，也不追加普通 merge 来绕过单节点要求。

main 工作区有并发改动或无法获得独占窗口时，保留任务分支/集成候选并报告待合并，不 stash、提交或清理他人的内容。若仓库使用 PR 且用户已授权，可改走服务端 squash merge；按最新目标分支重新验证，遵守分支保护，不另做一次本地 squash。

推送前再次检查远端状态，仅在授权范围内普通推送；远端前进或拒绝时重新获取并集成，不使用 `--force` 或 `--force-with-lease` 覆盖共享历史。确认本地合并与远端推送结果，分别报告，不能把其中一个当成另一个完成。

## 并发保护与收尾

- Git 的索引锁只保护单次 Git 写入，不给整个开发或合并流程加互斥。不要删除他人可能持有的 `.git/index.lock`，也不要用共享工作区的“先检查再修改”代替独立 worktree 和必要的协调。
- 不执行会丢失他人内容的 `reset --hard`、`clean -fd`、批量 restore、强制 checkout 或强制删除 worktree。撤销自己的改动也须确认具体路径和归属；不要清空整个仓库或暂存区。
- 收尾仅在获授权后移除自己创建且已干净的 worktree，使用 `git worktree remove <路径>`，不强制删除其他会话的工作区。
- squash 后任务 tip 通常不是 main 的祖先，`git branch -d` 因而可能拒绝；这不代表未集成。先核对 squash 提交、最终 diff 和验证记录，再按授权清理自己的任务/集成分支；不要直接用 `-D` 绕过检查。未确认集成或尚有未提交内容时保留现场。
