/**
 * 工作区状态（主进程内存态）
 *
 * 在服务之间共享当前打开的项目路径：
 * FileService.openFolderDialog 写入，ChatService.send 读取。
 */
export class WorkspaceState {
  private _projectPath: string | null = null;

  get projectPath(): string | null {
    return this._projectPath;
  }

  setProjectPath(projectPath: string): void {
    this._projectPath = projectPath;
  }
}
