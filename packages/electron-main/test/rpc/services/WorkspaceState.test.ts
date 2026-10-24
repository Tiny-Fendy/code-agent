/**
 * WorkspaceState 测试（镜像 src/rpc/services/WorkspaceState.ts）
 *
 * 契约关注点：初始无项目、写入后服务间共享同一份路径、可被重新选择覆盖。
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceState } from '../../../src/rpc/services/WorkspaceState';

describe('WorkspaceState', () => {
  it('初始状态没有项目路径', () => {
    expect(new WorkspaceState().projectPath).toBeNull();
  });

  it('写入后读取到同一路径', () => {
    const workspace = new WorkspaceState();
    workspace.setProjectPath('/tmp/project-a');

    expect(workspace.projectPath).toBe('/tmp/project-a');
  });

  it('再次选择目录时覆盖旧路径', () => {
    const workspace = new WorkspaceState();
    workspace.setProjectPath('/tmp/project-a');
    workspace.setProjectPath('/tmp/project-b');

    expect(workspace.projectPath).toBe('/tmp/project-b');
  });
});
