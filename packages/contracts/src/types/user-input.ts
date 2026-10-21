/**
 * 用户交互相关共享类型
 *
 * Agent 在执行中途需要用户决策时（ask_user 工具），
 * 通过宿主注入的回调把请求转发给 UI，并等待用户作答。
 */

/** 用户输入选项 */
export interface UserInputOption {
  /** 选项文本（回填的唯一标识） */
  label: string;
  /** 选项说明（UI 展示用，可选） */
  description?: string;
}

/** 一次用户输入请求 */
export interface UserInputRequest {
  /** 问题（非空） */
  question: string;
  /** 选项；省略或空数组表示自由文本输入 */
  options?: UserInputOption[];
  /** 是否允许多选（仅 options 存在时有效，默认 false） */
  allowMultiple?: boolean;
}

/** 用户回答 */
export interface UserInputResponse {
  /** 选中的选项 label（有 options 时使用） */
  selected?: string[];
  /** 自由输入 / 自定义补充文本 */
  text?: string;
}

/**
 * 用户输入回调
 *
 * 宿主环境实现：把请求转发给 UI 并等待用户作答。
 * 超时与取消由宿主负责（超时可 resolve 空回答，工具据此返回错误观察）。
 */
export type UserInputCallback = (request: UserInputRequest) => Promise<UserInputResponse>;
